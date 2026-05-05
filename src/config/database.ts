import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  maxConnections?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

// Default configuration from environment variables
function getDefaultConfig(): DatabaseConfig {
  return {
    host: process.env['DB_HOST'] || 'localhost',
    port: parseInt(process.env['DB_PORT'] || '5432', 10),
    database: process.env['DB_NAME'] || 'feishu_helper',
    user: process.env['DB_USER'] || 'postgres',
    password: process.env['DB_PASSWORD'] || '',
    maxConnections: parseInt(process.env['DB_MAX_CONNECTIONS'] || '20', 10),
    idleTimeoutMs: parseInt(process.env['DB_IDLE_TIMEOUT_MS'] || '30000', 10),
    connectionTimeoutMs: parseInt(
      process.env['DB_CONNECTION_TIMEOUT_MS'] || '5000',
      10,
    ),
  };
}

let pool: pg.Pool | null = null;

/**
 * Create and return the database connection pool.
 * Reuses existing pool if already initialized.
 */
export function getPool(config?: DatabaseConfig): pg.Pool {
  if (pool) {
    return pool;
  }

  const dbConfig = config || getDefaultConfig();

  pool = new Pool({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password,
    max: dbConfig.maxConnections || 20,
    idleTimeoutMillis: dbConfig.idleTimeoutMs || 30000,
    connectionTimeoutMillis: dbConfig.connectionTimeoutMs || 5000,
  });

  pool.on('error', (err) => {
    console.error('Unexpected database pool error:', err.message);
  });

  return pool;
}

/**
 * Close the database connection pool.
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Reset the pool reference (useful for testing).
 */
export function resetPool(): void {
  pool = null;
}

/**
 * Run all pending database migrations.
 * Tracks applied migrations in a `schema_migrations` table.
 */
export async function runMigrations(
  dbPool?: pg.Pool,
  migrationsDir?: string,
): Promise<string[]> {
  const targetPool = dbPool || getPool();

  // Ensure schema_migrations table exists
  await targetPool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Determine migrations directory
  const resolvedDir =
    migrationsDir || join(getRootDir(), '..', '..', 'migrations');

  // Read migration files
  const files = readdirSync(resolvedDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  // Get already applied migrations
  const result = await targetPool.query(
    'SELECT filename FROM schema_migrations ORDER BY filename',
  );
  const applied = new Set(
    result.rows.map((row: { filename: string }) => row.filename),
  );

  // Apply pending migrations
  const newlyApplied: string[] = [];

  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }

    const sql = readFileSync(join(resolvedDir, file), 'utf-8');

    const client = await targetPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [file],
      );
      await client.query('COMMIT');
      newlyApplied.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(
        `Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      client.release();
    }
  }

  return newlyApplied;
}

/**
 * Get the directory of this module (for resolving relative paths).
 */
function getRootDir(): string {
  // Works for both ESM and compiled output
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return __dirname;
  }
}
