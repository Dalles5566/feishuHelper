/**
 * QA Feedback service.
 *
 * Handles QA test results by recording feedback, advancing the workflow
 * on pass, and routing failures back to the appropriate workflow step
 * based on failure type.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4
 */

import pg from 'pg';
import type { QAFeedback, TestCaseResult } from '../models/verification.js';
import type { WorkflowEvent } from '../models/workflow.js';
import { insert, query } from '../utils/db.js';
import { AppError, ValidationErrorCodes } from '../utils/errors.js';
import { advanceWorkflow, revertWorkflow } from '../workflow/workflowEngine.js';

// ---------------------------------------------------------------------------
// DB row types
// ---------------------------------------------------------------------------

interface QAFeedbackRow extends Record<string, unknown> {
  id: string;
  task_id: string;
  result: string;
  failure_type: string | null;
  details: string | null;
  test_case_results: TestCaseResult[];
  reported_by: string;
  reported_at: string;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/**
 * Parameters for submitting QA feedback.
 */
export interface SubmitQAFeedbackParams {
  taskId: string;
  result: 'passed' | 'failed';
  failureType?: 'requirement_error' | 'implementation_error' | 'unknown';
  details: string;
  testCaseResults: TestCaseResult[];
  reportedBy: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a database row to a QAFeedback domain object.
 */
function mapRowToFeedback(row: QAFeedbackRow): QAFeedback {
  return {
    id: row.id,
    taskId: row.task_id,
    result: row.result as 'passed' | 'failed',
    failureType: row.failure_type as 'requirement_error' | 'implementation_error' | undefined,
    details: row.details ?? '',
    testCaseResults: row.test_case_results ?? [],
    reportedBy: row.reported_by,
    reportedAt: row.reported_at,
  };
}

// ---------------------------------------------------------------------------
// submitQAFeedback
// ---------------------------------------------------------------------------

/**
 * Submit QA feedback for a task.
 *
 * - Records the feedback in the `qa_feedbacks` table.
 * - On pass: advances workflow to QAPassed.
 * - On fail (requirement_error): advances to QAFailed, then reverts to Created.
 * - On fail (implementation_error): advances to QAFailed, then reverts to InDevelopment.
 */
export async function submitQAFeedback(
  params: SubmitQAFeedbackParams,
  pool?: pg.Pool,
): Promise<QAFeedback> {
  // Validate inputs
  if (!params.taskId) {
    throw AppError.validation(
      ValidationErrorCodes.MISSING_FIELD,
      'Task ID is required',
      { field: 'taskId' },
    );
  }

  if (!params.result) {
    throw AppError.validation(
      ValidationErrorCodes.MISSING_FIELD,
      'QA result is required',
      { field: 'result' },
    );
  }

  if (!params.reportedBy) {
    throw AppError.validation(
      ValidationErrorCodes.MISSING_FIELD,
      'Reporter is required',
      { field: 'reportedBy' },
    );
  }

  if (params.result === 'failed' && !params.failureType) {
    // Default to 'unknown' — will route back to Created for team discussion
    params.failureType = 'unknown';
  }

  // 1. Record the feedback in the database
  const feedbackRow = await insert<QAFeedbackRow>(
    `INSERT INTO qa_feedbacks
       (task_id, result, failure_type, details, test_case_results, reported_by, reported_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     RETURNING id, task_id, result, failure_type, details, test_case_results, reported_by, reported_at`,
    [
      params.taskId,
      params.result,
      params.failureType ?? null,
      params.details ?? '',
      JSON.stringify(params.testCaseResults ?? []),
      params.reportedBy,
    ],
    pool,
  );

  const feedback = mapRowToFeedback(feedbackRow);

  // 2. Build the workflow event
  const event: WorkflowEvent = {
    type: 'qa_result',
    payload: {
      passed: params.result === 'passed',
      failureType: params.failureType,
      feedbackId: feedback.id,
      reason: params.details,
    },
    actor: params.reportedBy,
    timestamp: new Date().toISOString(),
  };

  // 3. Advance workflow based on result
  await advanceWorkflow(params.taskId, event, pool);

  // 4. On failure, route to the appropriate state
  if (params.result === 'failed') {
    if (params.failureType === 'implementation_error') {
      // Implementation error: route back to InDevelopment
      await revertWorkflow(
        params.taskId,
        'InDevelopment',
        `QA failed due to implementation error: ${params.details}`,
        params.reportedBy,
        pool,
      );
    } else {
      // requirement_error or unknown: route back to Created (meeting discussion)
      await revertWorkflow(
        params.taskId,
        'Created',
        `QA failed (${params.failureType}): ${params.details}`,
        params.reportedBy,
        pool,
      );
    }
  }

  return feedback;
}

// ---------------------------------------------------------------------------
// getQAFeedbackForTask
// ---------------------------------------------------------------------------

/**
 * Retrieve all QA feedback records associated with a specific task.
 * Results are ordered by reported_at ascending (oldest first).
 */
export async function getQAFeedbackForTask(
  taskId: string,
  pool?: pg.Pool,
): Promise<QAFeedback[]> {
  if (!taskId) {
    throw AppError.validation(
      ValidationErrorCodes.MISSING_FIELD,
      'Task ID is required',
      { field: 'taskId' },
    );
  }

  const result = await query<QAFeedbackRow>(
    `SELECT id, task_id, result, failure_type, details, test_case_results, reported_by, reported_at
       FROM qa_feedbacks
      WHERE task_id = $1
      ORDER BY reported_at ASC`,
    [taskId],
    pool,
  );

  return result.rows.map(mapRowToFeedback);
}
