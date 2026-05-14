/**
 * Unit tests for the NotificationService.
 *
 * Tests cover:
 *   - Message formatting for all notification types
 *   - Successful notification sending via FeishuMcpService
 *   - Failure handling with queue retry
 *   - Edge cases (missing metadata, custom content)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock external dependencies that get pulled in transitively
vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    feishu: { appId: 'test', appSecret: 'test', verificationToken: 'test', encryptKey: '' },
    app: { maxRetries: 3, retryBaseDelayMs: 1000, retryMaxDelayMs: 30000 },
    redis: { host: 'localhost', port: 6379, password: '', db: 0, connectTimeoutMs: 5000 },
    llm: { provider: 'openai', apiKey: 'test', model: 'gpt-4o', maxTokens: 4096, timeoutMs: 60000 },
    database: { host: 'localhost', port: 5432, database: 'test', user: 'test', password: 'test', maxConnections: 5, idleTimeoutMs: 30000, connectionTimeoutMs: 5000 },
  }),
}));

vi.mock('@larksuiteoapi/lark-mcp', () => ({
  LarkMcpTool: vi.fn().mockImplementation(() => ({
    getTools: vi.fn().mockReturnValue([]),
    updateUserAccessToken: vi.fn(),
  })),
}));

vi.mock('./feishuAuth.js', () => ({
  FeishuAuthService: vi.fn().mockImplementation(() => ({
    getToken: vi.fn().mockResolvedValue('mock-token'),
  })),
}));

vi.mock('../queue/index.js', () => ({
  addNotificationJob: vi.fn().mockResolvedValue({ id: 'job_mock' }),
}));

import {
  NotificationService,
  formatNotificationMessage,
  type SendNotificationParams,
  type NotificationServiceOptions,
} from './notification.js';
import type { McpToolCallResult } from './feishuMcp.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMockMcpService(callToolResult?: McpToolCallResult, shouldThrow?: Error) {
  return {
    callTool: vi.fn().mockImplementation(async () => {
      if (shouldThrow) throw shouldThrow;
      return (
        callToolResult ?? {
          isError: false,
          content: [{ type: 'text', text: JSON.stringify({ data: { message_id: 'msg_123' } }) }],
        }
      );
    }),
    callToolWithToken: vi.fn(),
    getAvailableTools: vi.fn().mockReturnValue([]),
  } as any;
}

function createMockAddJobFn(shouldThrow = false) {
  return vi.fn().mockImplementation(async () => {
    if (shouldThrow) throw new Error('Queue unavailable');
    return { id: 'job_456' };
  });
}

function createService(
  options: {
    callToolResult?: McpToolCallResult;
    callToolError?: Error;
    addJobShouldThrow?: boolean;
  } = {},
): { service: NotificationService; mcpService: any; addJobFn: any } {
  const mcpService = createMockMcpService(options.callToolResult, options.callToolError);
  const addJobFn = createMockAddJobFn(options.addJobShouldThrow);

  const serviceOptions: NotificationServiceOptions = {
    mcpService,
    addJobFn,
  };

  const service = new NotificationService(serviceOptions);
  return { service, mcpService, addJobFn };
}

// ---------------------------------------------------------------------------
// formatNotificationMessage tests
// ---------------------------------------------------------------------------

describe('formatNotificationMessage', () => {
  it('should return explicit content when provided', () => {
    const result = formatNotificationMessage('task_assigned', {}, 'Custom message');
    expect(result).toBe('Custom message');
  });

  it('should format task_assigned notification', () => {
    const result = formatNotificationMessage('task_assigned', {
      taskTitle: 'Implement login',
      taskId: 'T-001',
      assignedBy: 'Alice',
    });

    expect(result).toContain('New Task Assigned');
    expect(result).toContain('Implement login');
    expect(result).toContain('T-001');
    expect(result).toContain('Alice');
  });

  it('should format state_changed notification', () => {
    const result = formatNotificationMessage('state_changed', {
      taskTitle: 'Fix bug',
      taskId: 'T-002',
      fromState: 'InDevelopment',
      toState: 'VerificationPending',
      reason: 'Developer marked complete',
    });

    expect(result).toContain('Task State Changed');
    expect(result).toContain('Fix bug');
    expect(result).toContain('InDevelopment');
    expect(result).toContain('VerificationPending');
    expect(result).toContain('Developer marked complete');
  });

  it('should format requirement_updated notification', () => {
    const result = formatNotificationMessage('requirement_updated', {
      taskTitle: 'Add search',
      taskId: 'T-003',
      meetingTitle: 'Sprint Planning',
      changes: 'Added pagination requirement',
    });

    expect(result).toContain('Requirement Updated');
    expect(result).toContain('Add search');
    expect(result).toContain('Sprint Planning');
    expect(result).toContain('Added pagination requirement');
  });

  it('should format verification_result notification with passed status', () => {
    const result = formatNotificationMessage('verification_result', {
      taskTitle: 'API endpoint',
      taskId: 'T-004',
      status: 'passed',
      matchScore: 95,
    });

    expect(result).toContain('✅');
    expect(result).toContain('Verification Result');
    expect(result).toContain('API endpoint');
    expect(result).toContain('passed');
    expect(result).toContain('95/100');
  });

  it('should format verification_result notification with failed status', () => {
    const result = formatNotificationMessage('verification_result', {
      taskTitle: 'API endpoint',
      status: 'failed',
      matchScore: 30,
    });

    expect(result).toContain('❌');
    expect(result).toContain('failed');
    expect(result).toContain('30/100');
  });

  it('should format verification_result notification with ambiguous status', () => {
    const result = formatNotificationMessage('verification_result', {
      taskTitle: 'API endpoint',
      status: 'ambiguous',
    });

    expect(result).toContain('⚠️');
    expect(result).toContain('ambiguous');
  });

  it('should handle missing metadata gracefully', () => {
    const result = formatNotificationMessage('task_assigned', undefined);

    expect(result).toContain('New Task Assigned');
    expect(result).toContain('Unknown Task');
    expect(result).toContain('Someone');
  });

  it('should handle state_changed without reason', () => {
    const result = formatNotificationMessage('state_changed', {
      taskTitle: 'Task X',
      fromState: 'Created',
      toState: 'Assigned',
    });

    expect(result).toContain('Created');
    expect(result).toContain('Assigned');
    expect(result).not.toContain('Reason:');
  });

  it('should handle unknown notification type', () => {
    const result = formatNotificationMessage('unknown_type' as any, {});
    expect(result).toContain('Notification: unknown_type');
  });
});

// ---------------------------------------------------------------------------
// NotificationService.sendNotification tests
// ---------------------------------------------------------------------------

describe('NotificationService', () => {
  describe('sendNotification - success', () => {
    it('should send notification via MCP and return success', async () => {
      const { service, mcpService } = createService();

      const params: SendNotificationParams = {
        type: 'task_assigned',
        recipientId: 'user_001',
        metadata: { taskTitle: 'Test Task', assignedBy: 'Admin' },
      };

      const result = await service.sendNotification(params);

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('msg_123');
      expect(mcpService.callTool).toHaveBeenCalledWith('im_send_message', {
        receive_id_type: 'user_id',
        receive_id: 'user_001',
        msg_type: 'text',
        content: expect.any(String),
      });
    });

    it('should use chat_id when chatId is provided', async () => {
      const { service, mcpService } = createService();

      const params: SendNotificationParams = {
        type: 'state_changed',
        recipientId: 'user_001',
        chatId: 'oc_chat_123',
        metadata: { taskTitle: 'Task', fromState: 'Created', toState: 'Assigned' },
      };

      const result = await service.sendNotification(params);

      expect(result.success).toBe(true);
      expect(mcpService.callTool).toHaveBeenCalledWith('im_send_message', {
        receive_id_type: 'chat_id',
        receive_id: 'oc_chat_123',
        msg_type: 'text',
        content: expect.any(String),
      });
    });

    it('should use explicit content when provided', async () => {
      const { service, mcpService } = createService();

      const params: SendNotificationParams = {
        type: 'task_assigned',
        recipientId: 'user_001',
        content: 'Hello, you have a new task!',
      };

      const result = await service.sendNotification(params);

      expect(result.success).toBe(true);
      const callArgs = mcpService.callTool.mock.calls[0][1];
      const parsedContent = JSON.parse(callArgs.content);
      expect(parsedContent.text).toBe('Hello, you have a new task!');
    });

    it('should handle response without message_id gracefully', async () => {
      const { service } = createService({
        callToolResult: {
          isError: false,
          content: [{ type: 'text', text: '{}' }],
        },
      });

      const params: SendNotificationParams = {
        type: 'task_assigned',
        recipientId: 'user_001',
      };

      const result = await service.sendNotification(params);

      expect(result.success).toBe(true);
      expect(result.messageId).toBeUndefined();
    });

    it('should handle non-JSON response content gracefully', async () => {
      const { service } = createService({
        callToolResult: {
          isError: false,
          content: [{ type: 'text', text: 'not json' }],
        },
      });

      const params: SendNotificationParams = {
        type: 'task_assigned',
        recipientId: 'user_001',
      };

      const result = await service.sendNotification(params);

      expect(result.success).toBe(true);
      expect(result.messageId).toBeUndefined();
    });
  });

  describe('sendNotification - failure and retry', () => {
    it('should re-queue notification on MCP failure', async () => {
      const { service, addJobFn } = createService({
        callToolError: new Error('Network timeout'),
      });

      const params: SendNotificationParams = {
        type: 'requirement_updated',
        recipientId: 'user_002',
        metadata: { taskTitle: 'Task Y', meetingTitle: 'Meeting Z' },
      };

      const result = await service.sendNotification(params);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network timeout');
      expect(result.requeued).toBe(true);
      expect(addJobFn).toHaveBeenCalledWith({
        type: 'requirement_updated',
        recipientId: 'user_002',
        chatId: undefined,
        content: expect.stringContaining('Requirement Updated'),
        metadata: { taskTitle: 'Task Y', meetingTitle: 'Meeting Z' },
      });
    });

    it('should report requeued=false when re-queuing also fails', async () => {
      const { service, addJobFn } = createService({
        callToolError: new Error('MCP down'),
        addJobShouldThrow: true,
      });

      const params: SendNotificationParams = {
        type: 'task_assigned',
        recipientId: 'user_003',
      };

      const result = await service.sendNotification(params);

      expect(result.success).toBe(false);
      expect(result.error).toContain('MCP down');
      expect(result.requeued).toBe(false);
      expect(addJobFn).toHaveBeenCalled();
    });

    it('should include AppError message in error field', async () => {
      const { AppError } = await import('../utils/errors.js');
      const appError = AppError.feishuApi(
        'FEISHU_API_TIMEOUT',
        'Request timed out after 30s',
      );

      const { service } = createService({
        callToolError: appError,
      });

      const params: SendNotificationParams = {
        type: 'verification_result',
        recipientId: 'user_004',
        metadata: { taskTitle: 'Task', status: 'passed' },
      };

      const result = await service.sendNotification(params);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Request timed out after 30s');
      expect(result.requeued).toBe(true);
    });
  });

  describe('sendNotification - all notification types', () => {
    it('should send task_assigned notification', async () => {
      const { service, mcpService } = createService();

      await service.sendNotification({
        type: 'task_assigned',
        recipientId: 'user_001',
        metadata: { taskTitle: 'Build API', taskId: 'T-100', assignedBy: 'PM' },
      });

      const callArgs = mcpService.callTool.mock.calls[0][1];
      const parsedContent = JSON.parse(callArgs.content);
      expect(parsedContent.text).toContain('New Task Assigned');
      expect(parsedContent.text).toContain('Build API');
    });

    it('should send state_changed notification', async () => {
      const { service, mcpService } = createService();

      await service.sendNotification({
        type: 'state_changed',
        recipientId: 'user_001',
        metadata: {
          taskTitle: 'Deploy',
          fromState: 'QAPending',
          toState: 'QAPassed',
        },
      });

      const callArgs = mcpService.callTool.mock.calls[0][1];
      const parsedContent = JSON.parse(callArgs.content);
      expect(parsedContent.text).toContain('Task State Changed');
      expect(parsedContent.text).toContain('QAPending');
      expect(parsedContent.text).toContain('QAPassed');
    });

    it('should send requirement_updated notification', async () => {
      const { service, mcpService } = createService();

      await service.sendNotification({
        type: 'requirement_updated',
        recipientId: 'user_001',
        metadata: {
          taskTitle: 'Search Feature',
          meetingTitle: 'Sprint Review',
          changes: 'Added filter support',
        },
      });

      const callArgs = mcpService.callTool.mock.calls[0][1];
      const parsedContent = JSON.parse(callArgs.content);
      expect(parsedContent.text).toContain('Requirement Updated');
      expect(parsedContent.text).toContain('Added filter support');
    });

    it('should send verification_result notification', async () => {
      const { service, mcpService } = createService();

      await service.sendNotification({
        type: 'verification_result',
        recipientId: 'user_001',
        metadata: {
          taskTitle: 'Auth Module',
          status: 'passed',
          matchScore: 88,
        },
      });

      const callArgs = mcpService.callTool.mock.calls[0][1];
      const parsedContent = JSON.parse(callArgs.content);
      expect(parsedContent.text).toContain('✅');
      expect(parsedContent.text).toContain('88/100');
    });
  });
});
