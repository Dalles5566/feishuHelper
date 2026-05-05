import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getPool, closePool, resetPool, runMigrations } from './database.js';

// Mock pg module
vi.mock('pg', () => {
  const mockPool = {
    query: vi.fn(),
    connect: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  };

  function MockPool() {
    return mockPool;
  }

  return {
    default: {
      Pool: MockPool,
    },
  };
});

// Mock fs module
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
}));

describe('database config', () => {
  beforeEach(() => {
    resetPool();
    vi.clearAllMocks();
  });

  describe('getPool', () => {
    it('should create a pool with provided config', () => {
      const config = {
        host: 'testhost',
        port: 5433,
        database: 'testdb',
        user: 'testuser',
        password: 'testpass',
        maxConnections: 10,
        idleTimeoutMs: 15000,
        connectionTimeoutMs: 3000,
      };

      const pool = getPool(config);
      expect(pool).toBeDefined();
      expect(pool.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should return the same pool on subsequent calls', () => {
      const config = {
        host: 'localhost',
        port: 5432,
        database: 'test',
        user: 'user',
        password: 'pass',
      };

      const pool1 = getPool(config);
      const pool2 = getPool(config);
      expect(pool1).toBe(pool2);
    });
  });

  describe('closePool', () => {
    it('should close the pool and reset reference', async () => {
      const config = {
        host: 'localhost',
        port: 5432,
        database: 'test',
        user: 'user',
        password: 'pass',
      };

      const pool = getPool(config);
      await closePool();
      expect(pool.end).toHaveBeenCalled();
    });

    it('should handle closing when no pool exists', async () => {
      // Should not throw
      await closePool();
    });
  });

  describe('runMigrations', () => {
    it('should create schema_migrations table and apply pending migrations', async () => {
      const { readFileSync, readdirSync } = await import('node:fs');
      const mockReadFileSync = vi.mocked(readFileSync);
      const mockReaddirSync = vi.mocked(readdirSync);

      mockReaddirSync.mockReturnValue([
        '001_initial_schema.sql' as unknown as import('node:fs').Dirent,
      ]);
      mockReadFileSync.mockReturnValue('CREATE TABLE test (id INT);');

      const mockClient = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        release: vi.fn(),
      };

      const mockPool = {
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE schema_migrations
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }), // SELECT applied
        connect: vi.fn().mockResolvedValue(mockClient),
        end: vi.fn(),
        on: vi.fn(),
      };

      const applied = await runMigrations(
        mockPool as unknown as import('pg').Pool,
        '/fake/migrations',
      );

      expect(applied).toEqual(['001_initial_schema.sql']);
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith(
        'CREATE TABLE test (id INT);',
      );
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should skip already applied migrations', async () => {
      const { readFileSync, readdirSync } = await import('node:fs');
      const mockReadFileSync = vi.mocked(readFileSync);
      const mockReaddirSync = vi.mocked(readdirSync);

      mockReaddirSync.mockReturnValue([
        '001_initial_schema.sql' as unknown as import('node:fs').Dirent,
      ]);
      mockReadFileSync.mockReturnValue('CREATE TABLE test (id INT);');

      const mockPool = {
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE schema_migrations
          .mockResolvedValueOnce({
            rows: [{ filename: '001_initial_schema.sql' }],
            rowCount: 1,
          }), // SELECT applied
        connect: vi.fn(),
        end: vi.fn(),
        on: vi.fn(),
      };

      const applied = await runMigrations(
        mockPool as unknown as import('pg').Pool,
        '/fake/migrations',
      );

      expect(applied).toEqual([]);
      expect(mockPool.connect).not.toHaveBeenCalled();
    });

    it('should rollback on migration failure', async () => {
      const { readFileSync, readdirSync } = await import('node:fs');
      const mockReadFileSync = vi.mocked(readFileSync);
      const mockReaddirSync = vi.mocked(readdirSync);

      mockReaddirSync.mockReturnValue([
        '001_bad_migration.sql' as unknown as import('node:fs').Dirent,
      ]);
      mockReadFileSync.mockReturnValue('INVALID SQL;');

      const mockClient = {
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
          .mockRejectedValueOnce(new Error('syntax error')), // SQL execution
        release: vi.fn(),
      };

      const mockPool = {
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE schema_migrations
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }), // SELECT applied
        connect: vi.fn().mockResolvedValue(mockClient),
        end: vi.fn(),
        on: vi.fn(),
      };

      await expect(
        runMigrations(
          mockPool as unknown as import('pg').Pool,
          '/fake/migrations',
        ),
      ).rejects.toThrow('Migration 001_bad_migration.sql failed: syntax error');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });
});
