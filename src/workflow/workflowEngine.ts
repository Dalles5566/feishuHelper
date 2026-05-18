/**
 * Workflow Engine implementation.
 *
 * Orchestrates the task lifecycle by mapping business events to state
 * transitions. Sits on top of the state machine (stateMachine.ts) and
 * provides higher-level operations: starting workflows from meeting
 * analysis, advancing tasks based on events, and reverting tasks when
 * meeting updates invalidate prior work.
 *
 * Requirements: 9.1, 9.5, 9.6
 */

import pg from 'pg';
import type { TaskState } from '../models/task.js';
import type { MeetingAnalysis } from '../models/meeting.js';
import type { WorkflowEvent, WorkflowStatus, StateTransition } from '../models/workflow.js';
import { transition } from './stateMachine.js';
import { insert, query } from '../utils/db.js';
import { AppError, StateErrorCodes } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// Event-to-state mapping
// ---------------------------------------------------------------------------

/**
 * Determines the target state for a given workflow event type and payload.
 * Returns null if the event cannot be mapped to a valid target state.
 */
function resolveTargetState(event: WorkflowEvent): TaskState | null {
  switch (event.type) {
    case 'assignment':
      return 'Assigned';
    case 'dev_complete':
      return 'VerificationPending';
    case 'verification_result':
      return event.payload['passed'] === true ? 'VerificationPassed' : 'VerificationFailed';
    case 'qa_result':
      return event.payload['passed'] === true ? 'QAPassed' : 'QAFailed';
    case 'doc_updated':
      return 'DocumentationUpdated';
    case 'meeting_update':
      // Meeting updates are handled separately via revert logic
      return 'Created';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Task row type for DB queries
// ---------------------------------------------------------------------------

interface TaskRow extends Record<string, unknown> {
  id: string;
  state: string;
}

interface InsertedTaskRow extends Record<string, unknown> {
  id: string;
}

interface WorkflowLogRow extends Record<string, unknown> {
  from_state: string;
  to_state: string;
  trigger: string;
  actor: string;
  timestamp: string;
  reason: string | null;
}

interface TaskStatusRow extends Record<string, unknown> {
  id: string;
  state: string;
  retry_count: number;
  failure_context: string | null;
}

// ---------------------------------------------------------------------------
// startWorkflow
// ---------------------------------------------------------------------------

/**
 * Start a workflow from a meeting analysis result.
 *
 * Creates a task for each action item in the analysis and returns the
 * meeting ID used to group the created tasks.
 */
export async function startWorkflow(
  meetingAnalysis: MeetingAnalysis,
  meetingId: string,
  _actor: string,
  pool?: pg.Pool,
): Promise<string> {
  if (!meetingAnalysis.actionItems || meetingAnalysis.actionItems.length === 0) {
    throw AppError.validation(
      'VALIDATION_EMPTY_CONTENT',
      'Meeting analysis contains no action items',
      { meetingId },
      'Ensure the meeting analysis produces at least one action item.',
    );
  }

  for (const item of meetingAnalysis.actionItems) {
    await insert<InsertedTaskRow>(
      `INSERT INTO tasks
         (title, description, dependencies, priority, state, meeting_id, source_action_item_id, retry_count, description_history, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'Created', $5, $6, 0, '[]', NOW(), NOW())
       RETURNING id`,
      [
        item.description.slice(0, 100), // title derived from description
        item.description,
        JSON.stringify(item.dependencies),
        item.priority,
        meetingId,
        item.id,
      ],
      pool,
    );
  }

  return meetingId;
}

// ---------------------------------------------------------------------------
// advanceWorkflow
// ---------------------------------------------------------------------------

/**
 * Advance a task's workflow based on a business event.
 *
 * Maps the event type to the appropriate target state and delegates to
 * the state machine's `transition()` function.
 */
export async function advanceWorkflow(
  taskId: string,
  event: WorkflowEvent,
  pool?: pg.Pool,
): Promise<void> {
  const targetState = resolveTargetState(event);

  if (targetState === null) {
    throw AppError.validation(
      'VALIDATION_INVALID_FORMAT',
      `Unknown workflow event type: ${event.type}`,
      { taskId, eventType: event.type },
      'Use a valid event type: assignment, dev_complete, verification_result, qa_result, doc_updated, meeting_update.',
    );
  }

  // For meeting_update events, use the dedicated revert logic
  if (event.type === 'meeting_update') {
    await handleMeetingUpdate(taskId, event, pool);
    return;
  }

  await transition(taskId, targetState, {
    trigger: event.type,
    actor: event.actor,
    reason: (event.payload['reason'] as string) ?? undefined,
    metadata: event.payload,
  }, pool);
}

// ---------------------------------------------------------------------------
// revertWorkflow
// ---------------------------------------------------------------------------

/**
 * Revert a task to a specified target state with a reason.
 *
 * Validates that the revert is a legal transition before executing.
 */
export async function revertWorkflow(
  taskId: string,
  targetState: TaskState,
  reason: string,
  actor: string,
  pool?: pg.Pool,
): Promise<void> {
  await transition(taskId, targetState, {
    trigger: 'revert',
    actor,
    reason,
  }, pool);
}

// ---------------------------------------------------------------------------
// handleMeetingUpdate
// ---------------------------------------------------------------------------

/**
 * Handle a meeting update event for a specific task.
 *
 * If the task is in any state beyond Created, it is reverted to Created.
 * Tasks already in Created state receive a self-transition (Created → Created)
 * to record the meeting update in the log.
 */
async function handleMeetingUpdate(
  taskId: string,
  event: WorkflowEvent,
  pool?: pg.Pool,
): Promise<void> {
  const reason = (event.payload['reason'] as string) ?? 'Meeting update changed requirements';

  await transition(taskId, 'Created', {
    trigger: 'meeting_update',
    actor: event.actor,
    reason,
    metadata: event.payload,
  }, pool);
}

// ---------------------------------------------------------------------------
// handleMeetingUpdateForAllTasks
// ---------------------------------------------------------------------------

/**
 * Handle a meeting update that affects multiple tasks.
 *
 * Finds all tasks associated with the given meeting that are beyond the
 * Created state and reverts them to Created. Tasks already in Created
 * state are left unchanged.
 */
export async function handleMeetingUpdateForAllTasks(
  meetingId: string,
  event: WorkflowEvent,
  pool?: pg.Pool,
): Promise<string[]> {
  const reason = (event.payload['reason'] as string) ?? 'Meeting update changed requirements';

  // Find all tasks for this meeting that are beyond Created
  const result = await query<TaskRow>(
    `SELECT id, state FROM tasks WHERE meeting_id = $1 AND state != 'Created'`,
    [meetingId],
    pool,
  );

  const revertedTaskIds: string[] = [];

  for (const task of result.rows) {
    await transition(task.id, 'Created', {
      trigger: 'meeting_update',
      actor: event.actor,
      reason,
      metadata: event.payload,
    }, pool);
    revertedTaskIds.push(task.id);
  }

  return revertedTaskIds;
}

// ---------------------------------------------------------------------------
// getWorkflowStatus
// ---------------------------------------------------------------------------

/**
 * Retrieve the current workflow status for a task, including transition history.
 */
export async function getWorkflowStatus(
  taskId: string,
  pool?: pg.Pool,
): Promise<WorkflowStatus> {
  // Get current task state
  const taskResult = await query<TaskStatusRow>(
    `SELECT id, state, retry_count, failure_context FROM tasks WHERE id = $1`,
    [taskId],
    pool,
  );

  if (taskResult.rows.length === 0) {
    throw AppError.stateTransition(
      StateErrorCodes.TASK_NOT_FOUND,
      `Task ${taskId} not found`,
      { taskId },
      'Verify the task ID is correct.',
    );
  }

  const task = taskResult.rows[0];

  // Get transition history
  const logResult = await query<WorkflowLogRow>(
    `SELECT from_state, to_state, trigger, actor, timestamp, reason
       FROM workflow_logs
      WHERE task_id = $1
      ORDER BY timestamp ASC`,
    [taskId],
    pool,
  );

  const history: StateTransition[] = logResult.rows.map((row) => ({
    fromState: row.from_state as TaskState,
    toState: row.to_state as TaskState,
    trigger: row.trigger,
    actor: row.actor,
    timestamp: row.timestamp,
    reason: row.reason ?? undefined,
  }));

  return {
    taskId,
    currentState: task.state as TaskState,
    history,
    retryCount: task.retry_count,
    failureContext: task.failure_context ?? undefined,
  };
}
