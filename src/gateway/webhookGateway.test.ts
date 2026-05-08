/**
 * Unit tests for the Webhook Gateway module.
 *
 * Tests cover:
 * - Signature verification (verifySignature)
 * - URL Challenge handling (handleChallenge)
 * - Event dispatching (EventDispatcher)
 * - Fastify route integration (registerWebhookGateway)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import {
  verifySignature,
  handleChallenge,
  EventDispatcher,
  registerWebhookGateway,
  type FeishuEvent,
  type WebhookGatewayConfig,
} from './webhookGateway.js';

// ---------------------------------------------------------------------------
// verifySignature
// ---------------------------------------------------------------------------

describe('verifySignature', () => {
  const encryptKey = 'test-encrypt-key';
  const timestamp = '1234567890';
  const nonce = 'abc123';
  const body = '{"hello":"world"}';

  function computeExpectedSignature(ts: string, n: string, key: string, b: string): string {
    const content = ts + n + key + b;
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  it('should return true for a valid signature', () => {
    const signature = computeExpectedSignature(timestamp, nonce, encryptKey, body);
    expect(verifySignature(timestamp, nonce, encryptKey, body, signature)).toBe(true);
  });

  it('should return false for an invalid signature', () => {
    const invalidSignature = 'a'.repeat(64);
    expect(verifySignature(timestamp, nonce, encryptKey, body, invalidSignature)).toBe(false);
  });

  it('should return false when timestamp is empty', () => {
    const signature = computeExpectedSignature(timestamp, nonce, encryptKey, body);
    expect(verifySignature('', nonce, encryptKey, body, signature)).toBe(false);
  });

  it('should return false when nonce is empty', () => {
    const signature = computeExpectedSignature(timestamp, nonce, encryptKey, body);
    expect(verifySignature(timestamp, '', encryptKey, body, signature)).toBe(false);
  });

  it('should return false when signature is empty', () => {
    expect(verifySignature(timestamp, nonce, encryptKey, body, '')).toBe(false);
  });

  it('should return false for a signature with wrong length', () => {
    expect(verifySignature(timestamp, nonce, encryptKey, body, 'short')).toBe(false);
  });

  it('should handle different body content correctly', () => {
    const differentBody = '{"different":"content"}';
    const signature = computeExpectedSignature(timestamp, nonce, encryptKey, differentBody);
    expect(verifySignature(timestamp, nonce, encryptKey, differentBody, signature)).toBe(true);
    expect(verifySignature(timestamp, nonce, encryptKey, body, signature)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleChallenge
// ---------------------------------------------------------------------------

describe('handleChallenge', () => {
  it('should echo back the challenge string', () => {
    const challenge = 'test-challenge-string-12345';
    const result = handleChallenge(challenge);
    expect(result).toEqual({ challenge: 'test-challenge-string-12345' });
  });

  it('should handle empty challenge string', () => {
    const result = handleChallenge('');
    expect(result).toEqual({ challenge: '' });
  });
});

// ---------------------------------------------------------------------------
// EventDispatcher
// ---------------------------------------------------------------------------

describe('EventDispatcher', () => {
  let dispatcher: EventDispatcher;

  beforeEach(() => {
    dispatcher = new EventDispatcher();
  });

  const createMockEvent = (eventType: string): FeishuEvent => ({
    schema: '2.0',
    header: {
      event_id: 'evt_123',
      event_type: eventType,
      create_time: '1234567890',
      token: 'test-token',
      app_id: 'app_123',
    },
    event: {},
  });

  it('should register and dispatch to a handler', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    dispatcher.register('im.message.receive_v1', handler);

    const event = createMockEvent('im.message.receive_v1');
    await dispatcher.dispatch(event);

    expect(handler).toHaveBeenCalledWith(event);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should dispatch to multiple handlers for the same event type', async () => {
    const handler1 = vi.fn().mockResolvedValue(undefined);
    const handler2 = vi.fn().mockResolvedValue(undefined);

    dispatcher.register('im.message.receive_v1', handler1);
    dispatcher.register('im.message.receive_v1', handler2);

    const event = createMockEvent('im.message.receive_v1');
    await dispatcher.dispatch(event);

    expect(handler1).toHaveBeenCalledWith(event);
    expect(handler2).toHaveBeenCalledWith(event);
  });

  it('should not throw for unregistered event types', async () => {
    const event = createMockEvent('unknown.event.type');
    // Should not throw, just log a warning
    await expect(dispatcher.dispatch(event)).resolves.toBeUndefined();
  });

  it('should correctly report hasHandler', () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    dispatcher.register('im.message.receive_v1', handler);

    expect(dispatcher.hasHandler('im.message.receive_v1')).toBe(true);
    expect(dispatcher.hasHandler('unknown.event')).toBe(false);
  });

  it('should return all registered event types', () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    dispatcher.register('im.message.receive_v1', handler);
    dispatcher.register('card.action.trigger', handler);

    const types = dispatcher.getRegisteredEventTypes();
    expect(types).toContain('im.message.receive_v1');
    expect(types).toContain('card.action.trigger');
    expect(types).toHaveLength(2);
  });

  it('should handle handler errors by propagating them', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('handler failed'));
    dispatcher.register('im.message.receive_v1', handler);

    const event = createMockEvent('im.message.receive_v1');
    await expect(dispatcher.dispatch(event)).rejects.toThrow('handler failed');
  });
});

// ---------------------------------------------------------------------------
// registerWebhookGateway (Fastify integration)
// ---------------------------------------------------------------------------

describe('registerWebhookGateway', () => {
  const config: WebhookGatewayConfig = {
    verificationToken: 'test-verification-token',
    encryptKey: 'test-encrypt-key',
  };

  async function buildApp(dispatcher: EventDispatcher, gatewayConfig?: WebhookGatewayConfig) {
    const app = Fastify();
    await registerWebhookGateway(app, {
      config: gatewayConfig ?? config,
      dispatcher,
    });
    await app.ready();
    return app;
  }

  describe('URL Challenge', () => {
    it('should respond with the challenge string for valid challenge requests', async () => {
      const dispatcher = new EventDispatcher();
      const app = await buildApp(dispatcher);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook/event',
        payload: {
          type: 'url_verification',
          challenge: 'my-challenge-123',
          token: 'test-verification-token',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ challenge: 'my-challenge-123' });
    });

    it('should return 403 for challenge with invalid token', async () => {
      const dispatcher = new EventDispatcher();
      const app = await buildApp(dispatcher);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook/event',
        payload: {
          type: 'url_verification',
          challenge: 'my-challenge-123',
          token: 'wrong-token',
        },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('Signature Verification', () => {
    it('should return 401 when signature headers are missing', async () => {
      const dispatcher = new EventDispatcher();
      const app = await buildApp(dispatcher);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook/event',
        payload: {
          schema: '2.0',
          header: {
            event_id: 'evt_123',
            event_type: 'im.message.receive_v1',
            create_time: '1234567890',
            token: 'test-verification-token',
            app_id: 'app_123',
          },
          event: {},
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Missing signature headers' });
    });

    it('should return 401 for invalid signature', async () => {
      const dispatcher = new EventDispatcher();
      const app = await buildApp(dispatcher);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook/event',
        headers: {
          'x-lark-request-timestamp': '1234567890',
          'x-lark-request-nonce': 'nonce123',
          'x-lark-signature': 'a'.repeat(64),
        },
        payload: {
          schema: '2.0',
          header: {
            event_id: 'evt_123',
            event_type: 'im.message.receive_v1',
            create_time: '1234567890',
            token: 'test-verification-token',
            app_id: 'app_123',
          },
          event: {},
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Invalid signature' });
    });

    it('should accept requests with valid signature', async () => {
      const dispatcher = new EventDispatcher();
      const handler = vi.fn().mockResolvedValue(undefined);
      dispatcher.register('im.message.receive_v1', handler);
      const app = await buildApp(dispatcher);

      const payload = {
        schema: '2.0',
        header: {
          event_id: 'evt_123',
          event_type: 'im.message.receive_v1',
          create_time: '1234567890',
          token: 'test-verification-token',
          app_id: 'app_123',
        },
        event: {
          message: {
            message_id: 'msg_123',
            chat_id: 'chat_123',
            chat_type: 'p2p',
            content: '{"text":"hello"}',
            sender: { sender_id: { user_id: 'user_123' } },
          },
        },
      };

      const bodyStr = JSON.stringify(payload);
      const timestamp = '1234567890';
      const nonce = 'nonce123';
      const content = timestamp + nonce + config.encryptKey + bodyStr;
      const signature = crypto.createHash('sha256').update(content).digest('hex');

      const response = await app.inject({
        method: 'POST',
        url: '/webhook/event',
        headers: {
          'content-type': 'application/json',
          'x-lark-request-timestamp': timestamp,
          'x-lark-request-nonce': nonce,
          'x-lark-signature': signature,
        },
        payload: bodyStr,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ code: 0, msg: 'ok' });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should skip signature verification when encryptKey is empty', async () => {
      const dispatcher = new EventDispatcher();
      const handler = vi.fn().mockResolvedValue(undefined);
      dispatcher.register('im.message.receive_v1', handler);

      const noEncryptConfig: WebhookGatewayConfig = {
        verificationToken: 'test-verification-token',
        encryptKey: '',
      };
      const app = await buildApp(dispatcher, noEncryptConfig);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook/event',
        payload: {
          schema: '2.0',
          header: {
            event_id: 'evt_123',
            event_type: 'im.message.receive_v1',
            create_time: '1234567890',
            token: 'test-verification-token',
            app_id: 'app_123',
          },
          event: {},
        },
      });

      expect(response.statusCode).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('Event Token Verification', () => {
    it('should return 403 when event token does not match', async () => {
      const dispatcher = new EventDispatcher();
      const noEncryptConfig: WebhookGatewayConfig = {
        verificationToken: 'test-verification-token',
        encryptKey: '',
      };
      const app = await buildApp(dispatcher, noEncryptConfig);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook/event',
        payload: {
          schema: '2.0',
          header: {
            event_id: 'evt_123',
            event_type: 'im.message.receive_v1',
            create_time: '1234567890',
            token: 'wrong-token',
            app_id: 'app_123',
          },
          event: {},
        },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('Event Dispatching', () => {
    it('should dispatch message events to registered handlers', async () => {
      const dispatcher = new EventDispatcher();
      const handler = vi.fn().mockResolvedValue(undefined);
      dispatcher.register('im.message.receive_v1', handler);

      const noEncryptConfig: WebhookGatewayConfig = {
        verificationToken: 'test-verification-token',
        encryptKey: '',
      };
      const app = await buildApp(dispatcher, noEncryptConfig);

      const event = {
        schema: '2.0',
        header: {
          event_id: 'evt_456',
          event_type: 'im.message.receive_v1',
          create_time: '1234567890',
          token: 'test-verification-token',
          app_id: 'app_123',
        },
        event: {
          message: {
            message_id: 'msg_456',
            chat_id: 'chat_456',
            chat_type: 'group',
            content: '{"text":"test message"}',
            sender: { sender_id: { user_id: 'user_456' } },
          },
        },
      };

      const response = await app.inject({
        method: 'POST',
        url: '/webhook/event',
        payload: event,
      });

      expect(response.statusCode).toBe(200);
      expect(handler).toHaveBeenCalledWith(event);
    });

    it('should dispatch card action events to registered handlers', async () => {
      const dispatcher = new EventDispatcher();
      const handler = vi.fn().mockResolvedValue(undefined);
      dispatcher.register('card.action.trigger', handler);

      const noEncryptConfig: WebhookGatewayConfig = {
        verificationToken: 'test-verification-token',
        encryptKey: '',
      };
      const app = await buildApp(dispatcher, noEncryptConfig);

      const event = {
        schema: '2.0',
        header: {
          event_id: 'evt_789',
          event_type: 'card.action.trigger',
          create_time: '1234567890',
          token: 'test-verification-token',
          app_id: 'app_123',
        },
        event: {
          action: {
            tag: 'button',
            value: { action: 'approve' },
            open_id: 'ou_123',
            token: 'action-token',
          },
        },
      };

      const response = await app.inject({
        method: 'POST',
        url: '/webhook/event',
        payload: event,
      });

      expect(response.statusCode).toBe(200);
      expect(handler).toHaveBeenCalledWith(event);
    });

    it('should return 200 for events with no registered handler', async () => {
      const dispatcher = new EventDispatcher();
      const noEncryptConfig: WebhookGatewayConfig = {
        verificationToken: 'test-verification-token',
        encryptKey: '',
      };
      const app = await buildApp(dispatcher, noEncryptConfig);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook/event',
        payload: {
          schema: '2.0',
          header: {
            event_id: 'evt_999',
            event_type: 'unknown.event.type',
            create_time: '1234567890',
            token: 'test-verification-token',
            app_id: 'app_123',
          },
          event: {},
        },
      });

      // Should still return 200 to acknowledge receipt
      expect(response.statusCode).toBe(200);
    });
  });

  describe('Custom base path', () => {
    it('should support custom base path', async () => {
      const dispatcher = new EventDispatcher();
      const handler = vi.fn().mockResolvedValue(undefined);
      dispatcher.register('im.message.receive_v1', handler);

      const noEncryptConfig: WebhookGatewayConfig = {
        verificationToken: 'test-verification-token',
        encryptKey: '',
      };

      const app = Fastify();
      await registerWebhookGateway(app, {
        config: noEncryptConfig,
        dispatcher,
        basePath: '/api/v1',
      });
      await app.ready();

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/event',
        payload: {
          schema: '2.0',
          header: {
            event_id: 'evt_custom',
            event_type: 'im.message.receive_v1',
            create_time: '1234567890',
            token: 'test-verification-token',
            app_id: 'app_123',
          },
          event: {},
        },
      });

      expect(response.statusCode).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
