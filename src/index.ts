/**
 * Application entry point.
 *
 * Initializes database connection pool, BullMQ queues and workers,
 * starts the Fastify HTTP server, and implements graceful shutdown.
 *
 * Requirements: 10.1
 */

import { buildApp } from './app.js';
import { getConfig } from './config/index.js';
import { getPool, closePool } from './config/database.js';
import { initQueues, initWorkers, closeAll as closeQueues } from './queue/index.js';
import { EventDispatcher } from './gateway/webhookGateway.js';
import { WsGateway } from './gateway/wsGateway.js';
import { AgentCore } from './agent/agentCore.js';
import { NotificationService } from './services/notification.js';
import { registerMessageHandler } from './integration/messageHandler.js';

/**
 * Start the application.
 */
async function main(): Promise<void> {
  const config = getConfig();

  console.log(`[feishu-helper] Starting in ${config.app.nodeEnv} mode...`);

  // Initialize database connection pool
  getPool();
  console.log('[feishu-helper] Database connection pool initialized');

  // Initialize BullMQ queues and workers
  initQueues();
  initWorkers();
  console.log('[feishu-helper] BullMQ queues and workers initialized');

  // Build and start the Fastify app (skipServices=true since we wire manually below)
  const dispatcher = new EventDispatcher();
  const app = await buildApp({ skipServices: true, dispatcher });

  try {
    await app.listen({ port: config.app.port, host: config.app.host });
    console.log(
      `[feishu-helper] Server listening on ${config.app.host}:${config.app.port}`,
    );
  } catch (err) {
    console.error('[feishu-helper] Failed to start server:', err);
    process.exit(1);
  }

  // Initialize AgentCore and NotificationService
  const agentCore = new AgentCore();
  const notificationService = new NotificationService();
  await agentCore.initialize();
  registerMessageHandler(dispatcher, agentCore, notificationService);
  console.log('[feishu-helper] AgentCore and NotificationService initialized');

  // Start WebSocket long connection to Feishu
  const wsGateway = new WsGateway(dispatcher);
  await wsGateway.start();

  // Graceful shutdown handler
  const shutdown = async (signal: string) => {
    console.log(`[feishu-helper] Received ${signal}, shutting down gracefully...`);

    try {
      // Close WebSocket connection
      await wsGateway.stop();
      console.log('[feishu-helper] WebSocket connection closed');

      // Close HTTP server (stop accepting new connections)
      await app.close();
      console.log('[feishu-helper] HTTP server closed');

      // Close BullMQ queues and workers
      await closeQueues();
      console.log('[feishu-helper] BullMQ queues and workers closed');

      // Close database connection pool
      await closePool();
      console.log('[feishu-helper] Database connection pool closed');

      console.log('[feishu-helper] Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      console.error('[feishu-helper] Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[feishu-helper] Unhandled startup error:', err);
  process.exit(1);
});
