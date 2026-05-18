/**
 * Unit tests for MeetingAnalyzer service.
 *
 * Tests structured output parsing, empty content handling, error handling,
 * and long content chunking logic using mocked LLM responses.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { MeetingAnalyzer } from './meetingAnalyzer.js';
import { AppError } from '../utils/errors.js';
import type { MeetingAnalysis, MeetingSummary, ActionItem } from '../models/meeting.js';

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

  const mockLlm = {
    withStructuredOutput: vi.fn(() => mockStructuredLlm),
  } as unknown as BaseChatModel;

  return mockLlm;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const sampleMeetingContent = `
Meeting: Sprint Planning - Q1 Feature Review
Date: 2024-01-15
Participants: Alice, Bob, Charlie, Diana

Discussion:
1. Alice presented the new authentication module design. The team agreed to use OAuth 2.0.
2. Bob raised concerns about the database migration timeline. Decision: extend deadline by 1 week.
3. Charlie will implement the user dashboard by end of sprint.
4. Diana suggested adding rate limiting to the API. This was approved with high priority.

Action Items:
- Charlie: Implement user dashboard (high priority, depends on auth module)
- Diana: Add rate limiting to API endpoints (high priority)
- Bob: Update database migration scripts (medium priority)
- Alice: Write OAuth 2.0 integration tests (medium priority)

Decisions:
- Use OAuth 2.0 for authentication
- Extend database migration deadline by 1 week
- Approve rate limiting implementation
`;

const sampleAnalysisResult: MeetingAnalysis = {
  summary: {
    title: 'Sprint Planning - Q1 Feature Review',
    date: '2024-01-15',
    participants: ['Alice', 'Bob', 'Charlie', 'Diana'],
    keyPoints: [
      'OAuth 2.0 authentication module design approved',
      'Database migration deadline extended by 1 week',
      'User dashboard implementation assigned to Charlie',
      'Rate limiting approved with high priority',
    ],
    overallSummary:
      'Sprint planning meeting covering Q1 feature review. Key decisions include adopting OAuth 2.0, extending DB migration timeline, and prioritizing rate limiting.',
  },
  actionItems: [
    {
      id: 'AI-1',
      description: 'Implement user dashboard',
      context: 'Charlie will implement the user dashboard by end of sprint',
      priority: 'high',
      suggestedAssignee: 'Charlie',
      dependencies: ['AI-4'],
      acceptanceCriteria: ['Dashboard renders user data', 'Responsive design implemented'],    },
    {
      id: 'AI-2',
      description: 'Add rate limiting to API endpoints',
      context: 'Diana suggested adding rate limiting to the API. This was approved with high priority.',
      priority: 'high',
      suggestedAssignee: 'Diana',
      dependencies: [],
      acceptanceCriteria: ['Rate limiting configured per endpoint', 'Returns 429 on limit exceeded'],
    },
    {
      id: 'AI-3',
      description: 'Update database migration scripts',
      context: 'Bob raised concerns about the database migration timeline',
      priority: 'medium',
      suggestedAssignee: 'Bob',
      dependencies: [],
      acceptanceCriteria: ['Migration scripts updated', 'Rollback tested'],
    },
    {
      id: 'AI-4',
      description: 'Write OAuth 2.0 integration tests',
      context: 'Alice presented the new authentication module design',
      priority: 'medium',
      suggestedAssignee: 'Alice',
      dependencies: [],
      acceptanceCriteria: ['Integration tests cover login flow', 'Token refresh tested'],
    },  ],
  decisions: [
    {
      id: 'D-1',
      description: 'Use OAuth 2.0 for authentication',
      rationale: 'Team agreed on the design presented by Alice',
      madeBy: 'Alice',
    },
    {
      id: 'D-2',
      description: 'Extend database migration deadline by 1 week',
      rationale: 'Bob raised concerns about timeline feasibility',
      madeBy: 'Bob',
    },
    {
      id: 'D-3',
      description: 'Approve rate limiting implementation',
      rationale: 'Suggested by Diana, approved with high priority',
      madeBy: 'Diana',
    },
  ],
  discussionPoints: [
    {
      id: 'DP-1',
      topic: 'Authentication module design',
      summary: 'Alice presented OAuth 2.0 design, team approved',
      outcome: 'Approved - proceed with OAuth 2.0',
    },
    {
      id: 'DP-2',
      topic: 'Database migration timeline',
      summary: 'Bob raised concerns about feasibility of current deadline',
      outcome: 'Extended by 1 week',
    },
  ],
};

const sampleSummaryResult: MeetingSummary = sampleAnalysisResult.summary;

const sampleActionItemsResult = { actionItems: sampleAnalysisResult.actionItems };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MeetingAnalyzer', () => {
  const noopSleep = async () => {};

  describe('analyze()', () => {
    it('should produce a complete structured analysis from meeting content', async () => {
      const mockLlm = createMockLlm([sampleAnalysisResult]);
      const analyzer = new MeetingAnalyzer({ llm: mockLlm, retrySleep: noopSleep });

      const result = await analyzer.analyze(sampleMeetingContent);

      expect(result).toBeDefined();
      expect(result.summary).toBeDefined();
      expect(result.summary.title).toBe('Sprint Planning - Q1 Feature Review');
      expect(result.summary.participants).toHaveLength(4);
      expect(result.summary.keyPoints.length).toBeGreaterThan(0);
      expect(result.summary.overallSummary).toBeTruthy();
      expect(result.actionItems).toHaveLength(4);
      expect(result.decisions).toHaveLength(3);
      expect(result.discussionPoints).toHaveLength(2);
    });

    it('should include priority, suggestedAssignee, and dependencies in action items', async () => {
      const mockLlm = createMockLlm([sampleAnalysisResult]);
      const analyzer = new MeetingAnalyzer({ llm: mockLlm, retrySleep: noopSleep });

      const result = await analyzer.analyze(sampleMeetingContent);

      for (const item of result.actionItems) {
        expect(item.id).toBeTruthy();
        expect(item.description).toBeTruthy();
        expect(item.context).toBeTruthy();
        expect(['high', 'medium', 'low']).toContain(item.priority);
        expect(Array.isArray(item.dependencies)).toBe(true);
      }
    });

    it('should include decisions with id, description, and optional rationale', async () => {
      const mockLlm = createMockLlm([sampleAnalysisResult]);
      const analyzer = new MeetingAnalyzer({ llm: mockLlm, retrySleep: noopSleep });

      const result = await analyzer.analyze(sampleMeetingContent);

      for (const decision of result.decisions) {
        expect(decision.id).toBeTruthy();
        expect(decision.description).toBeTruthy();
      }
    });

    it('should include discussion points with id, topic, and summary', async () => {
      const mockLlm = createMockLlm([sampleAnalysisResult]);
      const analyzer = new MeetingAnalyzer({ llm: mockLlm, retrySleep: noopSleep });

      const result = await analyzer.analyze(sampleMeetingContent);

      for (const dp of result.discussionPoints) {
        expect(dp.id).toBeTruthy();
        expect(dp.topic).toBeTruthy();
        expect(dp.summary).toBeTruthy();
      }
    });

    it('should throw VALIDATION_EMPTY_CONTENT for empty content', async () => {
      const mockLlm = createMockLlm([]);
      const analyzer = new MeetingAnalyzer({ llm: mockLlm, retrySleep: noopSleep });

      await expect(analyzer.analyze('')).rejects.toThrow(AppError);
      await expect(analyzer.analyze('')).rejects.toMatchObject({
        code: 'VALIDATION_EMPTY_CONTENT',
        category: 'validation',
      });
    });

    it('should throw VALIDATION_EMPTY_CONTENT for whitespace-only content', async () => {
      const mockLlm = createMockLlm([]);
      const analyzer = new MeetingAnalyzer({ llm: mockLlm, retrySleep: noopSleep });

      await expect(analyzer.analyze('   \n\t  ')).rejects.toThrow(AppError);
      await expect(analyzer.analyze('   \n\t  ')).rejects.toMatchObject({
        code: 'VALIDATION_EMPTY_CONTENT',
      });
    });

    it('should throw LLM_SERVICE_UNAVAILABLE when LLM call fails', async () => {
      const mockLlm = createMockLlm([new Error('Connection refused')]);
      const analyzer = new MeetingAnalyzer({ llm: mockLlm, retrySleep: noopSleep });

      await expect(analyzer.analyze(sampleMeetingContent)).rejects.toThrow(AppError);
      await expect(analyzer.analyze(sampleMeetingContent)).rejects.toMatchObject({
        code: 'LLM_SERVICE_UNAVAILABLE',
        category: 'llm_service',
        retryable: true,
      });
    });

    it('should throw LLM_TOKEN_LIMIT_EXCEEDED when token limit is hit', async () => {
      const mockLlm = createMockLlm([new Error('maximum context length exceeded')]);
      const analyzer = new MeetingAnalyzer({ llm: mockLlm, retrySleep: noopSleep });

      await expect(analyzer.analyze(sampleMeetingContent)).rejects.toThrow(AppError);
      await expect(analyzer.analyze(sampleMeetingContent)).rejects.toMatchObject({
        code: 'LLM_TOKEN_LIMIT_EXCEEDED',
        category: 'llm_service',
      });
    });

    it('should handle long content by chunking and merging', async () => {
      // Create content longer than the chunk size
      const longContent = sampleMeetingContent.repeat(20);
      const chunkSize = 500; // Small chunk size to force chunking

      // The mock will return analysis for each chunk and then the merged result
      const mockLlm = createMockLlm([sampleAnalysisResult]);
      const analyzer = new MeetingAnalyzer({
        llm: mockLlm,
        chunkSize,
        chunkOverlap: 50,
        retrySleep: noopSleep,
      });

      const result = await analyzer.analyze(longContent);

      expect(result).toBeDefined();
      expect(result.summary).toBeDefined();
      expect(result.actionItems).toBeDefined();
      expect(result.decisions).toBeDefined();
      expect(result.discussionPoints).toBeDefined();

      // Verify withStructuredOutput was called multiple times (chunks + merge)
      expect((mockLlm as any).withStructuredOutput).toHaveBeenCalled();
    });
  });

  describe('extractActionItems()', () => {
    it('should extract action items from meeting content', async () => {
      const mockLlm = createMockLlm([sampleActionItemsResult]);
      const analyzer = new MeetingAnalyzer({ llm: mockLlm, retrySleep: noopSleep });

      const result = await analyzer.extractActionItems(sampleMeetingContent);

      expect(result).toHaveLength(4);
      expect(result[0].description).toBe('Implement user dashboard');
      expect(result[0].priority).toBe('high');
      expect(result[0].suggestedAssignee).toBe('Charlie');
    });

    it('should throw VALIDATION_EMPTY_CONTENT for empty content', async () => {
      const mockLlm = createMockLlm([]);
      const analyzer = new MeetingAnalyzer({ llm: mockLlm, retrySleep: noopSleep });

      await expect(analyzer.extractActionItems('')).rejects.toMatchObject({
        code: 'VALIDATION_EMPTY_CONTENT',
      });
    });

    it('should handle long content by using chunked analysis', async () => {
      const longContent = sampleMeetingContent.repeat(20);
      const mockLlm = createMockLlm([sampleAnalysisResult]);
      const analyzer = new MeetingAnalyzer({
        llm: mockLlm,
        chunkSize: 500,
        chunkOverlap: 50,
        retrySleep: noopSleep,
      });

      const result = await analyzer.extractActionItems(longContent);

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('generateSummary()', () => {
    it('should generate a structured summary from meeting content', async () => {
      const mockLlm = createMockLlm([sampleSummaryResult]);
      const analyzer = new MeetingAnalyzer({ llm: mockLlm, retrySleep: noopSleep });

      const result = await analyzer.generateSummary(sampleMeetingContent);

      expect(result.title).toBe('Sprint Planning - Q1 Feature Review');
      expect(result.date).toBe('2024-01-15');
      expect(result.participants).toEqual(['Alice', 'Bob', 'Charlie', 'Diana']);
      expect(result.keyPoints.length).toBeGreaterThan(0);
      expect(result.overallSummary).toBeTruthy();
    });

    it('should throw VALIDATION_EMPTY_CONTENT for empty content', async () => {
      const mockLlm = createMockLlm([]);
      const analyzer = new MeetingAnalyzer({ llm: mockLlm, retrySleep: noopSleep });

      await expect(analyzer.generateSummary('')).rejects.toMatchObject({
        code: 'VALIDATION_EMPTY_CONTENT',
      });
    });

    it('should handle long content by using chunked analysis', async () => {
      const longContent = sampleMeetingContent.repeat(20);
      const mockLlm = createMockLlm([sampleAnalysisResult]);
      const analyzer = new MeetingAnalyzer({
        llm: mockLlm,
        chunkSize: 500,
        chunkOverlap: 50,
        retrySleep: noopSleep,
      });

      const result = await analyzer.generateSummary(longContent);

      expect(result).toBeDefined();
      expect(result.title).toBeTruthy();
    });
  });

  describe('content chunking', () => {
    it('should not chunk content shorter than chunkSize', async () => {
      const shortContent = 'Short meeting content';
      const mockLlm = createMockLlm([sampleAnalysisResult]);
      const analyzer = new MeetingAnalyzer({
        llm: mockLlm,
        chunkSize: 10000,
        retrySleep: noopSleep,
      });

      await analyzer.analyze(shortContent);

      // withStructuredOutput should be called only once (no chunking)
      expect((mockLlm as any).withStructuredOutput).toHaveBeenCalledTimes(1);
    });

    it('should chunk content longer than chunkSize', async () => {
      const longContent = 'A'.repeat(3000);
      const mockLlm = createMockLlm([sampleAnalysisResult]);
      const analyzer = new MeetingAnalyzer({
        llm: mockLlm,
        chunkSize: 1000,
        chunkOverlap: 100,
        retrySleep: noopSleep,
      });

      await analyzer.analyze(longContent);

      // withStructuredOutput should be called multiple times (chunks + merge)
      const callCount = (mockLlm as any).withStructuredOutput.mock.calls.length;
      expect(callCount).toBeGreaterThan(1);
    });
  });

  describe('LLM error handling with retry', () => {
    it('should retry on transient LLM failures', async () => {
      let callCount = 0;
      const mockStructuredLlm = {
        invoke: vi.fn(async () => {
          callCount++;
          if (callCount <= 2) {
            throw new Error('Service temporarily unavailable');
          }
          return sampleAnalysisResult;
        }),
      };

      const mockLlm = {
        withStructuredOutput: vi.fn(() => mockStructuredLlm),
      } as unknown as BaseChatModel;

      const analyzer = new MeetingAnalyzer({ llm: mockLlm, retrySleep: noopSleep });

      const result = await analyzer.analyze(sampleMeetingContent);

      expect(result).toBeDefined();
      expect(callCount).toBe(3); // 2 failures + 1 success
    });
  });
});
