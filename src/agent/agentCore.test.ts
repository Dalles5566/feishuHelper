/**
 * Unit tests for AgentCore.
 *
 * Tests cover:
 * - Agent initialization
 * - Input processing and response generation
 * - Tool registration (analyze_meeting, create_feishu_task)
 * - Session context management (create, get, clear, trim)
 * - Error handling for LLM failures
 * - Tool execution flow
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { AgentCore } from './agentCore.js';
import type { AgentInput } from './agentCore.js';
import { AppError } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    feishu: {
      appId: 'test-app-id',
      appSecret: 'test-app-secret',
      verificationToken: 'test-token',
      encryptKey: '',
    },
    llm: {
      provider: 'openai',
      apiKey: 'test-api-key',
      model: 'gpt-4o',
      maxTokens: 4096,
      timeoutMs: 60000,
    },
    redis: {
      host: 'localhost',
      port: 6379,
      password: '',
      db: 0,
      connectTimeoutMs: 5000,
    },
    database: {
      host: 'localhost',
      port: 5432,
      database: 'test',
      user: 'test',
      password: 'test',
      maxConnections: 5,
      idleTimeoutMs: 30000,
      connectionTimeoutMs: 5000,
    },
    app: {
      port: 3000,
      host: '0.0.0.0',
      nodeEnv: 'test',
      logLevel: 'info',
      maxRetries: 3,
      retryBaseDelayMs: 1000,
      retryMaxDelayMs: 30000,
    },
  }),
}));

vi.mock('@larksuiteoapi/node-sdk', () => {
  function MockClient() {
    return {
      task: { v2: { task: { create: vi.fn().mockResolvedValue({ code: 0, data: { task: { guid: 'mock-guid' } } }) } } },
      im: { v1: { message: { create: vi.fn().mockResolvedValue({ code: 0, data: { message_id: 'msg_mock' } }) } } },
    };
  }
  return { Client: MockClient };
});

vi.mock('../services/meetingAnalyzer.js', () => ({
  MeetingAnalyzer: vi.fn().mockImplementation(() => ({
    analyze: vi.fn().mockResolvedValue({
      summary: { title: 'Test Meeting' },
      actionItems: [{ id: '1', description: 'Do something' }],
      decisions: [],
      discussionPoints: [],
    }),
  })),
}));

vi.mock('../utils/db.js', () => ({
  insert: vi.fn().mockResolvedValue({ id: 'meeting-123' }),
  query: vi.fn().mockResolvedValue({ rows: [] }),
  queryOne: vi.fn().mockResolvedValue(null),
  update: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockLlm(response: string = 'Hello! I can help you.') {
  const mockInvoke = vi.fn().mockResolvedValue(
    new AIMessage({ content: response }),
  );

  const mockBindTools = vi.fn().mockReturnValue({
    invoke: mockInvoke,
  });

  return {
    invoke: mockInvoke,
    bindTools: mockBindTools,
    _modelType: () => 'base_chat_model',
    _llmType: () => 'mock',
  } as any;
}

function createMockLlmWithToolCalls(
  toolCalls: Array<{ name: string; args: Record<string, unknown>; id?: string }>,
  finalResponse: string = 'Done!',
) {
  let callCount = 0;

  const mockInvoke = vi.fn().mockImplementation(async () => {
    callCount++;
    if (callCount === 1) {
      return new AIMessage({
        content: '',
        tool_calls: toolCalls,
      });
    }
    return new AIMessage({ content: finalResponse });
  });

  const mockBindTools = vi.fn().mockReturnValue({
    invoke: mockInvoke,
  });

  return {
    invoke: mockInvoke,
    bindTools: mockBindTools,
    _modelType: () => 'base_chat_model',
    _llmType: () => 'mock',
  } as any;
}

function createTestInput(overrides: Partial<AgentInput> = {}): AgentInput {
  return {
    sessionId: 'test-session-1',
    userId: 'user-123',
    messageType: 'text',
    content: 'Hello, analyze this meeting',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentCore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create an instance with default options', () => {
      const agent = new AgentCore({
        llm: createMockLlm(),
      });
      expect(agent).toBeInstanceOf(AgentCore);
    });

    it('should accept custom system prompt', () => {
      const agent = new AgentCore({
        llm: createMockLlm(),
        systemPrompt: 'Custom prompt',
      });
      expect(agent).toBeInstanceOf(AgentCore);
    });

    it('should accept custom max context messages', () => {
      const agent = new AgentCore({
        llm: createMockLlm(),
        maxContextMessages: 10,
      });
      expect(agent).toBeInstanceOf(AgentCore);
    });
  });

  describe('initialize', () => {
    it('should initialize and register tools', async () => {
      const agent = new AgentCore({
        llm: createMockLlm(),
      });

      await agent.initialize();

      const tools = agent.getRegisteredTools();
      expect(tools.length).toBeGreaterThanOrEqual(2);
      const toolNames = tools.map(t => t.name);
      expect(toolNames).toContain('analyze_meeting');
      expect(toolNames).toContain('create_feishu_task');
    });
  });

  describe('processInput', () => {
    it('should process text input and return a response', async () => {
      const mockLlm = createMockLlm('I can help with that!');
      const agent = new AgentCore({ llm: mockLlm });
      await agent.initialize();

      const result = await agent.processInput(createTestInput());

      expect(result.response).toBe('I can help with that!');
      expect(result.actions).toEqual([]);
    });

    it('should handle tool calls from LLM', async () => {
      const mockLlm = createMockLlmWithToolCalls(
        [{ name: 'analyze_meeting', args: { content: 'meeting notes' }, id: 'call_1' }],
        'Analysis complete!',
      );

      const agent = new AgentCore({ llm: mockLlm });
      await agent.initialize();

      const result = await agent.processInput(
        createTestInput({ content: 'Here are my meeting notes' }),
      );

      expect(result.response).toBe('Analysis complete!');
      expect(result.actions.length).toBeGreaterThan(0);
      expect(result.actions[0].type).toBe('tool_call');
    });

    it('should format command messages with prefix', async () => {
      const mockLlm = createMockLlm('Command received');
      const agent = new AgentCore({ llm: mockLlm });
      await agent.initialize();

      await agent.processInput(
        createTestInput({ messageType: 'command', content: '/help' }),
      );

      // Verify the LLM was called (message was formatted and sent)
      expect(mockLlm.bindTools).toHaveBeenCalled();
    });

    it('should format file messages with prefix', async () => {
      const mockLlm = createMockLlm('File processed');
      const agent = new AgentCore({ llm: mockLlm });
      await agent.initialize();

      const result = await agent.processInput(
        createTestInput({ messageType: 'file', content: 'file content here' }),
      );

      expect(result.response).toBe('File processed');
    });

    it('should handle LLM errors with retry', async () => {
      const mockLlm = createMockLlm();
      const mockBindTools = vi.fn().mockReturnValue({
        invoke: vi.fn().mockRejectedValue(new Error('LLM service unavailable')),
      });
      mockLlm.bindTools = mockBindTools;

      const agent = new AgentCore({
        llm: mockLlm,
        retrySleep: async () => {},
      });
      await agent.initialize();

      await expect(
        agent.processInput(createTestInput()),
      ).rejects.toThrow();
    });
  });

  describe('context management', () => {
    it('should create new context for unknown session', () => {
      const agent = new AgentCore({ llm: createMockLlm() });

      const context = agent.getContext('new-session');

      expect(context.sessionId).toBe('new-session');
      expect(context.messages).toEqual([]);
      expect(context.createdAt).toBeDefined();
    });

    it('should return existing context for known session', async () => {
      const agent = new AgentCore({ llm: createMockLlm() });
      await agent.initialize();

      await agent.processInput(createTestInput({ sessionId: 'sess-1' }));
      const context = agent.getContext('sess-1');

      expect(context.messages.length).toBeGreaterThan(0);
    });

    it('should clear context for a session', async () => {
      const agent = new AgentCore({ llm: createMockLlm() });
      await agent.initialize();

      await agent.processInput(createTestInput({ sessionId: 'sess-clear' }));
      agent.clearContext('sess-clear');
      const context = agent.getContext('sess-clear');

      expect(context.messages).toEqual([]);
    });

    it('should list active sessions', async () => {
      const agent = new AgentCore({ llm: createMockLlm() });
      await agent.initialize();

      await agent.processInput(createTestInput({ sessionId: 'sess-a' }));
      await agent.processInput(createTestInput({ sessionId: 'sess-b' }));

      const sessions = agent.getActiveSessions();
      expect(sessions).toContain('sess-a');
      expect(sessions).toContain('sess-b');
    });

    it('should trim context when exceeding max messages', async () => {
      const mockLlm = createMockLlm('ok');
      const agent = new AgentCore({
        llm: mockLlm,
        maxContextMessages: 4,
      });
      await agent.initialize();

      const sessionId = 'trim-session';

      // Send 3 messages (each adds user + AI = 2 messages, total 6 > max 4)
      await agent.processInput(createTestInput({ sessionId, content: 'msg 1' }));
      await agent.processInput(createTestInput({ sessionId, content: 'msg 2' }));
      await agent.processInput(createTestInput({ sessionId, content: 'msg 3' }));

      const context = agent.getContext(sessionId);
      expect(context.messages.length).toBeLessThanOrEqual(4);
    });
  });

  describe('callTool', () => {
    it('should return error for unregistered tools', async () => {
      const agent = new AgentCore({ llm: createMockLlm() });
      await agent.initialize();

      const result = await agent.callTool('nonexistent_tool', { key: 'value' });
      expect(result).toContain('Error');
      expect(result).toContain('nonexistent_tool');
    });
  });

  describe('tool registration', () => {
    it('should register analyze_meeting and create_feishu_task tools', async () => {
      const agent = new AgentCore({ llm: createMockLlm() });
      await agent.initialize();

      const tools = agent.getRegisteredTools();
      const toolNames = tools.map(t => t.name);
      expect(toolNames).toContain('analyze_meeting');
      expect(toolNames).toContain('create_feishu_task');
    });

    it('should have descriptions for all registered tools', async () => {
      const agent = new AgentCore({ llm: createMockLlm() });
      await agent.initialize();

      const tools = agent.getRegisteredTools();
      for (const tool of tools) {
        expect(tool.description).toBeTruthy();
        expect(tool.description.length).toBeGreaterThan(10);
      }
    });
  });
});
