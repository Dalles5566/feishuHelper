/**
 * Task-related TypeScript interfaces and types.
 *
 * Defines the core data structures for tasks and subtasks throughout
 * the Feishu Helper workflow lifecycle.
 *
 * Requirements: 2.3, 9.1
 */

// ---------------------------------------------------------------------------
// Task State
// ---------------------------------------------------------------------------

/**
 * All valid states a task can occupy in the workflow state machine.
 */
export type TaskState =
  | 'Created'
  | 'Assigned'
  | 'InDevelopment'
  | 'VerificationPending'
  | 'VerificationPassed'
  | 'VerificationFailed'
  | 'QAPending'
  | 'QAPassed'
  | 'QAFailed'
  | 'DocumentationUpdated'
  | 'Completed';

// ---------------------------------------------------------------------------
// Description History
// ---------------------------------------------------------------------------

/**
 * A single entry in a task's description update history.
 */
export interface DescriptionUpdate {
  previousDescription: string;
  newDescription: string;
  /** Human-readable reason for the update (e.g. "Meeting update on 2025-01-15"). */
  reason: string;
  updatedBy: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

/**
 * Core task entity representing a development work item derived from a meeting
 * action item.
 */
export interface Task {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  priority: 'high' | 'medium' | 'low';
  state: TaskState;
  /** Feishu user ID of the assigned developer. */
  assignee?: string;
  /** Present when this task is a subtask of another task. */
  parentTaskId?: string;
  /** ID of the meeting that originated this task (deprecated, use task_meetings table). */
  meetingId?: string;
  /** ID of the action item in the meeting analysis that produced this task. */
  sourceActionItemId: string;
  /** Feishu platform task ID (set after the task is created in Feishu). */
  feishuTaskId?: string;
  /** Number of times this task has been retried after a failure. */
  retryCount: number;
  /** Description of the most recent failure, preserved for reference. */
  failureContext?: string;
  /** Ordered history of all description updates. */
  descriptionHistory: DescriptionUpdate[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// SubTask
// ---------------------------------------------------------------------------

/**
 * A subtask split from a complex parent task.
 */
export interface SubTask {
  id: string;
  title: string;
  description: string;
  /** The specific scope this subtask covers within the parent task. */
  scope: string;
  estimatedEffort?: string;
  parentTaskId: string;
  state: TaskState;
  assignee?: string;
  feishuTaskId?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Task Creation / Splitting Params
// ---------------------------------------------------------------------------

/**
 * Parameters required to create a new task from a meeting action item.
 */
export interface TaskCreateParams {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  priority: 'high' | 'medium' | 'low';
  sourceActionItemId: string;
}

/**
 * Parameters for creating a subtask when splitting a complex task.
 */
export interface SubTaskParams {
  title: string;
  description: string;
  /** The distinct scope this subtask addresses within the parent. */
  scope: string;
  estimatedEffort?: string;
}

// ---------------------------------------------------------------------------
// Task Filter
// ---------------------------------------------------------------------------

/**
 * Filter criteria for listing tasks.
 */
export interface TaskFilter {
  state?: TaskState;
  assignee?: string;
  meetingId?: string;
  priority?: 'high' | 'medium' | 'low';
  parentTaskId?: string;
}

// ---------------------------------------------------------------------------
// Task Assignment
// ---------------------------------------------------------------------------

/**
 * Records the assignment relationship between a task and a developer.
 */
export interface TaskAssignment {
  id: string;
  taskId: string;
  assigneeId: string;
  assigneeName: string;
  assignedBy: string;
  assignedAt: string;
  status: 'active' | 'reassigned' | 'completed';
}
