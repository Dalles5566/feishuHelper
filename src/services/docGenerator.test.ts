/**
 * Unit tests for DocGenerator service.
 *
 * Tests test document generation, input validation, missing information
 * flagging, and error handling using mocked LLM.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { DocGenerator } from './docGenerator.js';
import { AppError } from '../utils/errors.js';
import type { Task } from '../models/task.js';

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

const sampleTask: Task = {
  id: 'task-001',
  title: 'Implement user login with email and password',
  description:
    'Create a login endpoint that accepts email and password, validates credentials against the database, and returns a JWT token on success.',
  acceptanceCriteria: [
    'User can submit email and password to the login endpoint',
    'Valid credentials return a JWT token with user ID claim',
    'Invalid credentials return HTTP 401 with error message',
    'Account locked after 5 failed attempts',
  ],
  dependencies: ['User registration must be implemented'],
  priority: 'high',
  state: 'VerificationPassed',
  meetingId: 'meeting-001',
  sourceActionItemId: 'AI-1',
  retryCount: 0,
  descriptionHistory: [],
  createdAt: '2024-01-15T10:00:00.000Z',
  updatedAt: '2024-01-15T10:00:00.000Z',
};

const minimalTask: Task = {
  id: 'task-002',
  title: 'Fix button color',
  description: 'Change button color',
  acceptanceCriteria: ['Button should be blue'],
  dependencies: [],
  priority: 'low',
  state: 'VerificationPassed',
  meetingId: 'meeting-002',
  sourceActionItemId: 'AI-2',
  retryCount: 0,
  descriptionHistory: [],
  createdAt: '2024-01-15T10:00:00.000Z',
  updatedAt: '2024-01-15T10:00:00.000Z',
};

const fullLlmResult = {
  testCases: [
    {
      id: 'TC-001',
      title: 'Successful login with valid credentials',
      type: 'positive' as const,
      preconditions: ['User account exists with email test@example.com', 'Account is not locked'],
      steps: [
        { order: 1, action: 'Send POST /login with valid email and password', expectedOutcome: 'Request is accepted' },
        { order: 2, action: 'Check response status code', expectedOutcome: 'Status code is 200' },
        { order: 3, action: 'Parse response body for JWT token', expectedOutcome: 'JWT token is present and valid' },
      ],
      expectedResult: 'User receives a valid JWT token containing their user ID claim',
    },
    {
      id: 'TC-002',
      title: 'Login fails with invalid password',
      type: 'negative' as const,
      preconditions: ['User account exists with email test@example.com'],
      steps: [
        { order: 1, action: 'Send POST /login with valid email but wrong password', expectedOutcome: 'Request is processed' },
        { order: 2, action: 'Check response status code', expectedOutcome: 'Status code is 401' },
        { order: 3, action: 'Check response body for error message', expectedOutcome: 'Error message indicates invalid credentials' },
      ],
      expectedResult: 'User receives HTTP 401 with a descriptive error message',
    },
    {
      id: 'TC-003',
      title: 'Account locks after 5 failed attempts',
      type: 'boundary' as const,
      preconditions: ['User account exists', 'Account has 4 previous failed login attempts'],
      steps: [
        { order: 1, action: 'Send POST /login with wrong password (5th attempt)', expectedOutcome: 'Request is processed' },
        { order: 2, action: 'Check response status code', expectedOutcome: 'Status code is 401 or 423' },
        { order: 3, action: 'Attempt login with correct password', expectedOutcome: 'Account is locked, login rejected' },
      ],
      expectedResult: 'Account is locked after the 5th failed attempt and subsequent valid logins are rejected',
    },
  ],
  missingInformation: undefined,
};

const llmResultWithMissingInfo = {
  testCases: [
    {
      id: 'TC-001',
      title: 'Successful login',
      type: 'positive' as const,
      preconditions: ['User account exists'],
      steps: [
        { order: 1, action: 'Send login request', expectedOutcome: 'Login succeeds' },
      ],
      expectedResult: 'User is logged in',
    },
    {
      id: 'TC-002',
      title: 'Login with invalid input',
      type: 'negative' as const,
      preconditions: ['System is running'],
      steps: [
        { order: 1, action: 'Send login with empty email', expectedOutcome: 'Error returned' },
      ],
      expectedResult: 'Validation error is returned',
    },
    {
      id: 'TC-003',
      title: 'Login at boundary',
      type: 'boundary' as const,
      preconditions: ['System is running'],
      steps: [
        { order: 1, action: 'Send login with max-length email', expectedOutcome: 'Handled correctly' },
      ],
      expectedResult: 'System handles edge case correctly',
    },
  ],
  missingInformation: [
    'JWT token expiry duration is not specified',
    'Password complexity requirements are not defined',
    'Rate limiting behavior between attempts 1-4 is unclear',
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DocGenerator', () => {
  const noopSleep = async () => {};

  // -------------------------------------------------------------------------
  // generateTestDocument() — happy path
  // -------------------------------------------------------------------------

  describe('generateTestDocument() — successful generation', () => {
    it('should generate a TestDocument with correct taskId and generatedAt', async () => {
      const mockLlm = createMockLlm([fullLlmResult]);
      const generator = new DocGenerator({ llm: mockLlm, retrySleep: noopSleep });

      const doc = await generator.generateTestDocument(sampleTask);

      expect(doc.taskId).toBe('task-001');
      expect(doc.generatedAt).toBeTruthy();
      // Verify generatedAt is a valid ISO timestamp
      expect(new Date(doc.generatedAt).toISOString()).toBe(doc.generatedAt);
    });

    it('should include at least one positive test case (Requirement 5.2)', async () => {
      const mockLlm = createMockLlm([fullLlmResult]);
      const generator = new DocGenerator({ llm: mockLlm, retrySleep: noopSleep });

      const doc = await generator.generateTestDocument(sampleTask);

      const positiveCases = doc.testCases.filter((tc) => tc.type === 'positive');
      expect(positiveCases.length).toBeGreaterThanOrEqual(1);
    });

    it('should include at least one negative test case (Requirement 5.2)', async () => {
      const mockLlm = createMockLlm([fullLlmResult]);
      const generator = new DocGenerator({ llm: mockLlm, retrySleep: noopSleep });

      const doc = await generator.generateTestDocument(sampleTask);

      const negativeCases = doc.testCases.filter((tc) => tc.type === 'negative');
      expect(negativeCases.length).toBeGreaterThanOrEqual(1);
    });

    it('should include at least one boundary test case (Requirement 5.2)', async () => {
      const mockLlm = createMockLlm([fullLlmResult]);
      const generator = new DocGenerator({ llm: mockLlm, retrySleep: noopSleep });

      const doc = await generator.generateTestDocument(sampleTask);

      const boundaryCases = doc.testCases.filter((tc) => tc.type === 'boundary');
      expect(boundaryCases.length).toBeGreaterThanOrEqual(1);
    });

    it('should have non-empty preconditions for each test case (Requirement 5.3)', async () => {
      const mockLlm = createMockLlm([fullLlmResult]);
      const generator = new DocGenerator({ llm: mockLlm, retrySleep: noopSleep });

      const doc = await generator.generateTestDocument(sampleTask);

      for (const tc of doc.testCases) {
        expect(tc.preconditions.length).toBeGreaterThan(0);
        for (const precondition of tc.preconditions) {
          expect(precondition.trim()).not.toBe('');
        }
      }
    });

    it('should have non-empty steps for each test case (Requirement 5.3)', async () => {
      const mockLlm = createMockLlm([fullLlmResult]);
      const generator = new DocGenerator({ llm: mockLlm, retrySleep: noopSleep });

      const doc = await generator.generateTestDocument(sampleTask);

      for (const tc of doc.testCases) {
        expect(tc.steps.length).toBeGreaterThan(0);
        for (const step of tc.steps) {
          expect(step.action.trim()).not.toBe('');
          expect(step.order).toBeGreaterThan(0);
        }
      }
    });

    it('should have non-empty expectedResult for each test case (Requirement 5.3)', async () => {
      const mockLlm = createMockLlm([fullLlmResult]);
      const generator = new DocGenerator({ llm: mockLlm, retrySleep: noopSleep });

      const doc = await generator.generateTestDocument(sampleTask);

      for (const tc of doc.testCases) {
        expect(tc.expectedResult.trim()).not.toBe('');
      }
    });

    it('should have unique IDs for each test case', async () => {
      const mockLlm = createMockLlm([fullLlmResult]);
      const generator = new DocGenerator({ llm: mockLlm, retrySleep: noopSleep });

      const doc = await generator.generateTestDocument(sampleTask);

      const ids = doc.testCases.map((tc) => tc.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('should have a title for each test case', async () => {
      const mockLlm = createMockLlm([fullLlmResult]);
      const generator = new DocGenerator({ llm: mockLlm, retrySleep: noopSleep });

      const doc = await generator.generateTestDocument(sampleTask);

      for (const tc of doc.testCases) {
        expect(tc.title.trim()).not.toBe('');
      }
    });
  });

  // -------------------------------------------------------------------------
  // generateTestDocument() — missing information (Requirement 5.4)
  // -------------------------------------------------------------------------

  describe('generateTestDocument() — missing information flagging', () => {
    it('should include a missing info marker when LLM reports missing information (Requirement 5.4)', async () => {
      const mockLlm = createMockLlm([llmResultWithMissingInfo]);
      const generator = new DocGenerator({ llm: mockLlm, retrySleep: noopSleep });

      const doc = await generator.generateTestDocument(sampleTask);

      const missingInfoCase = doc.testCases.find((tc) => tc.id === 'TC-MISSING-INFO');
      expect(missingInfoCase).toBeDefined();
      expect(missingInfoCase!.title).toContain('Missing information');
    });

    it('should list all missing information items as steps in the marker', async () => {
      const mockLlm = createMockLlm([llmResultWithMissingInfo]);
      const generator = new DocGenerator({ llm: mockLlm, retrySleep: noopSleep });

      const doc = await generator.generateTestDocument(sampleTask);

      const missingInfoCase = doc.testCases.find((tc) => tc.id === 'TC-MISSING-INFO');
      expect(missingInfoCase).toBeDefined();
      expect(missingInfoCase!.steps).toHaveLength(3);
      expect(missingInfoCase!.steps[0].action).toContain('JWT token expiry');
      expect(missingInfoCase!.steps[1].action).toContain('Password complexity');
      expect(missingInfoCase!.steps[2].action).toContain('Rate limiting');
    });

    it('should not include a missing info marker when no information is missing', async () => {
      const mockLlm = createMockLlm([fullLlmResult]);
      const generator = new DocGenerator({ llm: mockLlm, retrySleep: noopSleep });

      const doc = await generator.generateTestDocument(sampleTask);

      const missingInfoCase = doc.testCases.find((tc) => tc.id === 'TC-MISSING-INFO');
      expect(missingInfoCase).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // generateTestDocument() — input validation
  // -------------------------------------------------------------------------

  describe('generateTestDocument() — input validation', () => {
    it('should throw VALIDATION_MISSING_FIELD for null task', async () => {
      const mockLlm = createMockLlm([]);
      const generator = new DocGenerator({ llm: mockLlm, retrySleep: noopSleep });

      await expect(generator.generateTestDocument(null as any)).rejects.toMatchObject({
        code: 'VALIDATION_MISSING_FIELD',
        category: 'validation',
      });
    });

    it('should throw VALIDATION_MISSING_FIELD for empty task ID', async () => {
      const mockLlm = createMockLlm([]);
      const generator = new DocGenerator({ llm: mockLlm, retrySleep: noopSleep });

      const task = { ...sampleTask, id: '' };
      await expect(generator.generateTestDocument(task)).rejects.toMatchObject({
        code: 'VALIDATION_MISSING_FIELD',
        category: 'validation',
      });
    });

    it('should throw VALIDATION_MISSING_FIELD for empty task title', async () => {
      const mockLlm = createMockLlm([]);
      const generator = new DocGenerator({ llm: mockLlm, retrySleep: noopSleep });

      const task = { ...sampleTask, title: '' };
      await expect(generator.generateTestDocument(task)).rejects.toMatchObject({
        code: 'VALIDATION_MISSING_FIELD',
        category: 'validation',
      });
    });

    it('should throw VALIDATION_MISSING_FIELD for empty acceptance criteria', async () => {
      const mockLlm = createMockLlm([]);
      const generator = new DocGenerator({ llm: mockLlm, retrySleep: noopSleep });

      const task = { ...sampleTask, acceptanceCriteria: [] };
      await expect(generator.generateTestDocument(task)).rejects.toMatchObject({
        code: 'VALIDATION_MISSING_FIELD',
        category: 'validation',
      });
    });
  });

  // -------------------------------------------------------------------------
  // generateTestDocument() — LLM error handling
  // -------------------------------------------------------------------------

  describe('generateTestDocument() — LLM error handling', () => {
    it('should throw LLM_SERVICE_UNAVAILABLE when LLM call fails', async () => {
      const mockLlm = createMockLlm([new Error('Connection refused')]);
      const generator = new DocGenerator({ llm: mockLlm, retrySleep: noopSleep });

      await expect(generator.generateTestDocument(sampleTask)).rejects.toMatchObject({
        code: 'LLM_SERVICE_UNAVAILABLE',
        category: 'llm_service',
        retryable: true,
      });
    });

    it('should throw LLM_TOKEN_LIMIT_EXCEEDED when token limit is hit', async () => {
      const mockLlm = createMockLlm([new Error('maximum context length exceeded')]);
      const generator = new DocGenerator({ llm: mockLlm, retrySleep: noopSleep });

      await expect(generator.generateTestDocument(sampleTask)).rejects.toMatchObject({
        code: 'LLM_TOKEN_LIMIT_EXCEEDED',
        category: 'llm_service',
        retryable: true,
      });
    });

    it('should retry on transient LLM failures and succeed', async () => {
      let callCount = 0;
      const mockStructuredLlm = {
        invoke: vi.fn(async () => {
          callCount++;
          if (callCount <= 2) {
            throw new Error('Service temporarily unavailable');
          }
          return fullLlmResult;
        }),
      };
      const mockLlm = {
        withStructuredOutput: vi.fn(() => mockStructuredLlm),
      } as unknown as BaseChatModel;

      const generator = new DocGenerator({ llm: mockLlm, retrySleep: noopSleep });
      const doc = await generator.generateTestDocument(sampleTask);

      expect(doc.taskId).toBe('task-001');
      expect(doc.testCases.length).toBeGreaterThan(0);
      expect(callCount).toBe(3); // 2 failures + 1 success
    });
  });

  // -------------------------------------------------------------------------
  // generateTestDocument() — test case structure
  // -------------------------------------------------------------------------

  describe('generateTestDocument() — test case structure', () => {
    it('should map test steps with correct order, action, and expectedOutcome', async () => {
      const mockLlm = createMockLlm([fullLlmResult]);
      const generator = new DocGenerator({ llm: mockLlm, retrySleep: noopSleep });

      const doc = await generator.generateTestDocument(sampleTask);

      const firstCase = doc.testCases[0];
      expect(firstCase.steps[0].order).toBe(1);
      expect(firstCase.steps[0].action).toBeTruthy();
      expect(firstCase.steps[0].expectedOutcome).toBeTruthy();
    });

    it('should preserve test case type correctly', async () => {
      const mockLlm = createMockLlm([fullLlmResult]);
      const generator = new DocGenerator({ llm: mockLlm, retrySleep: noopSleep });

      const doc = await generator.generateTestDocument(sampleTask);

      const types = doc.testCases.map((tc) => tc.type);
      expect(types).toContain('positive');
      expect(types).toContain('negative');
      expect(types).toContain('boundary');
    });

    it('should work with a minimal task (single acceptance criterion)', async () => {
      const minimalLlmResult = {
        testCases: [
          {
            id: 'TC-001',
            title: 'Button is blue',
            type: 'positive' as const,
            preconditions: ['Page is loaded'],
            steps: [{ order: 1, action: 'Inspect button color', expectedOutcome: 'Color is blue' }],
            expectedResult: 'Button displays in blue color',
          },
          {
            id: 'TC-002',
            title: 'Button color with invalid theme',
            type: 'negative' as const,
            preconditions: ['Page is loaded with invalid theme'],
            steps: [{ order: 1, action: 'Load page with broken CSS', expectedOutcome: 'Fallback color applied' }],
            expectedResult: 'Button still displays correctly',
          },
          {
            id: 'TC-003',
            title: 'Button color at different screen sizes',
            type: 'boundary' as const,
            preconditions: ['Page is loaded'],
            steps: [{ order: 1, action: 'Resize to minimum width', expectedOutcome: 'Button color unchanged' }],
            expectedResult: 'Button remains blue at all screen sizes',
          },
        ],
        missingInformation: undefined,
      };

      const mockLlm = createMockLlm([minimalLlmResult]);
      const generator = new DocGenerator({ llm: mockLlm, retrySleep: noopSleep });

      const doc = await generator.generateTestDocument(minimalTask);

      expect(doc.taskId).toBe('task-002');
      expect(doc.testCases.length).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // generateTestDocument() — LLM invocation
  // -------------------------------------------------------------------------

  describe('generateTestDocument() — LLM invocation', () => {
    it('should call withStructuredOutput on the LLM', async () => {
      const mockLlm = createMockLlm([fullLlmResult]);
      const generator = new DocGenerator({ llm: mockLlm, retrySleep: noopSleep });

      await generator.generateTestDocument(sampleTask);

      expect(mockLlm.withStructuredOutput).toHaveBeenCalledOnce();
    });

    it('should pass system and human messages to the structured LLM', async () => {
      const invokeCallArgs: unknown[] = [];
      const mockStructuredLlm = {
        invoke: vi.fn(async (...args: unknown[]) => {
          invokeCallArgs.push(...args);
          return fullLlmResult;
        }),
      };
      const mockLlm = {
        withStructuredOutput: vi.fn(() => mockStructuredLlm),
      } as unknown as BaseChatModel;

      const generator = new DocGenerator({ llm: mockLlm, retrySleep: noopSleep });
      await generator.generateTestDocument(sampleTask);

      expect(mockStructuredLlm.invoke).toHaveBeenCalledOnce();
      const messages = invokeCallArgs[0] as any[];
      expect(messages).toHaveLength(2);
      // First message is SystemMessage, second is HumanMessage
      expect(messages[0].content).toContain('QA engineer');
      expect(messages[1].content).toContain(sampleTask.title);
      expect(messages[1].content).toContain(sampleTask.description);
    });
  });
});
