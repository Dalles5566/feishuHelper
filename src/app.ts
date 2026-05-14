/**
 * Fastify application initialization.
 *
 * Creates and configures the Fastify instance, registers the webhook gateway
 * routes, health check endpoint, and wires up the AgentCore and NotificationService
 * for end-to-end message processing.
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
import type { AgentCore } from './agent/agentCore.js';
import type { NotificationService } from './services/notification.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildAppOptions {
  /** Override the event dispatcher (useful for testing). */
  dispatcher?: EventDispatcher;
  /** Override the webhook gateway config (useful for testing). */
  webhookConfig?: WebhookGatewayConfig;
  /** Skip service initialization (AgentCore, NotificationService) for testing. */
  skipServices?: boolean;
  /** Override the AgentCore instance (useful for testing). */
  agentCore?: AgentCore;
  /** Override the NotificationService instance (useful for testing). */
  notificationService?: NotificationService;
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
 * - Message handler connecting dispatcher → AgentCore → NotificationService
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

  // Initialize and wire up services (unless skipped for testing)
  if (!options.skipServices) {
    // Dynamic imports to avoid loading heavy dependencies (lark-mcp, langchain)
    // when services are not needed (e.g., in unit tests)
    const { AgentCore: AgentCoreClass } = await import('./agent/agentCore.js');
    const { NotificationService: NotificationServiceClass } = await import('./services/notification.js');
    const { registerMessageHandler } = await import('./integration/messageHandler.js');

    const agentCore = options.agentCore ?? new AgentCoreClass();
    const notificationService = options.notificationService ?? new NotificationServiceClass();

    // Initialize AgentCore (sets up LLM and registers tools)
    if (!options.agentCore) {
      await agentCore.initialize();
    }

    // Register message handlers to connect dispatcher → AgentCore → NotificationService
    registerMessageHandler(dispatcher, agentCore, notificationService);
  }

  return app;
}
