/**
 * Workflow-related TypeScript interfaces and types.
 *
 * Defines the data structures for workflow events, status snapshots,
 * state transitions, and transition context used by the Workflow Engine
 * and State Manager.
 *
 * Requirements: 9.1, 9.2
 */

import type { TaskState } from './task.js';

// ---------------------------------------------------------------------------
// Workflow Event
// ---------------------------------------------------------------------------

/**
 * An event that drives a task forward (or backward) in the workflow.
 */
export interface WorkflowEvent {
  /** The type of event that occurred. */
  type:
    | 'assignment'
    | 'dev_complete'
    | 'verification_result'
    | 'qa_result'
    | 'doc_updated'
    | 'meeting_update';
  /** Event-specific data (e.g. verification pass/fail, QA failure type). */
  payload: Record<string, unknown>;
  /** Feishu user ID of the person or system that triggered the event. */
  actor: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// State Transition
// ---------------------------------------------------------------------------

/**
 * A single recorded state transition for a task.
 */
export interface StateTransition {
  fromState: TaskState;
  toState: TaskState;
  /** Short description of what triggered the transition. */
  trigger: string;
  /** Feishu user ID of the actor who caused the transition. */
  actor: string;
  timestamp: string;
  /** Optional human-readable reason (required for failure reverts). */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Transition Context
// ---------------------------------------------------------------------------

/**
 * Context provided when requesting a state transition.
 */
export interface TransitionContext {
  trigger: string;
  actor: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Workflow Status
// ---------------------------------------------------------------------------

/**
 * Current status snapshot of a task's workflow, including full history.
 */
export interface WorkflowStatus {
  taskId: string;
  currentState: TaskState;
  history: StateTransition[];
  retryCount: number;
  failureContext?: string;
}

// ---------------------------------------------------------------------------
// Workflow Log (persisted)
// ---------------------------------------------------------------------------

/**
 * A workflow log entry as stored in the database.
 */
export interface WorkflowLog {
  id: string;
  taskId: string;
  fromState: TaskState;
  toState: TaskState;
  trigger: string;
  actor: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}
