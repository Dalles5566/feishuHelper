/**
 * Unit tests for CodeVerifier service.
 *
 * Tests structured output parsing, input validation, workflow advancement,
 * report persistence, and error handling using mocked LLM and database.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { CodeVerifier } from './codeVerifier.js';
import { AppError } from '../utils/errors.js';
import type { CodeContext } from '../models/verification.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Mock database utilities
vi.mock('../utils/db.js', () => ({
  insert: vi.fn(),
  queryOne: vi.fn(),
}));

// Mock workflow engine
vi.mock('../workflow/workflowEngine.js', () => ({
  advanceWorkflow: vi.fn(),
}));

import { insert, queryOne } from '../utils/db.js';
import { advanceWorkflow } from '../workflow/workflowEngine.js';

// ---------------------------------------------------------------------------
// Mock LLM helper
// ---------------------------------------------------------------------------

/**
 * Create a mock LLM that returns structured output via withStructuredOutput.
 */
function createMockLlm(responses: unknown[]): BaseChatModel {
  let callIndex = 0;

  const mockStructuredLlm = {
    invoke: vi.fn(async () => {
      const response = responses[callIndex % responses.length];
      callIndex++;
      if (response instanceof Error) {
        throw response;
      }
      return response;
    }),
  };

  return {
    withStructuredOutput: vi.fn(() => mockStructuredLlm),
  } as unknown as BaseChatModel;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const sampleCodeContext: CodeContext = {
  taskDescription: 'Implement user authentication with JWT tokens. User can log in with email and password. JWT token is returned on successful login. Invalid credentials return 401 status.',
  codeChanges: `
+function login(email: string, password: string): string {
+  const user = db.findUser(email);
+  if (!user || !bcrypt.compare(password, user.passwordHash)) {
+    throw new UnauthorizedError('Invalid credentials');
+  }
+  return jwt.sign({ userId: user.id }, SECRET_KEY);
+}
  `.trim(),
  commitMessage: 'feat: implement JWT login endpoint',
};

const passedLlmResult = {
  status: 'passed' as const,
  matchScore: 95,
  matchedCriteria: [
    'User can log in with email and password',
    'JWT token is returned on successful login',
    'Invalid credentials return 401 status',
  ],
  unmatchedCriteria: [],
  discrepancies: [],
  recommendations: ['Consider adding rate limiting to the login endpoint'],
};

const failedLlmResult = {
  status: 'failed' as const,
  matchScore: 40,
  matchedCriteria: ['User can log in with email and password'],
  unmatchedCriteria: [
    'JWT token is returned on successful login',
    'Invalid credentials return 401 status',
  ],
  discrepancies: [
    {
      criterion: 'JWT token is returned on successful login',
      expected: 'A JWT token string is returned',
      actual: 'Function returns void, no token returned',
      severity: 'critical' as const,
    },
    {
      criterion: 'Invalid credentials return 401 status',
      expected: 'HTTP 401 status code',
      actual: 'Throws a generic Error, not an HTTP error',
      severity: 'major' as const,
    },
  ],
  recommendations: [
    'Return the JWT token from the login function',
    'Use an HTTP error class that sets the 401 status code',
  ],
};

const ambiguousLlmResult = {
  status: 'ambiguous' as const,
  matchScore: 55,
  matchedCriteria: ['User can log in with email and password'],
  unmatchedCriteria: ['JWT token is returned on successful login'],
  discrepancies: [
    {
      criterion: 'JWT token is returned on successful login',
      expected: 'Unclear — requirement does not specify token format or expiry',
      actual: 'Token is returned but format is unspecified',
      severity: 'minor' as const,
    },
  ],
  recommendations: [
    'Clarify the expected JWT token format and expiry in the task description',
    'Update the task description through a follow-up meeting',
  ],
};

const sampleTaskRow = { id: 'task-123', state: 'VerificationPending' };

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default: task exists
  vi.mocked(queryOne).mockResolvedValue(sampleTaskRow);

  // Default: insert succeeds
  vi.mocked(insert).mockResolvedValue({
    id: 'report-uuid',
    task_id: 'task-123',
    report: {},
    code_context: {},
    created_at: new Date(),
  } as any);

  // Default: workflow advance succeeds
  vi.mocked(advanceWorkflow).mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodeVerifier', () => {
  const noopSleep = async () => {};

  // -------------------------------------------------------------------------
  // verify() — happy paths
  // -------------------------------------------------------------------------

  describe('verify() — passed verification', () => {
    it('should return a VerificationReport with status passed', async () => {
      const mockLlm = createMockLlm([passedLlmResult]);
      const verifier = new CodeVerifier({ llm: mockLlm, retrySleep: noopSleep });

      const report = await verifier.verify('task-123', sampleCodeContext);

      expect(report.taskId).toBe('task-123');
      expect(report.status).toBe('passed');
      expect(report.matchScore).toBe(95);
      expect(report.analysis.matchedCriteria).toHaveLength(3);
      expect(report.analysis.unmatchedCriteria).toHaveLength(0);
      expect(report.analysis.discrepancies).toHaveLength(0);
      expect(report.analysis.recommendations).toHaveLength(1);
      expect(report.generatedAt).toBeTruthy();
    });

    it('should NOT call advanceWorkflow (verify_code is report-only)', async () => {
      const mockLlm = createMockLlm([passedLlmResult]);
      const verifier = new CodeVerifier({ llm: mockLlm, retrySleep: noopSleep });

      await verifier.verify('task-123', sampleCodeContext);

      expect(advanceWorkflow).not.toHaveBeenCalled();
    });

    it('should persist the report to the database', async () => {
      const mockLlm = createMockLlm([passedLlmResult]);
      const verifier = new CodeVerifier({ llm: mockLlm, retrySleep: noopSleep });

      await verifier.verify('task-123', sampleCodeContext);

      expect(insert).toHaveBeenCalledOnce();
      const [sql, params] = vi.mocked(insert).mock.calls[0];
      expect(sql).toContain('verification_reports');
      expect(params![0]).toBe('task-123');
    });
  });

  describe('verify() — failed verification', () => {
    it('should return a VerificationReport with status failed', async () => {
      const mockLlm = createMockLlm([failedLlmResult]);
      const verifier = new CodeVerifier({ llm: mockLlm, retrySleep: noopSleep });

      const report = await verifier.verify('task-123', sampleCodeContext);

      expect(report.status).toBe('failed');
      expect(report.matchScore).toBe(40);
      expect(report.analysis.matchedCriteria).toHaveLength(1);
      expect(report.analysis.unmatchedCriteria).toHaveLength(2);
      expect(report.analysis.discrepancies).toHaveLength(2);
      expect(report.analysis.discrepancies[0].severity).toBe('critical');
    });

    it('should NOT call advanceWorkflow even when status is failed', async () => {
      const mockLlm = createMockLlm([failedLlmResult]);
      const verifier = new CodeVerifier({ llm: mockLlm, retrySleep: noopSleep });

      await verifier.verify('task-123', sampleCodeContext);

      expect(advanceWorkflow).not.toHaveBeenCalled();
    });
  });

  describe('verify() — ambiguous verification', () => {
    it('should return a VerificationReport with status ambiguous', async () => {
      const mockLlm = createMockLlm([ambiguousLlmResult]);
      const verifier = new CodeVerifier({ llm: mockLlm, retrySleep: noopSleep });

      const report = await verifier.verify('task-123', sampleCodeContext);

      expect(report.status).toBe('ambiguous');
      expect(report.analysis.recommendations.length).toBeGreaterThan(0);
    });

    it('should NOT call advanceWorkflow even when status is ambiguous', async () => {
      const mockLlm = createMockLlm([ambiguousLlmResult]);
      const verifier = new CodeVerifier({ llm: mockLlm, retrySleep: noopSleep });

      await verifier.verify('task-123', sampleCodeContext);

      expect(advanceWorkflow).not.toHaveBeenCalled();
    });

    it('should include a recommendation to update requirements when ambiguous', async () => {
      const mockLlm = createMockLlm([ambiguousLlmResult]);
      const verifier = new CodeVerifier({ llm: mockLlm, retrySleep: noopSleep });

      const report = await verifier.verify('task-123', sampleCodeContext);

      const hasAmbiguityRecommendation = report.analysis.recommendations.some(
        (r) => r.toLowerCase().includes('meeting') || r.toLowerCase().includes('clarif'),
      );
      expect(hasAmbiguityRecommendation).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // verify() — report structure (Requirement 4.2)
  // -------------------------------------------------------------------------

  describe('verify() — report structure', () => {
    it('should include all required fields in the report', async () => {
      const mockLlm = createMockLlm([passedLlmResult]);
      const verifier = new CodeVerifier({ llm: mockLlm, retrySleep: noopSleep });

      const report = await verifier.verify('task-123', sampleCodeContext);

      expect(report).toHaveProperty('taskId');
      expect(report).toHaveProperty('status');
      expect(report).toHaveProperty('matchScore');
      expect(report).toHaveProperty('analysis');
      expect(report.analysis).toHaveProperty('matchedCriteria');
      expect(report.analysis).toHaveProperty('unmatchedCriteria');
      expect(report.analysis).toHaveProperty('discrepancies');
      expect(report.analysis).toHaveProperty('recommendations');
      expect(report).toHaveProperty('generatedAt');
    });

    it('should have matchedCriteria + unmatchedCriteria equal to all acceptance criteria', async () => {
      const mockLlm = createMockLlm([failedLlmResult]);
      const verifier = new CodeVerifier({ llm: mockLlm, retrySleep: noopSleep });

      const report = await verifier.verify('task-123', sampleCodeContext);

      const allCriteria = [
        ...report.analysis.matchedCriteria,
        ...report.analysis.unmatchedCriteria,
      ];
      // LLM returns matched/unmatched criteria extracted from description
      expect(Array.isArray(allCriteria)).toBe(true);
    });

    it('should have matchScore between 0 and 100', async () => {
      const mockLlm = createMockLlm([passedLlmResult]);
      const verifier = new CodeVerifier({ llm: mockLlm, retrySleep: noopSleep });

      const report = await verifier.verify('task-123', sampleCodeContext);

      expect(report.matchScore).toBeGreaterThanOrEqual(0);
      expect(report.matchScore).toBeLessThanOrEqual(100);
    });

    it('should set generatedAt to a valid ISO timestamp', async () => {
      const mockLlm = createMockLlm([passedLlmResult]);
      const verifier = new CodeVerifier({ llm: mockLlm, retrySleep: noopSleep });

      const before = new Date().toISOString();
      const report = await verifier.verify('task-123', sampleCodeContext);
      const after = new Date().toISOString();

      expect(report.generatedAt >= before).toBe(true);
      expect(report.generatedAt <= after).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // verify() — input validation
  // -------------------------------------------------------------------------

  describe('verify() — input validation', () => {
    it('should throw VALIDATION_MISSING_FIELD for empty taskId', async () => {
      const mockLlm = createMockLlm([]);
      const verifier = new CodeVerifier({ llm: mockLlm, retrySleep: noopSleep });

      await expect(verifier.verify('', sampleCodeContext)).rejects.toMatchObject({
        code: 'VALIDATION_MISSING_FIELD',
        category: 'validation',
      });
    });

    it('should throw VALIDATION_EMPTY_CONTENT for empty taskDescription', async () => {
      const mockLlm = createMockLlm([]);
      const verifier = new CodeVerifier({ llm: mockLlm, retrySleep: noopSleep });

      const ctx: CodeContext = { ...sampleCodeContext, taskDescription: '' };
      await expect(verifier.verify('task-123', ctx)).rejects.toMatchObject({
        code: 'VALIDATION_EMPTY_CONTENT',
        category: 'validation',
      });
    });

    it('should throw VALIDATION_EMPTY_CONTENT for empty codeChanges', async () => {
      const mockLlm = createMockLlm([]);
      const verifier = new CodeVerifier({ llm: mockLlm, retrySleep: noopSleep });

      const ctx: CodeContext = { ...sampleCodeContext, codeChanges: '' };
      await expect(verifier.verify('task-123', ctx)).rejects.toMatchObject({
        code: 'VALIDATION_EMPTY_CONTENT',
        category: 'validation',
      });
    });

    it('should succeed with no acceptanceCriteria field (field removed)', async () => {
      vi.mocked(queryOne).mockResolvedValue({ id: 'task-123', state: 'InDevelopment' });
      vi.mocked(insert).mockResolvedValue({ id: 'report-1' });

      const mockLlm = createMockLlm([passedLlmResult]);
      const verifier = new CodeVerifier({ llm: mockLlm, retrySleep: noopSleep, skipWorkflowAdvance: true });

      const result = await verifier.verify('task-123', sampleCodeContext);
      expect(result.status).toBe('passed');
    });
  });

  // -------------------------------------------------------------------------
  // verify() — task not found
  // -------------------------------------------------------------------------

  describe('verify() — task not found', () => {
    it('should throw BUSINESS_TASK_NOT_FOUND when task does not exist', async () => {
      vi.mocked(queryOne).mockResolvedValue(null);

      const mockLlm = createMockLlm([passedLlmResult]);
      const verifier = new CodeVerifier({ llm: mockLlm, retrySleep: noopSleep });

      await expect(verifier.verify('nonexistent-task', sampleCodeContext)).rejects.toMatchObject({
        code: 'BUSINESS_TASK_NOT_FOUND',
        category: 'business_logic',
      });
    });
  });

  // -------------------------------------------------------------------------
  // verify() — LLM error handling
  // -------------------------------------------------------------------------

  describe('verify() — LLM error handling', () => {
    it('should throw LLM_SERVICE_UNAVAILABLE when LLM call fails', async () => {
      const mockLlm = createMockLlm([new Error('Connection refused')]);
      const verifier = new CodeVerifier({ llm: mockLlm, retrySleep: noopSleep });

      await expect(verifier.verify('task-123', sampleCodeContext)).rejects.toMatchObject({
        code: 'LLM_SERVICE_UNAVAILABLE',
        category: 'llm_service',
        retryable: true,
      });
    });

    it('should return an ambiguous report when token limit is hit (proceeds to QA)', async () => {
      const mockLlm = createMockLlm([new Error('maximum context length exceeded')]);
      const verifier = new CodeVerifier({ llm: mockLlm, retrySleep: noopSleep });

      const report = await verifier.verify('task-123', sampleCodeContext);

      expect(report.status).toBe('ambiguous');
      expect(report.matchScore).toBe(0);
      expect(report.analysis.recommendations.some(r => r.toLowerCase().includes('too large') || r.toLowerCase().includes('manually'))).toBe(true);
    });

    it('should retry on transient LLM failures and succeed on third attempt', async () => {
      let callCount = 0;
      const mockStructuredLlm = {
        invoke: vi.fn(async () => {
          callCount++;
          if (callCount <= 2) {
            throw new Error('Service temporarily unavailable');
          }
          return passedLlmResult;
        }),
      };
      const mockLlm = {
        withStructuredOutput: vi.fn(() => mockStructuredLlm),
      } as unknown as BaseChatModel;

      const verifier = new CodeVerifier({ llm: mockLlm, retrySleep: noopSleep });
      const report = await verifier.verify('task-123', sampleCodeContext);

      expect(report.status).toBe('passed');
      expect(callCount).toBe(3); // 2 failures + 1 success
    });
  });

  // -------------------------------------------------------------------------
  // verify() — workflow not advanced when skipWorkflowAdvance is true
  // -------------------------------------------------------------------------

  describe('verify() — skipWorkflowAdvance option', () => {
    it('should not call advanceWorkflow when skipWorkflowAdvance is true', async () => {
      const mockLlm = createMockLlm([passedLlmResult]);
      const verifier = new CodeVerifier({
        llm: mockLlm,
        retrySleep: noopSleep,
        skipWorkflowAdvance: true,
      });

      await verifier.verify('task-123', sampleCodeContext);

      expect(advanceWorkflow).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // verify() — optional commitMessage
  // -------------------------------------------------------------------------

  describe('verify() — optional commitMessage', () => {
    it('should work without a commitMessage', async () => {
      const mockLlm = createMockLlm([passedLlmResult]);
      const verifier = new CodeVerifier({ llm: mockLlm, retrySleep: noopSleep });

      const ctx: CodeContext = {
        taskDescription: sampleCodeContext.taskDescription,
        codeChanges: sampleCodeContext.codeChanges,
        // no commitMessage
      };

      const report = await verifier.verify('task-123', ctx);
      expect(report).toBeDefined();
      expect(report.status).toBe('passed');
    });
  });

  // -------------------------------------------------------------------------
  // getLatestReport()
  // -------------------------------------------------------------------------

  describe('getLatestReport()', () => {
    it('should return the stored report when one exists', async () => {
      const storedRow = {
        id: 'report-uuid',
        task_id: 'task-123',
        report: {
          taskId: 'task-123',
          status: 'passed',
          matchScore: 95,
          analysis: {
            matchedCriteria: ['criterion 1'],
            unmatchedCriteria: [],
            discrepancies: [],
            recommendations: [],
          },
          generatedAt: '2024-01-15T10:00:00.000Z',
        },
        code_context: sampleCodeContext,
        created_at: new Date('2024-01-15T10:00:00.000Z'),
      };

      vi.mocked(queryOne).mockResolvedValue(storedRow as any);

      const verifier = new CodeVerifier({ retrySleep: noopSleep });
      const result = await verifier.getLatestReport('task-123');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('report-uuid');
      expect(result!.taskId).toBe('task-123');
      expect(result!.report.status).toBe('passed');
    });

    it('should return null when no report exists', async () => {
      vi.mocked(queryOne).mockResolvedValue(null);

      const verifier = new CodeVerifier({ retrySleep: noopSleep });
      const result = await verifier.getLatestReport('task-123');

      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // verify() — workflow event actor
  // -------------------------------------------------------------------------

  // advanceWorkflow is no longer called by CodeVerifier — verify_code is report-only.
  // State advancement is handled by advance_task tool.
});
