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

  // Build and start the Fastify app
  const app = await buildApp();

  try {
    await app.listen({ port: config.app.port, host: config.app.host });
    console.log(
      `[feishu-helper] Server listening on ${config.app.host}:${config.app.port}`,
    );
  } catch (err) {
    console.error('[feishu-helper] Failed to start server:', err);
    process.exit(1);
  }

  // Graceful shutdown handler
  const shutdown = async (signal: string) => {
    console.log(`[feishu-helper] Received ${signal}, shutting down gracefully...`);

    try {
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
