/**
 * Unit tests for AgentCore.
 *
 * Tests cover:
 * - Agent initialization with different LLM providers
 * - Input processing and response generation
 * - Tool registration from Feishu MCP
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

vi.mock('../services/feishuMcp.js', () => ({
  FeishuMcpService: vi.fn().mockImplementation(() => ({
    getAvailableTools: vi.fn().mockReturnValue([]),
    callTool: vi.fn().mockResolvedValue({
      isError: false,
      content: [{ type: 'text', text: 'tool result' }],
    }),
  })),
}));

vi.mock('../services/feishuAuth.js', () => ({
  FeishuAuthService: vi.fn().mockImplementation(() => ({
    getToken: vi.fn().mockResolvedValue('mock-token'),
    disconnect: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@larksuiteoapi/lark-mcp', () => ({
  LarkMcpTool: vi.fn().mockImplementation(() => ({
    getTools: vi.fn().mockReturnValue([]),
    updateUserAccessToken: vi.fn(),
  })),
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
  toolCalls: Array<{ name: string; args: Record<string, unknown>; id: string }>,
  finalResponse: string = 'Done!',
) {
  let callCount = 0;

  const mockInvoke = vi.fn().mockImplementation(async () => {
    callCount++;
    if (callCount === 1) {
      // First call returns tool calls
      return new AIMessage({
        content: '',
        tool_calls: toolCalls,
      });
    }
    // Subsequent calls return final response
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

function createMockMcpService(tools: any[] = []) {
  return {
    getAvailableTools: vi.fn().mockReturnValue(tools),
    callTool: vi.fn().mockResolvedValue({
      isError: false,
      content: [{ type: 'text', text: '{"success": true}' }],
    }),
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
        mcpService: createMockMcpService(),
      });
      expect(agent).toBeInstanceOf(AgentCore);
    });

    it('should accept custom system prompt', () => {
      const agent = new AgentCore({
        llm: createMockLlm(),
        mcpService: createMockMcpService(),
        systemPrompt: 'Custom prompt',
      });
      expect(agent).toBeInstanceOf(AgentCore);
    });

    it('should accept custom max context messages', () => {
      const agent = new AgentCore({
        llm: createMockLlm(),
        mcpService: createMockMcpService(),
        maxContextMessages: 10,
      });
      expect(agent).toBeInstanceOf(AgentCore);
    });
  });

  describe('initialize', () => {
    it('should initialize with provided LLM and register tools', async () => {
      const mcpService = createMockMcpService([
        { name: 'task_create', description: 'Create a task', schema: {} },
      ]);
      const agent = new AgentCore({
        llm: createMockLlm(),
        mcpService,
      });

      await agent.initialize();

      const tools = agent.getRegisteredTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('task_create');
    });

    it('should register multiple MCP tools', async () => {
      const mcpService = createMockMcpService([
        { name: 'task_create', description: 'Create a task', schema: {} },
        { name: 'im_send_message', description: 'Send a message', schema: {} },
        { name: 'doc_get', description: 'Get document', schema: {} },
      ]);
      const agent = new AgentCore({
        llm: createMockLlm(),
        mcpService,
      });

      await agent.initialize();

      const tools = agent.getRegisteredTools();
      expect(tools).toHaveLength(3);
      expect(tools.map((t) => t.name)).toEqual(['task_create', 'im_send_message', 'doc_get']);
    });

    it('should handle empty tools list', async () => {
      const mcpService = createMockMcpService([]);
      const agent = new AgentCore({
        llm: createMockLlm(),
        mcpService,
      });

      await agent.initialize();

      const tools = agent.getRegisteredTools();
      expect(tools).toHaveLength(0);
    });
  });

  describe('processInput', () => {
    it('should process text input and return LLM response', async () => {
      const mockLlm = createMockLlm('I will analyze the meeting for you.');
      const agent = new AgentCore({
        llm: mockLlm,
        mcpService: createMockMcpService(),
      });
      await agent.initialize();

      const input = createTestInput({ content: 'Analyze this meeting' });
      const output = await agent.processInput(input);

      expect(output.response).toBe('I will analyze the meeting for you.');
      expect(output.actions).toEqual([]);
    });

    it('should handle command message type', async () => {
      const mockLlm = createMockLlm('Command received.');
      const agent = new AgentCore({
        llm: mockLlm,
        mcpService: createMockMcpService(),
      });
      await agent.initialize();

      const input = createTestInput({ messageType: 'command', content: '/status' });
      const output = await agent.processInput(input);

      expect(output.response).toBe('Command received.');
      // Verify the LLM was invoked (no tools registered, so invoke is called directly)
      expect(mockLlm.invoke).toHaveBeenCalled();
    });

    it('should handle file message type', async () => {
      const mockLlm = createMockLlm('File processed.');
      const agent = new AgentCore({
        llm: mockLlm,
        mcpService: createMockMcpService(),
      });
      await agent.initialize();

      const input = createTestInput({ messageType: 'file', content: 'file content here' });
      const output = await agent.processInput(input);

      expect(output.response).toBe('File processed.');
    });

    it('should execute tool calls and return actions', async () => {
      const mockLlm = createMockLlmWithToolCalls(
        [{ name: 'task_create', args: { params: { title: 'New Task' } }, id: 'call-1' }],
        'Task created successfully!',
      );

      const mcpService = createMockMcpService([
        { name: 'task_create', description: 'Create a task', schema: {} },
      ]);

      const agent = new AgentCore({
        llm: mockLlm,
        mcpService,
        retrySleep: async () => {},
      });
      await agent.initialize();

      const input = createTestInput({ content: 'Create a task for the login feature' });
      const output = await agent.processInput(input);

      expect(output.response).toBe('Task created successfully!');
      expect(output.actions).toHaveLength(1);
      expect(output.actions[0].type).toBe('tool_call');
      expect((output.actions[0] as any).toolName).toBe('task_create');
    });

    it('should handle LLM errors gracefully', async () => {
      const mockLlm = {
        invoke: vi.fn().mockRejectedValue(new Error('Service unavailable')),
        bindTools: vi.fn().mockReturnValue({
          invoke: vi.fn().mockRejectedValue(new Error('Service unavailable')),
        }),
        _modelType: () => 'base_chat_model',
        _llmType: () => 'mock',
      } as any;

      const agent = new AgentCore({
        llm: mockLlm,
        mcpService: createMockMcpService(),
        retrySleep: async () => {},
      });
      await agent.initialize();

      const input = createTestInput();
      await expect(agent.processInput(input)).rejects.toThrow(AppError);
    });

    it('should maintain conversation context across multiple inputs', async () => {
      const mockLlm = createMockLlm('Response');
      const agent = new AgentCore({
        llm: mockLlm,
        mcpService: createMockMcpService(),
      });
      await agent.initialize();

      const sessionId = 'session-multi';
      await agent.processInput(createTestInput({ sessionId, content: 'First message' }));
      await agent.processInput(createTestInput({ sessionId, content: 'Second message' }));

      const context = agent.getContext(sessionId);
      // Should have 2 user messages + 2 AI responses = 4 messages
      expect(context.messages).toHaveLength(4);
      expect(context.messages[0]).toBeInstanceOf(HumanMessage);
      expect(context.messages[1]).toBeInstanceOf(AIMessage);
      expect(context.messages[2]).toBeInstanceOf(HumanMessage);
      expect(context.messages[3]).toBeInstanceOf(AIMessage);
    });
  });

  describe('getContext', () => {
    it('should create a new context for unknown session', () => {
      const agent = new AgentCore({
        llm: createMockLlm(),
        mcpService: createMockMcpService(),
      });

      const context = agent.getContext('new-session');

      expect(context.sessionId).toBe('new-session');
      expect(context.messages).toEqual([]);
      expect(context.createdAt).toBeDefined();
      expect(context.lastActiveAt).toBeDefined();
    });

    it('should return existing context for known session', () => {
      const agent = new AgentCore({
        llm: createMockLlm(),
        mcpService: createMockMcpService(),
      });

      const context1 = agent.getContext('session-1');
      context1.messages.push(new HumanMessage('test'));

      const context2 = agent.getContext('session-1');
      expect(context2.messages).toHaveLength(1);
      expect(context2).toBe(context1);
    });

    it('should maintain separate contexts for different sessions', () => {
      const agent = new AgentCore({
        llm: createMockLlm(),
        mcpService: createMockMcpService(),
      });

      const ctx1 = agent.getContext('session-a');
      const ctx2 = agent.getContext('session-b');

      ctx1.messages.push(new HumanMessage('msg for a'));

      expect(ctx1.messages).toHaveLength(1);
      expect(ctx2.messages).toHaveLength(0);
    });
  });

  describe('clearContext', () => {
    it('should remove session context', () => {
      const agent = new AgentCore({
        llm: createMockLlm(),
        mcpService: createMockMcpService(),
      });

      const context = agent.getContext('session-to-clear');
      context.messages.push(new HumanMessage('test'));

      agent.clearContext('session-to-clear');

      // Getting context again should create a fresh one
      const newContext = agent.getContext('session-to-clear');
      expect(newContext.messages).toHaveLength(0);
    });

    it('should not throw when clearing non-existent session', () => {
      const agent = new AgentCore({
        llm: createMockLlm(),
        mcpService: createMockMcpService(),
      });

      expect(() => agent.clearContext('non-existent')).not.toThrow();
    });
  });

  describe('getActiveSessions', () => {
    it('should return empty array when no sessions exist', () => {
      const agent = new AgentCore({
        llm: createMockLlm(),
        mcpService: createMockMcpService(),
      });

      expect(agent.getActiveSessions()).toEqual([]);
    });

    it('should return all active session IDs', () => {
      const agent = new AgentCore({
        llm: createMockLlm(),
        mcpService: createMockMcpService(),
      });

      agent.getContext('session-1');
      agent.getContext('session-2');
      agent.getContext('session-3');

      const sessions = agent.getActiveSessions();
      expect(sessions).toHaveLength(3);
      expect(sessions).toContain('session-1');
      expect(sessions).toContain('session-2');
      expect(sessions).toContain('session-3');
    });
  });

  describe('context trimming', () => {
    it('should trim context when exceeding max messages', async () => {
      const mockLlm = createMockLlm('Response');
      const agent = new AgentCore({
        llm: mockLlm,
        mcpService: createMockMcpService(),
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
    it('should call a registered tool directly', async () => {
      const mcpService = createMockMcpService([
        { name: 'im_send', description: 'Send message', schema: {} },
      ]);

      const agent = new AgentCore({
        llm: createMockLlm(),
        mcpService,
      });
      await agent.initialize();

      const result = await agent.callTool('im_send', { chat_id: 'abc', text: 'hello' });
      expect(result).toContain('success');
    });

    it('should fall back to direct MCP call for unregistered tools', async () => {
      const mcpService = createMockMcpService([]);
      const agent = new AgentCore({
        llm: createMockLlm(),
        mcpService,
      });
      await agent.initialize();

      const result = await agent.callTool('some_tool', { key: 'value' });
      expect(typeof result).toBe('string');
    });

    it('should handle tool execution errors gracefully', async () => {
      const mcpService = {
        getAvailableTools: vi.fn().mockReturnValue([]),
        callTool: vi.fn().mockRejectedValue(new Error('Tool failed')),
      } as any;

      const agent = new AgentCore({
        llm: createMockLlm(),
        mcpService,
      });
      await agent.initialize();

      const result = await agent.callTool('failing_tool', {});
      expect(result).toContain('Error');
    });
  });

  describe('tool registration', () => {
    it('should create DynamicStructuredTool for each MCP tool', async () => {
      const mcpService = createMockMcpService([
        { name: 'task_create', description: 'Create a Feishu task', schema: {} },
        { name: 'im_send_message', description: 'Send a message via IM', schema: {} },
      ]);

      const agent = new AgentCore({
        llm: createMockLlm(),
        mcpService,
      });
      await agent.initialize();

      const tools = agent.getRegisteredTools();
      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('task_create');
      expect(tools[0].description).toBe('Create a Feishu task');
      expect(tools[1].name).toBe('im_send_message');
      expect(tools[1].description).toBe('Send a message via IM');
    });

    it('should use default description when MCP tool has no description', async () => {
      const mcpService = createMockMcpService([
        { name: 'unknown_tool', description: '', schema: {} },
      ]);

      const agent = new AgentCore({
        llm: createMockLlm(),
        mcpService,
      });
      await agent.initialize();

      const tools = agent.getRegisteredTools();
      expect(tools[0].description).toContain('Feishu MCP tool: unknown_tool');
    });
  });
});
