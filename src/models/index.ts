/**
 * Unified re-export of all core model types.
 *
 * Import from this module to access any type defined in the models layer:
 *
 *   import type { Task, TaskState, Meeting, WorkflowEvent } from '../models/index.js';
 */

// Task models
export type {
  TaskState,
  DescriptionUpdate,
  Task,
  SubTask,
  TaskCreateParams,
  SubTaskParams,
  TaskFilter,
  TaskAssignment,
} from './task.js';

// Meeting models
export type {
  MeetingSummary,
  ActionItem,
  Decision,
  DiscussionPoint,
  MeetingAnalysis,
  Meeting,
} from './meeting.js';

// Workflow models
export type {
  WorkflowEvent,
  StateTransition,
  TransitionContext,
  WorkflowStatus,
  WorkflowLog,
} from './workflow.js';

// Verification models
export type {
  CodeContext,
  Discrepancy,
  VerificationReport,
  StoredVerificationReport,
  TestCaseResult,
  QAFeedback,
} from './verification.js';

// Document models
export type {
  TestStep,
  TestCase,
  TestDocument,
  DocSection,
  MDDocument,
  DocUpdateContent,
  TocEntry,
  CrossReference,
  UserManual,
  DocType,
} from './document.js';
