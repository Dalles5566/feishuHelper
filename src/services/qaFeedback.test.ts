/**
 * Unit tests for QA Feedback service.
 *
 * Tests QA feedback submission and retrieval with mocked dependencies:
 * - Database utilities (persistence)
 * - Workflow engine (state transitions)
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { submitQAFeedback, getQAFeedbackForTask } from './qaFeedback.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../utils/db.js', () => ({
  insert: vi.fn(),
  query: vi.fn(),
}));

vi.mock('../workflow/workflowEngine.js', () => ({
  advanceWorkflow: vi.fn().mockResolvedValue(undefined),
  revertWorkflow: vi.fn().mockResolvedValue(undefined),
}));

import { insert, query } from '../utils/db.js';
import { advanceWorkflow, revertWorkflow } from '../workflow/workflowEngine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sampleFeedbackRow = {
  id: 'feedback-001',
  task_id: 'task-123',
  result: 'passed',
  failure_type: null,
  details: 'All tests passed successfully',
  test_case_results: [
    { testCaseId: 'tc-1', status: 'passed', actualResult: 'OK' },
  ],
  reported_by: 'qa-user-1',
  reported_at: '2025-01-20T10:00:00Z',
};

const baseParams = {
  taskId: 'task-123',
  result: 'passed' as const,
  details: 'All tests passed successfully',
  testCaseResults: [
    { testCaseId: 'tc-1', status: 'passed' as const, actualResult: 'OK' },
  ],
  reportedBy: 'qa-user-1',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QA Feedback Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // submitQAFeedback - QA Pass
  // -------------------------------------------------------------------------

  describe('submitQAFeedback - QA Pass', () => {
    it('should record feedback and advance workflow to QAPassed', async () => {
      vi.mocked(insert).mockResolvedValue(sampleFeedbackRow);

      const result = await submitQAFeedback(baseParams);

      // Verify feedback was recorded
      expect(vi.mocked(insert)).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO qa_feedbacks'),
        expect.arrayContaining(['task-123', 'passed', null, 'All tests passed successfully']),
        undefined,
      );

      // Verify workflow was advanced with qa_result (passed=true)
      expect(vi.mocked(advanceWorkflow)).toHaveBeenCalledWith(
        'task-123',
        expect.objectContaining({
          type: 'qa_result',
          payload: expect.objectContaining({ passed: true }),
          actor: 'qa-user-1',
        }),
        undefined,
      );

      // Verify no revert was called
      expect(vi.mocked(revertWorkflow)).not.toHaveBeenCalled();

      // Verify returned feedback
      expect(result.id).toBe('feedback-001');
      expect(result.taskId).toBe('task-123');
      expect(result.result).toBe('passed');
      expect(result.reportedBy).toBe('qa-user-1');
    });
  });

  // -------------------------------------------------------------------------
  // submitQAFeedback - QA Fail (requirement_error)
  // -------------------------------------------------------------------------

  describe('submitQAFeedback - QA Fail (requirement_error)', () => {
    it('should record feedback, advance to QAFailed, then revert to Created', async () => {
      const failedRow = {
        ...sampleFeedbackRow,
        id: 'feedback-002',
        result: 'failed',
        failure_type: 'requirement_error',
        details: 'Requirements are ambiguous',
      };
      vi.mocked(insert).mockResolvedValue(failedRow);

      const params = {
        taskId: 'task-123',
        result: 'failed' as const,
        failureType: 'requirement_error' as const,
        details: 'Requirements are ambiguous',
        testCaseResults: [
          { testCaseId: 'tc-1', status: 'failed' as const, actualResult: 'Unexpected behavior' },
        ],
        reportedBy: 'qa-user-1',
      };

      const result = await submitQAFeedback(params);

      // Verify workflow was advanced with qa_result (passed=false)
      expect(vi.mocked(advanceWorkflow)).toHaveBeenCalledWith(
        'task-123',
        expect.objectContaining({
          type: 'qa_result',
          payload: expect.objectContaining({
            passed: false,
            failureType: 'requirement_error',
          }),
        }),
        undefined,
      );

      // Verify revert to Created (meeting discussion)
      expect(vi.mocked(revertWorkflow)).toHaveBeenCalledWith(
        'task-123',
        'Created',
        expect.stringContaining('requirement_error'),
        'qa-user-1',
        undefined,
      );

      expect(result.result).toBe('failed');
      expect(result.failureType).toBe('requirement_error');
    });
  });

  // -------------------------------------------------------------------------
  // submitQAFeedback - QA Fail (implementation_error)
  // -------------------------------------------------------------------------

  describe('submitQAFeedback - QA Fail (implementation_error)', () => {
    it('should record feedback, advance to QAFailed, then revert to InDevelopment', async () => {
      const failedRow = {
        ...sampleFeedbackRow,
        id: 'feedback-003',
        result: 'failed',
        failure_type: 'implementation_error',
        details: 'Login button does not trigger auth flow',
      };
      vi.mocked(insert).mockResolvedValue(failedRow);

      const params = {
        taskId: 'task-123',
        result: 'failed' as const,
        failureType: 'implementation_error' as const,
        details: 'Login button does not trigger auth flow',
        testCaseResults: [
          { testCaseId: 'tc-2', status: 'failed' as const, actualResult: 'No auth call made' },
        ],
        reportedBy: 'qa-user-2',
      };

      const result = await submitQAFeedback(params);

      // Verify workflow was advanced with qa_result (passed=false)
      expect(vi.mocked(advanceWorkflow)).toHaveBeenCalledWith(
        'task-123',
        expect.objectContaining({
          type: 'qa_result',
          payload: expect.objectContaining({
            passed: false,
            failureType: 'implementation_error',
          }),
        }),
        undefined,
      );

      // Verify revert to InDevelopment
      expect(vi.mocked(revertWorkflow)).toHaveBeenCalledWith(
        'task-123',
        'InDevelopment',
        expect.stringContaining('implementation error'),
        'qa-user-2',
        undefined,
      );

      expect(result.result).toBe('failed');
      expect(result.failureType).toBe('implementation_error');
    });
  });

  // -------------------------------------------------------------------------
  // submitQAFeedback - Validation
  // -------------------------------------------------------------------------

  describe('submitQAFeedback - Validation', () => {
    it('should throw if taskId is missing', async () => {
      await expect(
        submitQAFeedback({ ...baseParams, taskId: '' }),
      ).rejects.toThrow('Task ID is required');
    });

    it('should throw if result is missing', async () => {
      await expect(
        submitQAFeedback({ ...baseParams, result: '' as 'passed' }),
      ).rejects.toThrow('QA result is required');
    });

    it('should throw if reportedBy is missing', async () => {
      await expect(
        submitQAFeedback({ ...baseParams, reportedBy: '' }),
      ).rejects.toThrow('Reporter is required');
    });

    it('should default failureType to unknown when not provided on failure', async () => {
      const failedRow = {
        ...sampleFeedbackRow,
        id: 'feedback-004',
        result: 'failed',
        failure_type: 'unknown',
        details: 'Something is wrong',
      };
      vi.mocked(insert).mockResolvedValue(failedRow);

      const result = await submitQAFeedback({
        ...baseParams,
        result: 'failed',
        failureType: undefined,
        details: 'Something is wrong',
      });

      // Should default to unknown and revert to Created
      expect(vi.mocked(revertWorkflow)).toHaveBeenCalledWith(
        'task-123',
        'Created',
        expect.stringContaining('unknown'),
        'qa-user-1',
        undefined,
      );
      expect(result.result).toBe('failed');
    });
  });

  // -------------------------------------------------------------------------
  // getQAFeedbackForTask
  // -------------------------------------------------------------------------

  describe('getQAFeedbackForTask', () => {
    it('should return all feedback for a task ordered by reported_at', async () => {
      const rows = [
        { ...sampleFeedbackRow, id: 'feedback-001', reported_at: '2025-01-20T10:00:00Z' },
        {
          ...sampleFeedbackRow,
          id: 'feedback-002',
          result: 'failed',
          failure_type: 'implementation_error',
          details: 'Bug found',
          reported_at: '2025-01-21T10:00:00Z',
        },
      ];
      vi.mocked(query).mockResolvedValue({ rows, rowCount: 2 });

      const result = await getQAFeedbackForTask('task-123');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('feedback-001');
      expect(result[0].result).toBe('passed');
      expect(result[1].id).toBe('feedback-002');
      expect(result[1].result).toBe('failed');
      expect(result[1].failureType).toBe('implementation_error');

      expect(vi.mocked(query)).toHaveBeenCalledWith(
        expect.stringContaining('WHERE task_id = $1'),
        ['task-123'],
        undefined,
      );
    });

    it('should return empty array when no feedback exists', async () => {
      vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await getQAFeedbackForTask('task-no-feedback');

      expect(result).toEqual([]);
    });

    it('should throw if taskId is missing', async () => {
      await expect(getQAFeedbackForTask('')).rejects.toThrow('Task ID is required');
    });
  });
});
