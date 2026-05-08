/**
 * Unit tests for FeishuAuthService.
 *
 * Tests cover:
 * - Token fetching via app credentials
 * - Redis caching behavior
 * - Proactive refresh before expiration
 * - Concurrent request deduplication
 * - Force refresh
 * - Error handling (network, auth, API errors)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeishuAuthService, type TenantAccessTokenResponse } from './feishuAuth.js';

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

class MockRedis {
  private store = new Map<string, { value: string; expiresAt?: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() / 1000 > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<'OK'> {
    let expiresAt: number | undefined;
    if (args[0] === 'EX' && typeof args[1] === 'number') {
      expiresAt = Math.floor(Date.now() / 1000) + args[1];
    }
    this.store.set(key, { value, expiresAt });
    return 'OK';
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  async quit(): Promise<'OK'> {
    this.store.clear();
    return 'OK';
  }

  // Test helper to inspect store
  getStore() {
    return this.store;
  }
}

// ---------------------------------------------------------------------------
// Mock config
// ---------------------------------------------------------------------------

vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    feishu: {
      appId: 'test-app-id',
      appSecret: 'test-app-secret',
      verificationToken: 'test-token',
      encryptKey: '',
    },
    redis: {
      host: 'localhost',
      port: 6379,
      password: '',
      db: 0,
      connectTimeoutMs: 5000,
    },
    app: {
      maxRetries: 3,
      retryBaseDelayMs: 1000,
      retryMaxDelayMs: 30000,
    },
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockFetch(response: TenantAccessTokenResponse): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => response,
  }) as unknown as typeof fetch;
}

function createSuccessResponse(
  token = 'test-tenant-token',
  expire = 7200,
): TenantAccessTokenResponse {
  return {
    code: 0,
    msg: 'ok',
    tenant_access_token: token,
    expire,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FeishuAuthService', () => {
  let mockRedis: MockRedis;
  let service: FeishuAuthService;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockRedis = new MockRedis();
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => createSuccessResponse(),
    });

    service = new FeishuAuthService({
      redis: mockRedis as unknown as import('ioredis').default,
      fetchFn: mockFetch as unknown as typeof fetch,
      refreshBufferSeconds: 300,
      sleep: async () => {}, // No-op sleep for fast tests
    });
  });

  afterEach(async () => {
    await service.disconnect();
    vi.restoreAllMocks();
  });

  describe('getToken', () => {
    it('should fetch a new token when cache is empty', async () => {
      const token = await service.getToken();

      expect(token).toBe('test-tenant-token');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ app_id: 'test-app-id', app_secret: 'test-app-secret' }),
        },
      );
    });

    it('should return cached token when still valid', async () => {
      // First call fetches from API
      await service.getToken();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second call should use cache
      const token = await service.getToken();
      expect(token).toBe('test-tenant-token');
      expect(mockFetch).toHaveBeenCalledTimes(1); // No additional fetch
    });

    it('should refresh token when within buffer window of expiration', async () => {
      // Manually set a token that expires in 200 seconds (within 300s buffer)
      const now = Math.floor(Date.now() / 1000);
      await mockRedis.set('feishu:token:tenant_access_token', 'old-token', 'EX', 200);
      await mockRedis.set(
        'feishu:token:tenant_access_token:expiry',
        String(now + 200),
        'EX',
        200,
      );

      // Should trigger refresh because 200 < 300 (buffer)
      const token = await service.getToken();
      expect(token).toBe('test-tenant-token'); // New token from API
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should NOT refresh token when well outside buffer window', async () => {
      // Set a token that expires in 6000 seconds (well outside 300s buffer)
      const now = Math.floor(Date.now() / 1000);
      await mockRedis.set('feishu:token:tenant_access_token', 'cached-token', 'EX', 6000);
      await mockRedis.set(
        'feishu:token:tenant_access_token:expiry',
        String(now + 6000),
        'EX',
        6000,
      );

      const token = await service.getToken();
      expect(token).toBe('cached-token');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should deduplicate concurrent token requests', async () => {
      // Use a deferred pattern to control when the fetch resolves
      let resolveFetch!: (value: Response) => void;
      const fetchPromise = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });

      const slowFetch = vi.fn().mockReturnValue(fetchPromise);

      const slowService = new FeishuAuthService({
        redis: mockRedis as unknown as import('ioredis').default,
        fetchFn: slowFetch as unknown as typeof fetch,
        refreshBufferSeconds: 300,
        sleep: async () => {},
      });

      // Fire multiple concurrent requests
      const promise1 = slowService.getToken();
      const promise2 = slowService.getToken();
      const promise3 = slowService.getToken();

      // Resolve the single API call
      resolveFetch({
        ok: true,
        json: async () => createSuccessResponse('concurrent-token'),
      } as Response);

      const [token1, token2, token3] = await Promise.all([promise1, promise2, promise3]);

      expect(token1).toBe('concurrent-token');
      expect(token2).toBe('concurrent-token');
      expect(token3).toBe('concurrent-token');
      // Only one API call should have been made
      expect(slowFetch).toHaveBeenCalledTimes(1);

      await slowService.disconnect();
    });

    it('should cache token in Redis with correct TTL', async () => {
      await service.getToken();

      const cachedToken = await mockRedis.get('feishu:token:tenant_access_token');
      const cachedExpiry = await mockRedis.get('feishu:token:tenant_access_token:expiry');

      expect(cachedToken).toBe('test-tenant-token');
      expect(cachedExpiry).toBeDefined();

      const expiryTimestamp = parseInt(cachedExpiry!, 10);
      const now = Math.floor(Date.now() / 1000);
      // Expiry should be approximately now + 7200 (within 2 seconds tolerance)
      expect(expiryTimestamp).toBeGreaterThanOrEqual(now + 7198);
      expect(expiryTimestamp).toBeLessThanOrEqual(now + 7202);
    });
  });

  describe('forceRefresh', () => {
    it('should invalidate cache and fetch a new token', async () => {
      // Populate cache
      const now = Math.floor(Date.now() / 1000);
      await mockRedis.set('feishu:token:tenant_access_token', 'old-token', 'EX', 6000);
      await mockRedis.set(
        'feishu:token:tenant_access_token:expiry',
        String(now + 6000),
        'EX',
        6000,
      );

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createSuccessResponse('fresh-token'),
      });

      const token = await service.forceRefresh();

      expect(token).toBe('fresh-token');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('invalidateCache', () => {
    it('should remove token and expiry from Redis', async () => {
      await mockRedis.set('feishu:token:tenant_access_token', 'some-token', 'EX', 3600);
      await mockRedis.set('feishu:token:tenant_access_token:expiry', '9999999999', 'EX', 3600);

      await service.invalidateCache();

      const token = await mockRedis.get('feishu:token:tenant_access_token');
      const expiry = await mockRedis.get('feishu:token:tenant_access_token:expiry');

      expect(token).toBeNull();
      expect(expiry).toBeNull();
    });
  });

  describe('error handling', () => {
    it('should throw AppError on network failure', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      // withRetry will retry 3 times for feishu_api category, then throw
      await expect(service.getToken()).rejects.toMatchObject({
        code: 'FEISHU_API_TIMEOUT',
        category: 'feishu_api',
        retryable: true,
      });
    });

    it('should throw AppError on non-OK HTTP response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({}),
      });

      await expect(service.getToken()).rejects.toMatchObject({
        code: 'FEISHU_API_UNEXPECTED',
        category: 'feishu_api',
        retryable: true,
      });
    });

    it('should throw AppError on Feishu auth failure (code != 0)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          code: 10003,
          msg: 'app_id or app_secret is invalid',
          tenant_access_token: '',
          expire: 0,
        }),
      });

      await expect(service.getToken()).rejects.toMatchObject({
        code: 'FEISHU_API_AUTH_FAILED',
        category: 'feishu_api',
        retryable: true,
      });
    });

    it('should retry on transient failures then succeed', async () => {
      // First two calls fail, third succeeds
      mockFetch
        .mockRejectedValueOnce(new Error('timeout'))
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => createSuccessResponse('recovered-token'),
        });

      const token = await service.getToken();
      expect(token).toBe('recovered-token');
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe('custom options', () => {
    it('should use custom refresh buffer seconds', async () => {
      const customService = new FeishuAuthService({
        redis: mockRedis as unknown as import('ioredis').default,
        fetchFn: mockFetch as unknown as typeof fetch,
        refreshBufferSeconds: 60, // Only 60 seconds buffer
        sleep: async () => {},
      });

      // Set token expiring in 100 seconds - outside 60s buffer, should use cache
      const now = Math.floor(Date.now() / 1000);
      await mockRedis.set('feishu:token:tenant_access_token', 'buffered-token', 'EX', 100);
      await mockRedis.set(
        'feishu:token:tenant_access_token:expiry',
        String(now + 100),
        'EX',
        100,
      );

      const token = await customService.getToken();
      expect(token).toBe('buffered-token');
      expect(mockFetch).not.toHaveBeenCalled();

      await customService.disconnect();
    });

    it('should use custom Redis key prefix', async () => {
      const customService = new FeishuAuthService({
        redis: mockRedis as unknown as import('ioredis').default,
        fetchFn: mockFetch as unknown as typeof fetch,
        redisKeyPrefix: 'custom:prefix:',
        sleep: async () => {},
      });

      await customService.getToken();

      const cachedToken = await mockRedis.get('custom:prefix:tenant_access_token');
      expect(cachedToken).toBe('test-tenant-token');

      await customService.disconnect();
    });
  });
});
