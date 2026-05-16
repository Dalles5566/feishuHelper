/**
 * Unit tests for the NotificationService.
 *
 * Tests cover:
 *   - Message formatting for all notification types
 *   - Successful notification sending via Feishu REST API (node-sdk)
 *   - Failure handling with queue retry
 *   - Edge cases (missing metadata, custom content)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock external dependencies
vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    feishu: { appId: 'test', appSecret: 'test', verificationToken: 'test', encryptKey: '' },
    app: { maxRetries: 3, retryBaseDelayMs: 1000, retryMaxDelayMs: 30000 },
    redis: { host: 'localhost', port: 6379, password: '', db: 0, connectTimeoutMs: 5000 },
    llm: { provider: 'openai', apiKey: 'test', model: 'gpt-4o', maxTokens: 4096, timeoutMs: 60000 },
    database: { host: 'localhost', port: 5432, database: 'test', user: 'test', password: 'test', maxConnections: 5, idleTimeoutMs: 30000, connectionTimeoutMs: 5000 },
  }),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn().mockImplementation(() => ({
    im: {
      v1: {
        message: {
          create: vi.fn().mockResolvedValue({
            code: 0,
            data: { message_id: 'msg_123' },
          }),
        },
      },
    },
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockFeishuClient(shouldThrow = false) {
  return {
    im: {
      v1: {
        message: {
          create: vi.fn().mockImplementation(async () => {
            if (shouldThrow) throw new Error('Network timeout');
            return { code: 0, data: { message_id: 'msg_123' } };
          }),
        },
      },
    },
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
    clientShouldThrow?: boolean;
    addJobShouldThrow?: boolean;
  } = {},
): { service: NotificationService; feishuClient: any; addJobFn: any } {
  const feishuClient = createMockFeishuClient(options.clientShouldThrow);
  const addJobFn = createMockAddJobFn(options.addJobShouldThrow);

  const serviceOptions: NotificationServiceOptions = {
    feishuClient,
    addJobFn,
  };

  const service = new NotificationService(serviceOptions);
  return { service, feishuClient, addJobFn };
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
    it('should send notification via Feishu REST API and return success', async () => {
      const { service, feishuClient } = createService();

      const params: SendNotificationParams = {
        type: 'task_assigned',
        recipientId: 'user_001',
        metadata: { taskTitle: 'Test Task', assignedBy: 'Admin' },
      };

      const result = await service.sendNotification(params);

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('msg_123');
      expect(feishuClient.im.v1.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: 'user_001',
          msg_type: 'text',
          content: expect.any(String),
        },
      });
    });

    it('should use chat_id when chatId is provided', async () => {
      const { service, feishuClient } = createService();

      const params: SendNotificationParams = {
        type: 'state_changed',
        recipientId: 'user_001',
        chatId: 'oc_chat_123',
        metadata: { taskTitle: 'Task', fromState: 'Created', toState: 'Assigned' },
      };

      const result = await service.sendNotification(params);

      expect(result.success).toBe(true);
      expect(feishuClient.im.v1.message.create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_chat_123',
          msg_type: 'text',
          content: expect.any(String),
        },
      });
    });

    it('should use explicit content when provided', async () => {
      const { service, feishuClient } = createService();

      const params: SendNotificationParams = {
        type: 'task_assigned',
        recipientId: 'user_001',
        content: 'Hello, you have a new task!',
      };

      const result = await service.sendNotification(params);

      expect(result.success).toBe(true);
      const callArgs = feishuClient.im.v1.message.create.mock.calls[0][0];
      const parsedContent = JSON.parse(callArgs.data.content);
      expect(parsedContent.text).toBe('Hello, you have a new task!');
    });
  });

  describe('sendNotification - failure and retry', () => {
    it('should re-queue notification on API failure', async () => {
      const { service, addJobFn } = createService({
        clientShouldThrow: true,
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
        clientShouldThrow: true,
        addJobShouldThrow: true,
      });

      const params: SendNotificationParams = {
        type: 'task_assigned',
        recipientId: 'user_003',
      };

      const result = await service.sendNotification(params);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network timeout');
      expect(result.requeued).toBe(false);
      expect(addJobFn).toHaveBeenCalled();
    });
  });
});
