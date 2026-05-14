/**
 * Unit tests for the Fastify application (app.ts).
 *
 * Tests:
 * - Health check endpoint returns correct response
 * - Webhook gateway routes are registered
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { EventDispatcher } from './gateway/webhookGateway.js';
import { resetConfig } from './config/index.js';

// Set required environment variables for config validation
beforeAll(() => {
  process.env['FEISHU_APP_ID'] = 'test-app-id';
  process.env['FEISHU_APP_SECRET'] = 'test-app-secret';
  process.env['FEISHU_VERIFICATION_TOKEN'] = 'test-verification-token';
  process.env['FEISHU_ENCRYPT_KEY'] = '';
  process.env['LLM_API_KEY'] = 'test-llm-key';
  process.env['DB_PASSWORD'] = 'test-db-password';
  process.env['NODE_ENV'] = 'test';
});

afterAll(() => {
  resetConfig();
});

describe('buildApp', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetConfig();
    app = await buildApp({
      webhookConfig: {
        verificationToken: 'test-verification-token',
        encryptKey: '',
      },
      skipServices: true,
    });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('GET /health', () => {
    it('should return status ok with a timestamp', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
      expect(body.timestamp).toBeDefined();
      // Verify timestamp is a valid ISO string
      expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
    });
  });

  describe('Webhook gateway routes', () => {
    it('should have POST /webhook/event route registered', async () => {
      // Send a challenge request to verify the route exists
      const response = await app.inject({
        method: 'POST',
        url: '/webhook/event',
        headers: {
          'content-type': 'application/json',
        },
        payload: {
          type: 'url_verification',
          challenge: 'test-challenge-string',
          token: 'test-verification-token',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.challenge).toBe('test-challenge-string');
    });

    it('should reject challenge with invalid verification token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/webhook/event',
        headers: {
          'content-type': 'application/json',
        },
        payload: {
          type: 'url_verification',
          challenge: 'test-challenge-string',
          token: 'wrong-token',
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should dispatch valid events to the event dispatcher', async () => {
      const dispatcher = new EventDispatcher();
      const handler = vi.fn().mockResolvedValue(undefined);
      dispatcher.register('im.message.receive_v1', handler);

      const customApp = await buildApp({
        dispatcher,
        webhookConfig: {
          verificationToken: 'test-verification-token',
          encryptKey: '',
        },
        skipServices: true,
      });

      const response = await customApp.inject({
        method: 'POST',
        url: '/webhook/event',
        headers: {
          'content-type': 'application/json',
        },
        payload: {
          schema: '2.0',
          header: {
            event_id: 'evt-123',
            event_type: 'im.message.receive_v1',
            create_time: '1234567890',
            token: 'test-verification-token',
            app_id: 'test-app-id',
          },
          event: {
            message: {
              message_id: 'msg-123',
              chat_id: 'chat-123',
              chat_type: 'p2p',
              content: '{"text":"hello"}',
              sender: {
                sender_id: { user_id: 'user-123' },
              },
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(handler).toHaveBeenCalledOnce();

      await customApp.close();
    });
  });

  describe('buildApp with custom options', () => {
    it('should accept a custom event dispatcher', async () => {
      const dispatcher = new EventDispatcher();
      dispatcher.register('custom.event', vi.fn());

      const customApp = await buildApp({
        dispatcher,
        webhookConfig: {
          verificationToken: 'test-verification-token',
          encryptKey: '',
        },
        skipServices: true,
      });

      expect(customApp).toBeDefined();
      await customApp.close();
    });
  });
});
