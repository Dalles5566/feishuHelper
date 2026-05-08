/**
 * Feishu authentication and token management service.
 *
 * Implements OAuth 2.0 App credentials (tenant_access_token) authentication
 * with proactive token refresh (before expiration) and Redis caching.
 *
 * Requirements: 10.1 (Feishu auth credentials), 10.3 (auto token refresh)
 */

import { Redis } from 'ioredis';
import { getConfig } from '../config/index.js';
import { AppError, FeishuErrorCodes } from '../utils/errors.js';
import { withRetry } from '../utils/retry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Response from Feishu's tenant_access_token endpoint. */
export interface TenantAccessTokenResponse {
  code: number;
  msg: string;
  tenant_access_token: string;
  expire: number; // seconds until expiration
}

/** Options for creating a FeishuAuthService instance. */
export interface FeishuAuthOptions {
  /** Override the Redis instance (useful for testing). */
  redis?: Redis;
  /** Override the fetch function (useful for testing). */
  fetchFn?: typeof fetch;
  /** Buffer time in seconds before expiration to trigger proactive refresh. Default: 300 (5 min). */
  refreshBufferSeconds?: number;
  /** Redis key prefix for token storage. */
  redisKeyPrefix?: string;
  /** Override the sleep function used in retry (useful for testing to avoid real delays). */
  sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FEISHU_TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const DEFAULT_REFRESH_BUFFER_SECONDS = 300; // 5 minutes before expiry
const DEFAULT_REDIS_KEY_PREFIX = 'feishu:token:';

// ---------------------------------------------------------------------------
// FeishuAuthService
// ---------------------------------------------------------------------------

/**
 * Manages Feishu tenant access token lifecycle:
 * - Fetches token using app credentials
 * - Caches token in Redis with TTL
 * - Proactively refreshes before expiration
 */
export class FeishuAuthService {
  private readonly redis: Redis;
  private readonly fetchFn: typeof fetch;
  private readonly refreshBufferSeconds: number;
  private readonly redisKeyPrefix: string;
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly sleep?: (ms: number) => Promise<void>;

  // In-memory lock to prevent concurrent refresh requests
  private refreshPromise: Promise<string> | null = null;

  constructor(options: FeishuAuthOptions = {}) {
    const config = getConfig();

    this.appId = config.feishu.appId;
    this.appSecret = config.feishu.appSecret;
    this.refreshBufferSeconds = options.refreshBufferSeconds ?? DEFAULT_REFRESH_BUFFER_SECONDS;
    this.redisKeyPrefix = options.redisKeyPrefix ?? DEFAULT_REDIS_KEY_PREFIX;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.sleep = options.sleep;

    if (options.redis) {
      this.redis = options.redis;
    } else {
      this.redis = new Redis({
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password || undefined,
        db: config.redis.db,
        connectTimeout: config.redis.connectTimeoutMs,
        lazyConnect: true,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Get a valid tenant access token.
   *
   * Returns a cached token from Redis if still valid (with buffer time).
   * Otherwise fetches a new token from Feishu API and caches it.
   */
  async getToken(): Promise<string> {
    // Try to get cached token
    const cached = await this.getCachedToken();
    if (cached) {
      return cached;
    }

    // Prevent concurrent refresh - reuse in-flight promise
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.refreshToken();
    try {
      const token = await this.refreshPromise;
      return token;
    } finally {
      this.refreshPromise = null;
    }
  }

  /**
   * Force refresh the token regardless of cache state.
   * Useful when a 401 is received from Feishu API.
   */
  async forceRefresh(): Promise<string> {
    // Invalidate cache first
    await this.invalidateCache();
    return this.refreshToken();
  }

  /**
   * Invalidate the cached token in Redis.
   */
  async invalidateCache(): Promise<void> {
    await this.redis.del(this.tokenKey());
    await this.redis.del(this.tokenExpiryKey());
  }

  /**
   * Disconnect the Redis client. Call during graceful shutdown.
   */
  async disconnect(): Promise<void> {
    await this.redis.quit();
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  /**
   * Get the cached token from Redis if it's still valid (with buffer).
   */
  private async getCachedToken(): Promise<string | null> {
    const [token, expiryStr] = await Promise.all([
      this.redis.get(this.tokenKey()),
      this.redis.get(this.tokenExpiryKey()),
    ]);

    if (!token || !expiryStr) {
      return null;
    }

    const expiryTimestamp = parseInt(expiryStr, 10);
    const now = Math.floor(Date.now() / 1000);

    // Check if token will expire within the buffer window
    if (now >= expiryTimestamp - this.refreshBufferSeconds) {
      return null; // Token is about to expire, trigger refresh
    }

    return token;
  }

  /**
   * Fetch a new token from Feishu API and cache it in Redis.
   */
  private async refreshToken(): Promise<string> {
    const tokenResponse = await withRetry(
      () => this.fetchTenantAccessToken(),
      {
        sleep: this.sleep,
        onRetry: (error, attemptIndex) => {
          console.warn(
            `[FeishuAuth] Token refresh retry attempt ${attemptIndex + 1}: ${error.message}`,
          );
        },
      },
    );

    // Cache the token in Redis with appropriate TTL
    const ttlSeconds = tokenResponse.expire;
    const expiryTimestamp = Math.floor(Date.now() / 1000) + ttlSeconds;

    await Promise.all([
      this.redis.set(this.tokenKey(), tokenResponse.tenant_access_token, 'EX', ttlSeconds),
      this.redis.set(this.tokenExpiryKey(), String(expiryTimestamp), 'EX', ttlSeconds),
    ]);

    return tokenResponse.tenant_access_token;
  }

  /**
   * Call Feishu API to get a tenant access token using app credentials.
   */
  private async fetchTenantAccessToken(): Promise<TenantAccessTokenResponse> {
    let response: Response;

    try {
      response = await this.fetchFn(FEISHU_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          app_id: this.appId,
          app_secret: this.appSecret,
        }),
      });
    } catch (err) {
      throw AppError.feishuApi(
        FeishuErrorCodes.TIMEOUT,
        'Failed to connect to Feishu token endpoint',
        err,
        'Check network connectivity and Feishu API status',
      );
    }

    if (!response.ok) {
      throw AppError.feishuApi(
        FeishuErrorCodes.UNEXPECTED,
        `Feishu token endpoint returned HTTP ${response.status}`,
        { status: response.status, statusText: response.statusText },
        'Check Feishu API status or contact support',
      );
    }

    const data = (await response.json()) as TenantAccessTokenResponse;

    if (data.code !== 0) {
      throw AppError.feishuApi(
        FeishuErrorCodes.AUTH_FAILED,
        `Feishu authentication failed: ${data.msg}`,
        { code: data.code, msg: data.msg },
        'Verify FEISHU_APP_ID and FEISHU_APP_SECRET are correct',
      );
    }

    return data;
  }

  // ---------------------------------------------------------------------------
  // Redis key helpers
  // ---------------------------------------------------------------------------

  private tokenKey(): string {
    return `${this.redisKeyPrefix}tenant_access_token`;
  }

  private tokenExpiryKey(): string {
    return `${this.redisKeyPrefix}tenant_access_token:expiry`;
  }
}
