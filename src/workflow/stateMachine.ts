/**
 * Task workflow state machine.
 *
 * Defines the valid state transitions for the task lifecycle, provides
 * transition validation, and persists state changes with optimistic locking
 * and audit logging.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4
 */

import pg from 'pg';
import type { TaskState } from '../models/task.js';
import type { TransitionContext } from '../models/workflow.js';
import { AppError, StateErrorCodes } from '../utils/errors.js';
import { clientQuery, withTransaction } from '../utils/db.js';

// ---------------------------------------------------------------------------
// Valid Transition Table
// ---------------------------------------------------------------------------

/**
 * Set of valid (fromState, toState) pairs encoded as "FROM->TO" strings.
 * Any pair not in this set is an illegal transition.
 */
const VALID_TRANSITIONS: ReadonlySet<string> = new Set([
  // Normal forward flow
  'Created->Assigned',
  'Assigned->InDevelopment',
  'InDevelopment->VerificationPending',
  'VerificationPending->VerificationPassed',
  'VerificationPending->VerificationFailed',
  'VerificationFailed->InDevelopment',
  'VerificationPassed->QAPending',
  'QAPending->QAPassed',
  'QAPending->QAFailed',
  'QAFailed->InDevelopment',
  'QAPassed->DocumentationUpdated',
  'DocumentationUpdated->Completed',

  // Failure / meeting-update reverts back to Created
  'Assigned->Created',
  'InDevelopment->Created',
  'VerificationFailed->Created',
  'QAFailed->Created',

  // Self-transition: meeting update re-triggers Created tasks
  'Created->Created',
]);

/**
 * States that represent a failure revert — when a task transitions TO one of
 * these states, the retry counter must be incremented.
 *
 * Note: transitioning to Created is only a failure revert when the source
 * state is beyond Created (i.e. it is a regression, not the initial creation).
 * The `transition()` function handles this distinction.
 */
const FAILURE_DESTINATION_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'VerificationFailed',
  'QAFailed',
]);

// ---------------------------------------------------------------------------
// validateTransition
// ---------------------------------------------------------------------------

/**
 * Return true if transitioning from `fromState` to `toState` is permitted by
 * the state machine definition.
 *
 * This is a pure function — it does not touch the database.
 */
export function validateTransition(fromState: TaskState, toState: TaskState): boolean {
  return VALID_TRANSITIONS.has(`${fromState}->${toState}`);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether a transition should increment the retry counter.
 *
 * Increments when:
 *  - The destination is VerificationFailed or QAFailed (explicit failure states)
 *  - The destination is Created AND the source is any state beyond Created
 *    (i.e. a regression caused by a meeting update or requirement error)
 */
function shouldIncrementRetry(fromState: TaskState, toState: TaskState): boolean {
  if (FAILURE_DESTINATION_STATES.has(toState)) {
    return true;
  }
  if (toState === 'Created' && fromState !== 'Created') {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Row types for DB queries
// ---------------------------------------------------------------------------

interface TaskRow extends Record<string, unknown> {
  id: string;
  state: string;
  retry_count: number;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// transition
// ---------------------------------------------------------------------------

/**
 * Attempt to transition task `taskId` to `toState`.
 *
 * Uses an optimistic lock based on `updated_at`: the UPDATE only succeeds if
 * the row's `updated_at` matches the value read at the start of the
 * transaction. If another process modified the row concurrently the function
 * throws a `STATE_CONCURRENT_MODIFICATION` error.
 *
 * On success:
 *  - Updates `tasks.state`, `tasks.updated_at` (and `tasks.retry_count` /
 *    `tasks.failure_context` when applicable).
 *  - Inserts a row into `workflow_logs`.
 *
 * Returns `true` on success, throws `AppError` on any failure.
 */
export async function transition(
  taskId: string,
  toState: TaskState,
  context: TransitionContext,
  pool?: pg.Pool,
): Promise<boolean> {
  return withTransaction(async (client) => {
    // 1. Read current task state (lock the row for the duration of the tx)
    const taskResult = await clientQuery<TaskRow>(
      client,
      `SELECT id, state, retry_count, updated_at
         FROM tasks
        WHERE id = $1
        FOR UPDATE`,
      [taskId],
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
    const fromState = task.state as TaskState;
    const currentUpdatedAt = task.updated_at;

    // 2. Validate the transition
    if (!validateTransition(fromState, toState)) {
      throw AppError.stateTransition(
        StateErrorCodes.INVALID_TRANSITION,
        `Invalid transition: ${fromState} → ${toState}`,
        { taskId, fromState, toState },
        `Valid transitions from '${fromState}' are: ${getValidNextStates(fromState).join(', ') || 'none'}.`,
      );
    }

    // 3. Compute retry counter and failure context updates
    const incrementRetry = shouldIncrementRetry(fromState, toState);
    const newRetryCount = incrementRetry ? task.retry_count + 1 : task.retry_count;
    const failureContext =
      incrementRetry && context.reason ? context.reason : null;

    // 4. Update the task row with optimistic lock check
    //    We re-check updated_at to detect concurrent modifications.
    const updateResult = await clientQuery<{ id: string }>(
      client,
      `UPDATE tasks
          SET state          = $1,
              retry_count    = $2,
              failure_context = COALESCE($3, failure_context),
              updated_at     = NOW()
        WHERE id         = $4
          AND updated_at = $5
        RETURNING id`,
      [toState, newRetryCount, failureContext, taskId, currentUpdatedAt],
    );

    if (updateResult.rows.length === 0) {
      // Row was modified between our SELECT and UPDATE
      throw AppError.stateTransition(
        StateErrorCodes.CONCURRENT_MODIFICATION,
        `Task ${taskId} was modified concurrently; transition aborted`,
        { taskId, fromState, toState },
        'Retry the operation.',
      );
    }

    // 5. Write the workflow log entry
    const metadata = context.metadata ?? null;
    await clientQuery<Record<string, unknown>>(
      client,
      `INSERT INTO workflow_logs
         (task_id, from_state, to_state, trigger, actor, reason, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        taskId,
        fromState,
        toState,
        context.trigger,
        context.actor,
        context.reason ?? null,
        metadata ? JSON.stringify(metadata) : null,
      ],
    );

    return true;
  }, pool);
}

// ---------------------------------------------------------------------------
// Utility: list valid next states
// ---------------------------------------------------------------------------

/**
 * Return all states that `fromState` can legally transition to.
 * Useful for building error messages and UI hints.
 */
export function getValidNextStates(fromState: TaskState): TaskState[] {
  const prefix = `${fromState}->`;
  const results: TaskState[] = [];
  for (const key of VALID_TRANSITIONS) {
    if (key.startsWith(prefix)) {
      results.push(key.slice(prefix.length) as TaskState);
    }
  }
  return results;
}
