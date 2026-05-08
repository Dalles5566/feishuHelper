/**
 * Unit tests for FeishuMcpService.
 *
 * Tests cover:
 * - MCP client initialization
 * - Tool call with unified error handling
 * - Rate limiting detection and retry via exponential backoff
 * - Authentication token integration
 * - Error classification
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuMcpService } from './feishuMcp.js';
import { AppError, FeishuErrorCodes } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock getConfig
vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    feishu: {
      appId: 'test-app-id',
      appSecret: 'test-app-secret',
      verificationToken: 'test-token',
      encryptKey: '',
    },
    app: {
      maxRetries: 3,
      retryBaseDelayMs: 1000,
      retryMaxDelayMs: 30000,
    },
    redis: {
      host: 'localhost',
      port: 6379,
      password: '',
      db: 0,
      connectTimeoutMs: 5000,
    },
    llm: {
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-4o',
      maxTokens: 4096,
      timeoutMs: 60000,
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
  }),
}));

// Mock FeishuAuthService
vi.mock('./feishuAuth.js', () => ({
  FeishuAuthService: vi.fn().mockImplementation(() => ({
    getToken: vi.fn().mockResolvedValue('mock-tenant-token'),
    forceRefresh: vi.fn().mockResolvedValue('mock-refreshed-token'),
    disconnect: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock LarkMcpTool
vi.mock('@larksuiteoapi/lark-mcp', () => ({
  LarkMcpTool: vi.fn().mockImplementation(() => ({
    getTools: vi.fn().mockReturnValue([]),
    updateUserAccessToken: vi.fn(),
    registerMcpServer: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockMcpTool(tools: any[] = []) {
  return {
    getTools: vi.fn().mockReturnValue(tools),
    updateUserAccessToken: vi.fn(),
    registerMcpServer: vi.fn(),
  } as any;
}

function createMockAuthService(token = 'mock-token') {
  return {
    getToken: vi.fn().mockResolvedValue(token),
    forceRefresh: vi.fn().mockResolvedValue('refreshed-token'),
    disconnect: vi.fn().mockResolvedValue(undefined),
    invalidateCache: vi.fn().mockResolvedValue(undefined),
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FeishuMcpService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create an instance with default options', () => {
      const service = new FeishuMcpService({
        authService: createMockAuthService(),
        mcpTool: createMockMcpTool(),
      });
      expect(service).toBeInstanceOf(FeishuMcpService);
    });

    it('should accept custom auth service and mcp tool', () => {
      const authService = createMockAuthService();
      const mcpTool = createMockMcpTool();

      const service = new FeishuMcpService({ authService, mcpTool });
      expect(service).toBeInstanceOf(FeishuMcpService);
    });
  });

  describe('getAvailableTools', () => {
    it('should return the list of tools from the MCP client', () => {
      const mockTools = [
        { name: 'im_send_message', project: 'im', description: 'Send a message', schema: {} },
        { name: 'task_create', project: 'task', description: 'Create a task', schema: {} },
      ];
      const mcpTool = createMockMcpTool(mockTools);
      const service = new FeishuMcpService({
        authService: createMockAuthService(),
        mcpTool,
      });

      const tools = service.getAvailableTools();
      expect(tools).toEqual(mockTools);
      expect(tools).toHaveLength(2);
    });

    it('should return empty array when no tools are available', () => {
      const mcpTool = createMockMcpTool([]);
      const service = new FeishuMcpService({
        authService: createMockAuthService(),
        mcpTool,
      });

      const tools = service.getAvailableTools();
      expect(tools).toEqual([]);
    });
  });

  describe('callTool', () => {
    it('should successfully call a tool and return the result', async () => {
      const mockHandler = vi.fn().mockResolvedValue({
        isError: false,
        content: [{ type: 'text', text: '{"task_id": "123"}' }],
      });

      const mockTools = [
        {
          name: 'task_create',
          project: 'task',
          description: 'Create a task',
          schema: {},
          customHandler: mockHandler,
        },
      ];

      const authService = createMockAuthService();
      const mcpTool = createMockMcpTool(mockTools);
      const service = new FeishuMcpService({
        authService,
        mcpTool,
        retryOptions: { sleep: async () => {} },
      });

      const result = await service.callTool('task_create', { title: 'Test Task' });

      expect(result.isError).toBe(false);
      expect(result.content).toEqual([{ type: 'text', text: '{"task_id": "123"}' }]);
      expect(authService.getToken).toHaveBeenCalled();
      expect(mcpTool.updateUserAccessToken).toHaveBeenCalledWith('mock-token');
    });

    it('should throw AppError when tool is not found', async () => {
      const mcpTool = createMockMcpTool([]);
      const service = new FeishuMcpService({
        authService: createMockAuthService(),
        mcpTool,
        retryOptions: { sleep: async () => {} },
      });

      await expect(service.callTool('nonexistent_tool', {})).rejects.toThrow(AppError);
      await expect(service.callTool('nonexistent_tool', {})).rejects.toMatchObject({
        code: FeishuErrorCodes.NOT_FOUND,
        category: 'feishu_api',
      });
    });

    it('should throw AppError when auth token retrieval fails', async () => {
      const authService = {
        getToken: vi.fn().mockRejectedValue(new Error('Redis connection failed')),
        forceRefresh: vi.fn(),
        disconnect: vi.fn(),
        invalidateCache: vi.fn(),
      } as any;

      const mcpTool = createMockMcpTool([
        { name: 'test_tool', project: 'test', description: 'Test', schema: {}, customHandler: vi.fn() },
      ]);

      const service = new FeishuMcpService({
        authService,
        mcpTool,
        retryOptions: { sleep: async () => {} },
      });

      await expect(service.callTool('test_tool', {})).rejects.toMatchObject({
        code: FeishuErrorCodes.AUTH_FAILED,
        category: 'feishu_api',
      });
    });

    it('should classify rate limit errors and retry', async () => {
      let callCount = 0;
      const mockHandler = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Rate limit exceeded: too many requests (429)' }],
          };
        }
        return {
          isError: false,
          content: [{ type: 'text', text: 'success' }],
        };
      });

      const mockTools = [
        {
          name: 'im_send',
          project: 'im',
          description: 'Send message',
          schema: {},
          customHandler: mockHandler,
        },
      ];

      const service = new FeishuMcpService({
        authService: createMockAuthService(),
        mcpTool: createMockMcpTool(mockTools),
        retryOptions: { sleep: async () => {} },
      });

      const result = await service.callTool('im_send', { chat_id: 'abc' });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toBe('success');
      expect(callCount).toBe(3);
    });

    it('should throw after exhausting retries on persistent rate limiting', async () => {
      const mockHandler = vi.fn().mockResolvedValue({
        isError: true,
        content: [{ type: 'text', text: 'Rate limit exceeded: too many requests (429)' }],
      });

      const mockTools = [
        {
          name: 'im_send',
          project: 'im',
          description: 'Send message',
          schema: {},
          customHandler: mockHandler,
        },
      ];

      const service = new FeishuMcpService({
        authService: createMockAuthService(),
        mcpTool: createMockMcpTool(mockTools),
        retryOptions: { sleep: async () => {} },
      });

      await expect(service.callTool('im_send', {})).rejects.toMatchObject({
        code: FeishuErrorCodes.RATE_LIMITED,
        category: 'feishu_api',
        retryable: true,
      });
    });

    it('should classify auth errors correctly', async () => {
      const mockHandler = vi.fn().mockResolvedValue({
        isError: true,
        content: [{ type: 'text', text: 'Unauthorized: invalid token (401)' }],
      });

      const mockTools = [
        {
          name: 'task_get',
          project: 'task',
          description: 'Get task',
          schema: {},
          customHandler: mockHandler,
        },
      ];

      const service = new FeishuMcpService({
        authService: createMockAuthService(),
        mcpTool: createMockMcpTool(mockTools),
        retryOptions: { sleep: async () => {} },
      });

      await expect(service.callTool('task_get', {})).rejects.toMatchObject({
        code: FeishuErrorCodes.AUTH_FAILED,
        category: 'feishu_api',
      });
    });

    it('should classify not-found errors correctly', async () => {
      const mockHandler = vi.fn().mockResolvedValue({
        isError: true,
        content: [{ type: 'text', text: 'Resource not found (404)' }],
      });

      const mockTools = [
        {
          name: 'doc_get',
          project: 'doc',
          description: 'Get doc',
          schema: {},
          customHandler: mockHandler,
        },
      ];

      const service = new FeishuMcpService({
        authService: createMockAuthService(),
        mcpTool: createMockMcpTool(mockTools),
        retryOptions: { sleep: async () => {} },
      });

      await expect(service.callTool('doc_get', {})).rejects.toMatchObject({
        code: FeishuErrorCodes.NOT_FOUND,
        category: 'feishu_api',
      });
    });

    it('should classify timeout errors correctly', async () => {
      const mockHandler = vi.fn().mockResolvedValue({
        isError: true,
        content: [{ type: 'text', text: 'Request timed out: ETIMEDOUT' }],
      });

      const mockTools = [
        {
          name: 'doc_get',
          project: 'doc',
          description: 'Get doc',
          schema: {},
          customHandler: mockHandler,
        },
      ];

      const service = new FeishuMcpService({
        authService: createMockAuthService(),
        mcpTool: createMockMcpTool(mockTools),
        retryOptions: { sleep: async () => {} },
      });

      await expect(service.callTool('doc_get', {})).rejects.toMatchObject({
        code: FeishuErrorCodes.TIMEOUT,
        category: 'feishu_api',
      });
    });

    it('should handle unexpected exceptions from tool handler', async () => {
      const mockHandler = vi.fn().mockRejectedValue(new Error('Network error'));

      const mockTools = [
        {
          name: 'task_create',
          project: 'task',
          description: 'Create task',
          schema: {},
          customHandler: mockHandler,
        },
      ];

      const service = new FeishuMcpService({
        authService: createMockAuthService(),
        mcpTool: createMockMcpTool(mockTools),
        retryOptions: { sleep: async () => {} },
      });

      await expect(service.callTool('task_create', {})).rejects.toMatchObject({
        code: FeishuErrorCodes.UNEXPECTED,
        category: 'feishu_api',
      });
    });

    it('should throw for tools without a custom handler', async () => {
      const mockTools = [
        {
          name: 'no_handler_tool',
          project: 'test',
          description: 'No handler',
          schema: {},
          // No customHandler
        },
      ];

      const service = new FeishuMcpService({
        authService: createMockAuthService(),
        mcpTool: createMockMcpTool(mockTools),
        retryOptions: { sleep: async () => {} },
      });

      await expect(service.callTool('no_handler_tool', {})).rejects.toMatchObject({
        code: FeishuErrorCodes.UNEXPECTED,
        message: expect.stringContaining('does not have a callable handler'),
      });
    });
  });

  describe('callToolWithToken', () => {
    it('should call tool with a pre-fetched token', async () => {
      const mockHandler = vi.fn().mockResolvedValue({
        isError: false,
        content: [{ type: 'text', text: 'ok' }],
      });

      const mockTools = [
        {
          name: 'im_send',
          project: 'im',
          description: 'Send',
          schema: {},
          customHandler: mockHandler,
        },
      ];

      const mcpTool = createMockMcpTool(mockTools);
      const authService = createMockAuthService();
      const service = new FeishuMcpService({
        authService,
        mcpTool,
        retryOptions: { sleep: async () => {} },
      });

      const result = await service.callToolWithToken('im_send', { text: 'hi' }, 'custom-token');

      expect(result.isError).toBe(false);
      expect(mcpTool.updateUserAccessToken).toHaveBeenCalledWith('custom-token');
      // Should NOT call authService.getToken since token is provided
      expect(authService.getToken).not.toHaveBeenCalled();
    });

    it('should throw when tool not found with pre-fetched token', async () => {
      const service = new FeishuMcpService({
        authService: createMockAuthService(),
        mcpTool: createMockMcpTool([]),
        retryOptions: { sleep: async () => {} },
      });

      await expect(
        service.callToolWithToken('missing_tool', {}, 'token'),
      ).rejects.toMatchObject({
        code: FeishuErrorCodes.NOT_FOUND,
      });
    });
  });

  describe('error classification', () => {
    it('should classify generic errors as UNEXPECTED', async () => {
      const mockHandler = vi.fn().mockResolvedValue({
        isError: true,
        content: [{ type: 'text', text: 'Something went wrong internally' }],
      });

      const mockTools = [
        {
          name: 'test_tool',
          project: 'test',
          description: 'Test',
          schema: {},
          customHandler: mockHandler,
        },
      ];

      const service = new FeishuMcpService({
        authService: createMockAuthService(),
        mcpTool: createMockMcpTool(mockTools),
        retryOptions: { sleep: async () => {} },
      });

      await expect(service.callTool('test_tool', {})).rejects.toMatchObject({
        code: FeishuErrorCodes.UNEXPECTED,
        category: 'feishu_api',
      });
    });
  });
});
