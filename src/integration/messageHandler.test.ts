/**
 * Unit tests for the message handler integration module.
 *
 * Tests the wiring between EventDispatcher, AgentCore, and NotificationService
 * using mocked dependencies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventDispatcher, type FeishuEvent } from '../gateway/webhookGateway.js';
import { registerMessageHandler } from './messageHandler.js';
import type { AgentCore, AgentInput, AgentOutput } from '../agent/agentCore.js';
import type { NotificationService, SendNotificationParams, NotificationResult } from '../services/notification.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockAgentCore(response?: string): AgentCore {
  return {
    processInput: vi.fn().mockResolvedValue({
      actions: [],
      response: response ?? 'Agent response',
    } satisfies AgentOutput),
    initialize: vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn().mockResolvedValue('tool result'),
    getContext: vi.fn(),
    clearContext: vi.fn(),
    getActiveSessions: vi.fn().mockReturnValue([]),
    getRegisteredTools: vi.fn().mockReturnValue([]),
  } as unknown as AgentCore;
}

function createMockNotificationService(): NotificationService {
  return {
    sendNotification: vi.fn().mockResolvedValue({
      success: true,
      messageId: 'msg-response-123',
    } satisfies NotificationResult),
  } as unknown as NotificationService;
}

function createMessageEvent(overrides?: Partial<FeishuEvent>): FeishuEvent {
  return {
    schema: '2.0',
    header: {
      event_id: 'evt-001',
      event_type: 'im.message.receive_v1',
      create_time: '1700000000',
      token: 'test-token',
      app_id: 'test-app',
    },
    event: {
      message: {
        message_id: 'msg-001',
        chat_id: 'chat-001',
        chat_type: 'p2p',
        content: '{"text":"Hello, analyze this meeting"}',
        sender: {
          sender_id: {
            user_id: 'user-001',
            open_id: 'open-001',
          },
        },
      },
      sender: {
        sender_id: {
          user_id: 'user-001',
          open_id: 'open-001',
        },
        sender_type: 'user',
      },
    },
    ...overrides,
  };
}

function createCardActionEvent(overrides?: Partial<FeishuEvent>): FeishuEvent {
  return {
    schema: '2.0',
    header: {
      event_id: 'evt-002',
      event_type: 'card.action.trigger',
      create_time: '1700000001',
      token: 'test-token',
      app_id: 'test-app',
    },
    event: {
      action: {
        tag: 'button',
        value: { action: 'confirm_task', taskId: 'task-001' },
        open_id: 'user-002',
        token: 'action-token',
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerMessageHandler', () => {
  let dispatcher: EventDispatcher;
  let agentCore: ReturnType<typeof createMockAgentCore>;
  let notificationService: ReturnType<typeof createMockNotificationService>;

  beforeEach(() => {
    dispatcher = new EventDispatcher();
    agentCore = createMockAgentCore();
    notificationService = createMockNotificationService();
  });

  it('should register handlers for im.message.receive_v1 and card.action.trigger', () => {
    registerMessageHandler(dispatcher, agentCore, notificationService);

    expect(dispatcher.hasHandler('im.message.receive_v1')).toBe(true);
    expect(dispatcher.hasHandler('card.action.trigger')).toBe(true);
  });

  describe('message event handling', () => {
    it('should call AgentCore.processInput with parsed message content', async () => {
      registerMessageHandler(dispatcher, agentCore, notificationService);

      const event = createMessageEvent();
      await dispatcher.dispatch(event);

      expect(agentCore.processInput).toHaveBeenCalledOnce();
      const input = (agentCore.processInput as ReturnType<typeof vi.fn>).mock.calls[0][0] as AgentInput;
      expect(input.sessionId).toBe('chat-001');
      expect(input.userId).toBe('open-001');
      expect(input.messageType).toBe('text');
      expect(input.content).toBe('Hello, analyze this meeting');
      expect(input.metadata).toEqual({
        messageId: 'msg-001',
        chatId: 'chat-001',
        chatType: 'p2p',
      });
    });

    it('should send notification with agent response after processing', async () => {
      registerMessageHandler(dispatcher, agentCore, notificationService);

      const event = createMessageEvent();
      await dispatcher.dispatch(event);

      expect(notificationService.sendNotification).toHaveBeenCalledOnce();
      const params = (notificationService.sendNotification as ReturnType<typeof vi.fn>).mock.calls[0][0] as SendNotificationParams;
      expect(params.recipientId).toBe('open-001');
      expect(params.chatId).toBe('chat-001');
      expect(params.content).toBe('Agent response');
    });

    it('should not send notification when agent has no response', async () => {
      agentCore = createMockAgentCore(undefined as unknown as string);
      (agentCore.processInput as ReturnType<typeof vi.fn>).mockResolvedValue({
        actions: [],
        response: undefined,
      });

      registerMessageHandler(dispatcher, agentCore, notificationService);

      const event = createMessageEvent();
      await dispatcher.dispatch(event);

      expect(notificationService.sendNotification).not.toHaveBeenCalled();
    });

    it('should handle non-JSON message content gracefully', async () => {
      registerMessageHandler(dispatcher, agentCore, notificationService);

      const event = createMessageEvent();
      event.event.message!.content = 'plain text content';
      await dispatcher.dispatch(event);

      const input = (agentCore.processInput as ReturnType<typeof vi.fn>).mock.calls[0][0] as AgentInput;
      expect(input.content).toBe('plain text content');
    });

    it('should skip processing when message payload is missing', async () => {
      registerMessageHandler(dispatcher, agentCore, notificationService);

      const event = createMessageEvent();
      event.event.message = undefined;
      await dispatcher.dispatch(event);

      expect(agentCore.processInput).not.toHaveBeenCalled();
      expect(notificationService.sendNotification).not.toHaveBeenCalled();
    });
  });

  describe('card action event handling', () => {
    it('should call AgentCore.processInput with callback message type', async () => {
      registerMessageHandler(dispatcher, agentCore, notificationService);

      const event = createCardActionEvent();
      await dispatcher.dispatch(event);

      expect(agentCore.processInput).toHaveBeenCalledOnce();
      const input = (agentCore.processInput as ReturnType<typeof vi.fn>).mock.calls[0][0] as AgentInput;
      expect(input.sessionId).toBe('card-user-002');
      expect(input.userId).toBe('user-002');
      expect(input.messageType).toBe('callback');
      expect(input.content).toBe(JSON.stringify({ action: 'confirm_task', taskId: 'task-001' }));
      expect(input.metadata).toEqual({
        actionTag: 'button',
        actionValue: { action: 'confirm_task', taskId: 'task-001' },
      });
    });

    it('should send notification with agent response for card actions', async () => {
      registerMessageHandler(dispatcher, agentCore, notificationService);

      const event = createCardActionEvent();
      await dispatcher.dispatch(event);

      expect(notificationService.sendNotification).toHaveBeenCalledOnce();
      const params = (notificationService.sendNotification as ReturnType<typeof vi.fn>).mock.calls[0][0] as SendNotificationParams;
      expect(params.recipientId).toBe('user-002');
      expect(params.content).toBe('Agent response');
    });

    it('should skip processing when action payload is missing', async () => {
      registerMessageHandler(dispatcher, agentCore, notificationService);

      const event = createCardActionEvent();
      event.event.action = undefined;
      await dispatcher.dispatch(event);

      expect(agentCore.processInput).not.toHaveBeenCalled();
      expect(notificationService.sendNotification).not.toHaveBeenCalled();
    });

    it('should not send notification when agent has no response for card action', async () => {
      (agentCore.processInput as ReturnType<typeof vi.fn>).mockResolvedValue({
        actions: [],
        response: undefined,
      });

      registerMessageHandler(dispatcher, agentCore, notificationService);

      const event = createCardActionEvent();
      await dispatcher.dispatch(event);

      expect(notificationService.sendNotification).not.toHaveBeenCalled();
    });
  });
});
