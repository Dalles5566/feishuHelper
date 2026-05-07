/**
 * Exponential backoff retry strategy.
 *
 * Provides a RetryPolicy type and a `withRetry` function that executes an
 * async operation with configurable retry behaviour based on the error
 * category of any thrown AppError.
 *
 * Delay formula for attempt K (0-indexed):
 *   delay = min(baseDelay * backoffMultiplier^K, maxDelay)
 *
 * This satisfies Property 16 (Exponential Backoff Retry):
 *   For N consecutive failures, delay before retry K is proportional to 2^K,
 *   ensuring each subsequent retry waits at least twice as long as the previous.
 *
 * Requirements: 10.2
 */

import { AppError, type ErrorCategory } from './errors.js';

// ---------------------------------------------------------------------------
// RetryPolicy
// ---------------------------------------------------------------------------

/**
 * Configuration for the retry behaviour of a specific error category.
 */
export interface RetryPolicy {
  /** Maximum number of retry attempts (0 = no retries). */
  maxRetries: number;
  /** Initial delay in milliseconds before the first retry. */
  baseDelay: number;
  /** Upper bound on the computed delay in milliseconds. */
  maxDelay: number;
  /** Multiplier applied to the delay on each successive attempt. */
  backoffMultiplier: number;
}

// ---------------------------------------------------------------------------
// Default policies per error category
// ---------------------------------------------------------------------------

/**
 * Default retry policies keyed by error category.
 *
 * - feishu_api  : up to 3 retries, starting at 1 s, capped at 30 s
 * - llm_service : up to 2 retries, starting at 2 s, capped at 20 s
 * - others      : no retries
 */
export const DEFAULT_RETRY_POLICIES: Record<ErrorCategory, RetryPolicy> = {
  feishu_api: { maxRetries: 3, baseDelay: 1000, maxDelay: 30000, backoffMultiplier: 2 },
  llm_service: { maxRetries: 2, baseDelay: 2000, maxDelay: 20000, backoffMultiplier: 2 },
  state_transition: { maxRetries: 0, baseDelay: 0, maxDelay: 0, backoffMultiplier: 0 },
  validation: { maxRetries: 0, baseDelay: 0, maxDelay: 0, backoffMultiplier: 0 },
  business_logic: { maxRetries: 0, baseDelay: 0, maxDelay: 0, backoffMultiplier: 0 },
};

// ---------------------------------------------------------------------------
// Delay calculation
// ---------------------------------------------------------------------------

/**
 * Compute the delay (in ms) before retry attempt `attemptIndex` (0-indexed).
 *
 * delay = min(baseDelay * backoffMultiplier^attemptIndex, maxDelay)
 *
 * @param policy       - The retry policy to use.
 * @param attemptIndex - Zero-based index of the retry attempt (0 = first retry).
 * @returns            Delay in milliseconds.
 */
export function computeDelay(policy: RetryPolicy, attemptIndex: number): number {
  if (policy.maxRetries === 0 || policy.baseDelay === 0) return 0;
  const raw = policy.baseDelay * Math.pow(policy.backoffMultiplier, attemptIndex);
  return Math.min(raw, policy.maxDelay);
}

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

/**
 * Options for `withRetry`.
 */
export interface RetryOptions {
  /**
   * Override the default retry policies.
   * Merged with DEFAULT_RETRY_POLICIES so you only need to specify the
   * categories you want to change.
   */
  policies?: Partial<Record<ErrorCategory, RetryPolicy>>;
  /**
   * Inject a custom sleep function (useful in tests to avoid real delays).
   * Defaults to a real `setTimeout`-based sleep.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Called after each failed attempt before the next retry.
   * Receives the error and the 0-based attempt index that just failed.
   */
  onRetry?: (error: AppError, attemptIndex: number) => void;
}

/**
 * Execute `fn` with automatic retry on retryable AppErrors.
 *
 * The retry policy is selected based on the `category` of the thrown AppError.
 * Non-AppError exceptions are wrapped and treated as non-retryable
 * `business_logic` errors.
 *
 * @param fn      - Async function to execute.
 * @param options - Optional retry configuration.
 * @returns       The resolved value of `fn` on success.
 * @throws        The last AppError if all retries are exhausted, or the
 *                original error if it is not retryable.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const policies: Record<ErrorCategory, RetryPolicy> = {
    ...DEFAULT_RETRY_POLICIES,
    ...options.policies,
  };

  const sleep = options.sleep ?? defaultSleep;

  let lastError: AppError | null = null;

  // attemptIndex 0 = initial call, 1..maxRetries = retries
  for (let attemptIndex = 0; ; attemptIndex++) {
    try {
      return await fn();
    } catch (err) {
      const appError = AppError.from(err);
      lastError = appError;

      const policy = policies[appError.category];

      // Not retryable or no retries configured
      if (!appError.retryable || policy.maxRetries === 0) {
        throw appError;
      }

      // Exhausted all retries
      if (attemptIndex >= policy.maxRetries) {
        throw appError;
      }

      // Compute delay for this retry (attemptIndex is the 0-based retry index)
      const delay = computeDelay(policy, attemptIndex);

      options.onRetry?.(appError, attemptIndex);

      if (delay > 0) {
        await sleep(delay);
      }
    }
  }

  // TypeScript requires a return/throw after the loop; this is unreachable.
  throw lastError;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Default sleep implementation using setTimeout.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
