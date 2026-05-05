import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  query,
  queryOne,
  insert,
  update,
  remove,
  withTransaction,
  clientQuery,
} from './db.js';
import type pg from 'pg';

// Mock the database module
vi.mock('../config/database.js', () => ({
  getPool: vi.fn(),
}));

function createMockPool(queryResult = { rows: [], rowCount: 0 }) {
  return {
    query: vi.fn().mockResolvedValue(queryResult),
    connect: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  } as unknown as pg.Pool;
}

function createMockClient(queryResult = { rows: [], rowCount: 0 }) {
  return {
    query: vi.fn().mockResolvedValue(queryResult),
    release: vi.fn(),
  } as unknown as pg.PoolClient;
}

describe('db utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('query', () => {
    it('should execute SQL and return typed results', async () => {
      const mockPool = createMockPool({
        rows: [{ id: '1', name: 'test' }],
        rowCount: 1,
      });

      const result = await query<{ id: string; name: string }>(
        'SELECT * FROM tasks WHERE id = $1',
        ['1'],
        mockPool,
      );

      expect(result.rows).toEqual([{ id: '1', name: 'test' }]);
      expect(result.rowCount).toBe(1);
      expect(mockPool.query).toHaveBeenCalledWith(
        'SELECT * FROM tasks WHERE id = $1',
        ['1'],
      );
    });

    it('should return empty results when no rows match', async () => {
      const mockPool = createMockPool({ rows: [], rowCount: 0 });

      const result = await query(
        'SELECT * FROM tasks WHERE id = $1',
        ['nonexistent'],
        mockPool,
      );

      expect(result.rows).toEqual([]);
      expect(result.rowCount).toBe(0);
    });
  });

  describe('queryOne', () => {
    it('should return the first row', async () => {
      const mockPool = createMockPool({
        rows: [{ id: '1', title: 'Task 1' }],
        rowCount: 1,
      });

      const result = await queryOne<{ id: string; title: string }>(
        'SELECT * FROM tasks WHERE id = $1',
        ['1'],
        mockPool,
      );

      expect(result).toEqual({ id: '1', title: 'Task 1' });
    });

    it('should return null when no rows found', async () => {
      const mockPool = createMockPool({ rows: [], rowCount: 0 });

      const result = await queryOne(
        'SELECT * FROM tasks WHERE id = $1',
        ['nonexistent'],
        mockPool,
      );

      expect(result).toBeNull();
    });
  });

  describe('insert', () => {
    it('should insert and return the new row', async () => {
      const mockPool = createMockPool({
        rows: [{ id: 'new-id', title: 'New Task' }],
        rowCount: 1,
      });

      const result = await insert<{ id: string; title: string }>(
        'INSERT INTO tasks (title) VALUES ($1) RETURNING *',
        ['New Task'],
        mockPool,
      );

      expect(result).toEqual({ id: 'new-id', title: 'New Task' });
    });

    it('should throw if no row returned', async () => {
      const mockPool = createMockPool({ rows: [], rowCount: 0 });

      await expect(
        insert('INSERT INTO tasks (title) VALUES ($1)', ['Test'], mockPool),
      ).rejects.toThrow('Insert did not return a row');
    });
  });

  describe('update', () => {
    it('should return the number of affected rows', async () => {
      const mockPool = createMockPool({ rows: [], rowCount: 3 });

      const count = await update(
        'UPDATE tasks SET state = $1 WHERE meeting_id = $2',
        ['Created', 'meeting-1'],
        mockPool,
      );

      expect(count).toBe(3);
    });
  });

  describe('remove', () => {
    it('should return the number of deleted rows', async () => {
      const mockPool = createMockPool({ rows: [], rowCount: 1 });

      const count = await remove(
        'DELETE FROM tasks WHERE id = $1',
        ['task-1'],
        mockPool,
      );

      expect(count).toBe(1);
    });
  });

  describe('withTransaction', () => {
    it('should commit on success', async () => {
      const mockClient = createMockClient({
        rows: [{ id: '1' }],
        rowCount: 1,
      });
      const mockPool = createMockPool();
      (mockPool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockClient,
      );

      const result = await withTransaction(async (client) => {
        const res = await client.query('INSERT INTO tasks (title) VALUES ($1) RETURNING id', ['Test']);
        return res.rows[0];
      }, mockPool);

      expect(result).toEqual({ id: '1' });
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should rollback on error', async () => {
      const mockClient = createMockClient();
      (mockClient.query as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({}) // BEGIN
        .mockRejectedValueOnce(new Error('constraint violation')); // actual query

      const mockPool = createMockPool();
      (mockPool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockClient,
      );

      await expect(
        withTransaction(async (client) => {
          await client.query('INSERT INTO tasks (title) VALUES ($1)', [null]);
        }, mockPool),
      ).rejects.toThrow('constraint violation');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('clientQuery', () => {
    it('should execute query on a specific client', async () => {
      const mockClient = createMockClient({
        rows: [{ id: '1', state: 'Created' }],
        rowCount: 1,
      });

      const result = await clientQuery<{ id: string; state: string }>(
        mockClient,
        'SELECT * FROM tasks WHERE id = $1',
        ['1'],
      );

      expect(result.rows).toEqual([{ id: '1', state: 'Created' }]);
      expect(result.rowCount).toBe(1);
    });
  });
});
