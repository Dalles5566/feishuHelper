import pg from 'pg';
import { getPool } from '../config/database.js';

/**
 * Query result type with typed rows.
 */
export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

/**
 * Execute a parameterized SQL query and return typed results.
 */
export async function query<T extends Record<string, unknown>>(
  sql: string,
  params?: unknown[],
  pool?: pg.Pool,
): Promise<QueryResult<T>> {
  const targetPool = pool || getPool();
  const result = await targetPool.query(sql, params);
  return {
    rows: result.rows as T[],
    rowCount: result.rowCount ?? 0,
  };
}

/**
 * Execute a query and return the first row, or null if no results.
 */
export async function queryOne<T extends Record<string, unknown>>(
  sql: string,
  params?: unknown[],
  pool?: pg.Pool,
): Promise<T | null> {
  const result = await query<T>(sql, params, pool);
  return result.rows[0] ?? null;
}

/**
 * Execute an INSERT and return the inserted row.
 * Expects the SQL to include a RETURNING clause.
 */
export async function insert<T extends Record<string, unknown>>(
  sql: string,
  params?: unknown[],
  pool?: pg.Pool,
): Promise<T> {
  const result = await query<T>(sql, params, pool);
  if (result.rows.length === 0) {
    throw new Error('Insert did not return a row. Ensure SQL includes RETURNING clause.');
  }
  return result.rows[0];
}

/**
 * Execute an UPDATE and return the number of affected rows.
 */
export async function update(
  sql: string,
  params?: unknown[],
  pool?: pg.Pool,
): Promise<number> {
  const result = await query(sql, params, pool);
  return result.rowCount;
}

/**
 * Execute a DELETE and return the number of affected rows.
 */
export async function remove(
  sql: string,
  params?: unknown[],
  pool?: pg.Pool,
): Promise<number> {
  const result = await query(sql, params, pool);
  return result.rowCount;
}

/**
 * Execute multiple queries within a single transaction.
 * Automatically rolls back on error.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  pool?: pg.Pool,
): Promise<T> {
  const targetPool = pool || getPool();
  const client = await targetPool.connect();

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Execute a parameterized query using a specific client (for use within transactions).
 */
export async function clientQuery<T extends Record<string, unknown>>(
  client: pg.PoolClient,
  sql: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const result = await client.query(sql, params);
  return {
    rows: result.rows as T[],
    rowCount: result.rowCount ?? 0,
  };
}
