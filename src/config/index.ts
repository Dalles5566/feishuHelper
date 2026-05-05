/**
 * Application configuration module.
 *
 * Reads all configuration from environment variables, validates required values
 * at startup, and exports a single typed config object grouped by concern.
 *
 * Requirements: 10.1 (Feishu auth credentials), 10.4 (sensitive data handling)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeishuConfig {
  /** Feishu Open Platform App ID */
  appId: string;
  /** Feishu Open Platform App Secret */
  appSecret: string;
  /** Webhook verification token (for event signature validation) */
  verificationToken: string;
  /** Encrypt key for Feishu event decryption (optional) */
  encryptKey: string;
}

export interface LlmConfig {
  /** LLM provider: 'openai' | 'anthropic' */
  provider: string;
  /** API key for the LLM provider */
  apiKey: string;
  /** Model name to use (e.g. 'gpt-4o', 'claude-3-5-sonnet-20241022') */
  model: string;
  /** Maximum tokens per LLM request */
  maxTokens: number;
  /** Request timeout in milliseconds */
  timeoutMs: number;
}

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  maxConnections: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
}

export interface RedisConfig {
  host: string;
  port: number;
  password: string;
  /** Redis database index (0-15) */
  db: number;
  /** Connection timeout in milliseconds */
  connectTimeoutMs: number;
}

export interface AppConfig {
  /** HTTP server port */
  port: number;
  /** Bind host */
  host: string;
  /** Runtime environment */
  nodeEnv: 'development' | 'production' | 'test';
  /** Log level */
  logLevel: string;
  /** Maximum retry attempts for external API calls */
  maxRetries: number;
  /** Base delay (ms) for exponential backoff */
  retryBaseDelayMs: number;
  /** Maximum delay (ms) cap for exponential backoff */
  retryMaxDelayMs: number;
}

export interface Config {
  feishu: FeishuConfig;
  llm: LlmConfig;
  database: DatabaseConfig;
  redis: RedisConfig;
  app: AppConfig;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Collect all missing required environment variable names.
 */
function collectMissing(required: string[]): string[] {
  return required.filter((key) => {
    const value = process.env[key];
    return value === undefined || value.trim() === '';
  });
}

/**
 * Parse an integer env var, falling back to a default value.
 */
function envInt(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Read a string env var, falling back to a default value.
 */
function envStr(key: string, defaultValue: string): string {
  const value = process.env[key];
  return value !== undefined && value.trim() !== '' ? value.trim() : defaultValue;
}

// ---------------------------------------------------------------------------
// Config builder
// ---------------------------------------------------------------------------

/**
 * Build and validate the application configuration from environment variables.
 *
 * Throws a descriptive error listing ALL missing required variables so the
 * operator can fix them in one go rather than discovering them one by one.
 */
export function buildConfig(): Config {
  // Required variables — the application cannot start without these
  const required = [
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'FEISHU_VERIFICATION_TOKEN',
    'LLM_API_KEY',
    'DB_PASSWORD',
  ];

  const missing = collectMissing(required);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n  ${missing.join('\n  ')}\n` +
        'Please set them in your .env file or environment before starting the application.',
    );
  }

  const feishu: FeishuConfig = {
    appId: process.env['FEISHU_APP_ID']!,
    appSecret: process.env['FEISHU_APP_SECRET']!,
    verificationToken: process.env['FEISHU_VERIFICATION_TOKEN']!,
    encryptKey: envStr('FEISHU_ENCRYPT_KEY', ''),
  };

  const llm: LlmConfig = {
    provider: envStr('LLM_PROVIDER', 'openai'),
    apiKey: process.env['LLM_API_KEY']!,
    model: envStr('LLM_MODEL', 'gpt-4o'),
    maxTokens: envInt('LLM_MAX_TOKENS', 4096),
    timeoutMs: envInt('LLM_TIMEOUT_MS', 60000),
  };

  const database: DatabaseConfig = {
    host: envStr('DB_HOST', 'localhost'),
    port: envInt('DB_PORT', 5432),
    database: envStr('DB_NAME', 'feishu_helper'),
    user: envStr('DB_USER', 'postgres'),
    password: process.env['DB_PASSWORD']!,
    maxConnections: envInt('DB_MAX_CONNECTIONS', 20),
    idleTimeoutMs: envInt('DB_IDLE_TIMEOUT_MS', 30000),
    connectionTimeoutMs: envInt('DB_CONNECTION_TIMEOUT_MS', 5000),
  };

  const redis: RedisConfig = {
    host: envStr('REDIS_HOST', 'localhost'),
    port: envInt('REDIS_PORT', 6379),
    password: envStr('REDIS_PASSWORD', ''),
    db: envInt('REDIS_DB', 0),
    connectTimeoutMs: envInt('REDIS_CONNECT_TIMEOUT_MS', 5000),
  };

  const rawEnv = envStr('NODE_ENV', 'development');
  const nodeEnv: AppConfig['nodeEnv'] =
    rawEnv === 'production' ? 'production' : rawEnv === 'test' ? 'test' : 'development';

  const app: AppConfig = {
    port: envInt('PORT', 3000),
    host: envStr('HOST', '0.0.0.0'),
    nodeEnv,
    logLevel: envStr('LOG_LEVEL', 'info'),
    maxRetries: envInt('MAX_RETRIES', 3),
    retryBaseDelayMs: envInt('RETRY_BASE_DELAY_MS', 1000),
    retryMaxDelayMs: envInt('RETRY_MAX_DELAY_MS', 30000),
  };

  return { feishu, llm, database, redis, app };
}

// ---------------------------------------------------------------------------
// Singleton config instance
// ---------------------------------------------------------------------------

let _config: Config | null = null;

/**
 * Return the application config singleton.
 *
 * On first call the config is built and validated; subsequent calls return the
 * cached instance.  Pass `force = true` to rebuild (useful in tests).
 */
export function getConfig(force = false): Config {
  if (_config && !force) {
    return _config;
  }
  _config = buildConfig();
  return _config;
}

/**
 * Reset the cached config instance (useful for testing).
 */
export function resetConfig(): void {
  _config = null;
}
