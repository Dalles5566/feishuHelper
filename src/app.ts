/**
 * Fastify application initialization.
 *
 * Creates and configures the Fastify instance, registers the webhook gateway
 * routes and health check endpoint. Exports the configured app for testing.
 *
 * Requirements: 10.1
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { getConfig } from './config/index.js';
import {
  registerWebhookGateway,
  EventDispatcher,
  type WebhookGatewayConfig,
} from './gateway/webhookGateway.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildAppOptions {
  /** Override the event dispatcher (useful for testing). */
  dispatcher?: EventDispatcher;
  /** Override the webhook gateway config (useful for testing). */
  webhookConfig?: WebhookGatewayConfig;
}

// ---------------------------------------------------------------------------
// App Builder
// ---------------------------------------------------------------------------

/**
 * Build and configure the Fastify application instance.
 *
 * Registers:
 * - Health check endpoint at GET /health
 * - Webhook gateway routes at POST /webhook/event
 *
 * @param options - Optional overrides for testing
 * @returns Configured Fastify instance
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = getConfig();

  const app = Fastify({
    logger: {
      level: config.app.logLevel,
    },
  });

  // Register health check endpoint
  app.get('/health', async (_request, _reply) => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  });

  // Set up webhook gateway
  const dispatcher = options.dispatcher ?? new EventDispatcher();
  const webhookConfig: WebhookGatewayConfig = options.webhookConfig ?? {
    verificationToken: config.feishu.verificationToken,
    encryptKey: config.feishu.encryptKey,
  };

  await registerWebhookGateway(app, {
    config: webhookConfig,
    dispatcher,
  });

  return app;
}
