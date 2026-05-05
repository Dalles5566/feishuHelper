import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildConfig, getConfig, resetConfig } from './index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal set of env vars that satisfy all required checks. */
const REQUIRED_ENV: Record<string, string> = {
  FEISHU_APP_ID: 'cli_test_app_id',
  FEISHU_APP_SECRET: 'test_app_secret',
  FEISHU_VERIFICATION_TOKEN: 'test_verification_token',
  LLM_API_KEY: 'sk-test-key',
  DB_PASSWORD: 'test_db_password',
};

function setRequiredEnv(overrides: Record<string, string> = {}): void {
  for (const [key, value] of Object.entries({ ...REQUIRED_ENV, ...overrides })) {
    process.env[key] = value;
  }
}

function clearEnv(): void {
  const allKeys = [
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'FEISHU_VERIFICATION_TOKEN',
    'FEISHU_ENCRYPT_KEY',
    'LLM_PROVIDER',
    'LLM_API_KEY',
    'LLM_MODEL',
    'LLM_MAX_TOKENS',
    'LLM_TIMEOUT_MS',
    'DB_HOST',
    'DB_PORT',
    'DB_NAME',
    'DB_USER',
    'DB_PASSWORD',
    'DB_MAX_CONNECTIONS',
    'DB_IDLE_TIMEOUT_MS',
    'DB_CONNECTION_TIMEOUT_MS',
    'REDIS_HOST',
    'REDIS_PORT',
    'REDIS_PASSWORD',
    'REDIS_DB',
    'REDIS_CONNECT_TIMEOUT_MS',
    'PORT',
    'HOST',
    'NODE_ENV',
    'LOG_LEVEL',
    'MAX_RETRIES',
    'RETRY_BASE_DELAY_MS',
    'RETRY_MAX_DELAY_MS',
  ];
  for (const key of allKeys) {
    delete process.env[key];
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('config/index', () => {
  beforeEach(() => {
    clearEnv();
    resetConfig();
  });

  afterEach(() => {
    clearEnv();
    resetConfig();
  });

  // -------------------------------------------------------------------------
  // buildConfig — validation
  // -------------------------------------------------------------------------

  describe('buildConfig — required variable validation', () => {
    it('should throw when all required variables are missing', () => {
      expect(() => buildConfig()).toThrow(/Missing required environment variables/);
    });

    it('should list every missing required variable in the error message', () => {
      expect(() => buildConfig()).toThrow(
        /FEISHU_APP_ID.*FEISHU_APP_SECRET.*FEISHU_VERIFICATION_TOKEN.*LLM_API_KEY.*DB_PASSWORD/s,
      );
    });

    it('should throw when only some required variables are missing', () => {
      process.env['FEISHU_APP_ID'] = 'cli_test';
      process.env['FEISHU_APP_SECRET'] = 'secret';
      // FEISHU_VERIFICATION_TOKEN, LLM_API_KEY, DB_PASSWORD still missing
      expect(() => buildConfig()).toThrow(/FEISHU_VERIFICATION_TOKEN/);
    });

    it('should treat empty-string values as missing', () => {
      setRequiredEnv({ FEISHU_APP_ID: '' });
      expect(() => buildConfig()).toThrow(/FEISHU_APP_ID/);
    });

    it('should treat whitespace-only values as missing', () => {
      setRequiredEnv({ LLM_API_KEY: '   ' });
      expect(() => buildConfig()).toThrow(/LLM_API_KEY/);
    });

    it('should succeed when all required variables are set', () => {
      setRequiredEnv();
      expect(() => buildConfig()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // buildConfig — Feishu config
  // -------------------------------------------------------------------------

  describe('buildConfig — feishu config', () => {
    it('should read FEISHU_APP_ID and FEISHU_APP_SECRET', () => {
      setRequiredEnv();
      const config = buildConfig();
      expect(config.feishu.appId).toBe('cli_test_app_id');
      expect(config.feishu.appSecret).toBe('test_app_secret');
    });

    it('should read FEISHU_VERIFICATION_TOKEN', () => {
      setRequiredEnv();
      const config = buildConfig();
      expect(config.feishu.verificationToken).toBe('test_verification_token');
    });

    it('should default encryptKey to empty string when not set', () => {
      setRequiredEnv();
      const config = buildConfig();
      expect(config.feishu.encryptKey).toBe('');
    });

    it('should read FEISHU_ENCRYPT_KEY when provided', () => {
      setRequiredEnv({ FEISHU_ENCRYPT_KEY: 'my_encrypt_key' });
      const config = buildConfig();
      expect(config.feishu.encryptKey).toBe('my_encrypt_key');
    });
  });

  // -------------------------------------------------------------------------
  // buildConfig — LLM config
  // -------------------------------------------------------------------------

  describe('buildConfig — llm config', () => {
    it('should read LLM_API_KEY', () => {
      setRequiredEnv();
      const config = buildConfig();
      expect(config.llm.apiKey).toBe('sk-test-key');
    });

    it('should default provider to openai', () => {
      setRequiredEnv();
      const config = buildConfig();
      expect(config.llm.provider).toBe('openai');
    });

    it('should read LLM_PROVIDER when provided', () => {
      setRequiredEnv({ LLM_PROVIDER: 'anthropic' });
      const config = buildConfig();
      expect(config.llm.provider).toBe('anthropic');
    });

    it('should default model to gpt-4o', () => {
      setRequiredEnv();
      const config = buildConfig();
      expect(config.llm.model).toBe('gpt-4o');
    });

    it('should default maxTokens to 4096', () => {
      setRequiredEnv();
      const config = buildConfig();
      expect(config.llm.maxTokens).toBe(4096);
    });

    it('should parse LLM_MAX_TOKENS as integer', () => {
      setRequiredEnv({ LLM_MAX_TOKENS: '8192' });
      const config = buildConfig();
      expect(config.llm.maxTokens).toBe(8192);
    });

    it('should default timeoutMs to 60000', () => {
      setRequiredEnv();
      const config = buildConfig();
      expect(config.llm.timeoutMs).toBe(60000);
    });
  });

  // -------------------------------------------------------------------------
  // buildConfig — database config
  // -------------------------------------------------------------------------

  describe('buildConfig — database config', () => {
    it('should read DB_PASSWORD', () => {
      setRequiredEnv();
      const config = buildConfig();
      expect(config.database.password).toBe('test_db_password');
    });

    it('should default host to localhost', () => {
      setRequiredEnv();
      const config = buildConfig();
      expect(config.database.host).toBe('localhost');
    });

    it('should default port to 5432', () => {
      setRequiredEnv();
      const config = buildConfig();
      expect(config.database.port).toBe(5432);
    });

    it('should parse DB_PORT as integer', () => {
      setRequiredEnv({ DB_PORT: '5433' });
      const config = buildConfig();
      expect(config.database.port).toBe(5433);
    });

    it('should default database name to feishu_helper', () => {
      setRequiredEnv();
      const config = buildConfig();
      expect(config.database.database).toBe('feishu_helper');
    });

    it('should default maxConnections to 20', () => {
      setRequiredEnv();
      const config = buildConfig();
      expect(config.database.maxConnections).toBe(20);
    });
  });

  // -------------------------------------------------------------------------
  // buildConfig — redis config
  // -------------------------------------------------------------------------

  describe('buildConfig — redis config', () => {
    it('should default host to localhost', () => {
      setRequiredEnv();
      const config = buildConfig();
      expect(config.redis.host).toBe('localhost');
    });

    it('should default port to 6379', () => {
      setRequiredEnv();
      const config = buildConfig();
      expect(config.redis.port).toBe(6379);
    });

    it('should default password to empty string', () => {
      setRequiredEnv();
      const config = buildConfig();
      expect(config.redis.password).toBe('');
    });

    it('should default db index to 0', () => {
      setRequiredEnv();
      const config = buildConfig();
      expect(config.redis.db).toBe(0);
    });

    it('should parse REDIS_PORT as integer', () => {
      setRequiredEnv({ REDIS_PORT: '6380' });
      const config = buildConfig();
      expect(config.redis.port).toBe(6380);
    });
  });

  // -------------------------------------------------------------------------
  // buildConfig — app config
  // -------------------------------------------------------------------------

  describe('buildConfig — app config', () => {
    it('should default port to 3000', () => {
      setRequiredEnv();
      const config = buildConfig();
      expect(config.app.port).toBe(3000);
    });

    it('should parse PORT as integer', () => {
      setRequiredEnv({ PORT: '8080' });
      const config = buildConfig();
      expect(config.app.port).toBe(8080);
    });

    it('should default nodeEnv to development', () => {
      setRequiredEnv();
      const config = buildConfig();
      expect(config.app.nodeEnv).toBe('development');
    });

    it('should recognise production nodeEnv', () => {
      setRequiredEnv({ NODE_ENV: 'production' });
      const config = buildConfig();
      expect(config.app.nodeEnv).toBe('production');
    });

    it('should recognise test nodeEnv', () => {
      setRequiredEnv({ NODE_ENV: 'test' });
      const config = buildConfig();
      expect(config.app.nodeEnv).toBe('test');
    });

    it('should fall back to development for unknown NODE_ENV values', () => {
      setRequiredEnv({ NODE_ENV: 'staging' });
      const config = buildConfig();
      expect(config.app.nodeEnv).toBe('development');
    });

    it('should default maxRetries to 3', () => {
      setRequiredEnv();
      const config = buildConfig();
      expect(config.app.maxRetries).toBe(3);
    });

    it('should default retryBaseDelayMs to 1000', () => {
      setRequiredEnv();
      const config = buildConfig();
      expect(config.app.retryBaseDelayMs).toBe(1000);
    });

    it('should default retryMaxDelayMs to 30000', () => {
      setRequiredEnv();
      const config = buildConfig();
      expect(config.app.retryMaxDelayMs).toBe(30000);
    });
  });

  // -------------------------------------------------------------------------
  // getConfig — singleton behaviour
  // -------------------------------------------------------------------------

  describe('getConfig — singleton', () => {
    it('should return the same instance on repeated calls', () => {
      setRequiredEnv();
      const first = getConfig();
      const second = getConfig();
      expect(first).toBe(second);
    });

    it('should rebuild the config when force=true is passed', () => {
      setRequiredEnv();
      const first = getConfig();
      const second = getConfig(true);
      // Different object reference after forced rebuild
      expect(first).not.toBe(second);
    });

    it('should reflect env changes after resetConfig + getConfig', () => {
      setRequiredEnv({ LLM_MODEL: 'gpt-4-turbo' });
      const first = getConfig();
      expect(first.llm.model).toBe('gpt-4-turbo');

      resetConfig();
      process.env['LLM_MODEL'] = 'claude-3-5-sonnet-20241022';
      const second = getConfig();
      expect(second.llm.model).toBe('claude-3-5-sonnet-20241022');
    });
  });
});
