/**
 * Unit tests for the retry utility (computeDelay and withRetry).
 *
 * Requirements: 10.2
 */

import { describe, it, expect, vi } from 'vitest';
import { AppError } from './errors.js';
import {
  computeDelay,
  withRetry,
  DEFAULT_RETRY_POLICIES,
  type RetryPolicy,
} from './retry.js';

// ---------------------------------------------------------------------------
// computeDelay
// ---------------------------------------------------------------------------

describe('computeDelay()', () => {
  const policy: RetryPolicy = {
    maxRetries: 3,
    baseDelay: 1000,
    maxDelay: 30000,
    backoffMultiplier: 2,
  };

  it('returns 0 for attempt 0 with zero-retry policy', () => {
    const noRetry: RetryPolicy = { maxRetries: 0, baseDelay: 0, maxDelay: 0, backoffMultiplier: 0 };
    expect(computeDelay(noRetry, 0)).toBe(0);
  });

  it('returns baseDelay for attempt 0', () => {
    // 1000 * 2^0 = 1000
    expect(computeDelay(policy, 0)).toBe(1000);
  });

  it('doubles the delay on each attempt', () => {
    // attempt 0: 1000 * 2^0 = 1000
    // attempt 1: 1000 * 2^1 = 2000
    // attempt 2: 1000 * 2^2 = 4000
    expect(computeDelay(policy, 0)).toBe(1000);
    expect(computeDelay(policy, 1)).toBe(2000);
    expect(computeDelay(policy, 2)).toBe(4000);
  });

  it('caps the delay at maxDelay', () => {
    const cappedPolicy: RetryPolicy = {
      maxRetries: 10,
      baseDelay: 1000,
      maxDelay: 5000,
      backoffMultiplier: 2,
    };
    // attempt 3: 1000 * 2^3 = 8000 → capped at 5000
    expect(computeDelay(cappedPolicy, 3)).toBe(5000);
    expect(computeDelay(cappedPolicy, 10)).toBe(5000);
  });

  it('each retry delay is at least twice the previous (exponential property)', () => {
    for (let i = 0; i < policy.maxRetries - 1; i++) {
      const current = computeDelay(policy, i);
      const next = computeDelay(policy, i + 1);
      // next should be at least 2x current (unless capped)
      if (next < policy.maxDelay) {
        expect(next).toBeGreaterThanOrEqual(current * policy.backoffMultiplier);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_RETRY_POLICIES
// ---------------------------------------------------------------------------

describe('DEFAULT_RETRY_POLICIES', () => {
  it('feishu_api allows 3 retries', () => {
    expect(DEFAULT_RETRY_POLICIES.feishu_api.maxRetries).toBe(3);
    expect(DEFAULT_RETRY_POLICIES.feishu_api.retryable).toBeUndefined(); // policy has no retryable field
  });

  it('llm_service allows 2 retries', () => {
    expect(DEFAULT_RETRY_POLICIES.llm_service.maxRetries).toBe(2);
  });

  it('state_transition, validation, business_logic have 0 retries', () => {
    expect(DEFAULT_RETRY_POLICIES.state_transition.maxRetries).toBe(0);
    expect(DEFAULT_RETRY_POLICIES.validation.maxRetries).toBe(0);
    expect(DEFAULT_RETRY_POLICIES.business_logic.maxRetries).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// withRetry — success path
// ---------------------------------------------------------------------------

describe('withRetry() — success', () => {
  it('returns the value immediately when fn succeeds on first call', async () => {
    const result = await withRetry(async () => 42);
    expect(result).toBe(42);
  });

  it('succeeds after one failure then success', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw AppError.feishuApi('CODE', 'fail');
        return 'ok';
      },
      { sleep: async () => {} },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// withRetry — non-retryable errors
// ---------------------------------------------------------------------------

describe('withRetry() — non-retryable errors', () => {
  it('throws immediately for validation errors without retrying', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw AppError.validation('V', 'bad input');
      }),
    ).rejects.toMatchObject({ category: 'validation' });
    expect(calls).toBe(1);
  });

  it('throws immediately for state_transition errors', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw AppError.stateTransition('S', 'invalid');
      }),
    ).rejects.toMatchObject({ category: 'state_transition' });
    expect(calls).toBe(1);
  });

  it('throws immediately for business_logic errors', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw AppError.businessLogic('B', 'not found');
      }),
    ).rejects.toMatchObject({ category: 'business_logic' });
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// withRetry — retry exhaustion
// ---------------------------------------------------------------------------

describe('withRetry() — retry exhaustion', () => {
  it('retries feishu_api errors up to maxRetries times then throws', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw AppError.feishuApi('TIMEOUT', 'timeout');
        },
        { sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ category: 'feishu_api' });
    // 1 initial + 3 retries = 4 total calls
    expect(calls).toBe(4);
  });

  it('retries llm_service errors up to 2 times then throws', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw AppError.llmService('LLM_DOWN', 'unavailable');
        },
        { sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ category: 'llm_service' });
    // 1 initial + 2 retries = 3 total calls
    expect(calls).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// withRetry — delay behaviour
// ---------------------------------------------------------------------------

describe('withRetry() — delay behaviour', () => {
  it('calls sleep with increasing delays for feishu_api errors', async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => { delays.push(ms); };

    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw AppError.feishuApi('TIMEOUT', 'timeout');
        },
        { sleep },
      ),
    ).rejects.toBeDefined();

    // 3 retries → 3 sleep calls with delays 1000, 2000, 4000
    expect(delays).toHaveLength(3);
    expect(delays[0]).toBe(1000);
    expect(delays[1]).toBe(2000);
    expect(delays[2]).toBe(4000);
  });

  it('each delay is at least twice the previous', async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => { delays.push(ms); };

    await expect(
      withRetry(
        async () => { throw AppError.feishuApi('T', 'fail'); },
        { sleep },
      ),
    ).rejects.toBeDefined();

    for (let i = 1; i < delays.length; i++) {
      const prev = delays[i - 1]!;
      const curr = delays[i]!;
      // curr should be at least 2x prev (unless capped at maxDelay)
      if (curr < DEFAULT_RETRY_POLICIES.feishu_api.maxDelay) {
        expect(curr).toBeGreaterThanOrEqual(prev * 2);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// withRetry — onRetry callback
// ---------------------------------------------------------------------------

describe('withRetry() — onRetry callback', () => {
  it('calls onRetry with the error and attempt index', async () => {
    const retries: Array<{ error: AppError; attempt: number }> = [];

    await expect(
      withRetry(
        async () => { throw AppError.feishuApi('T', 'fail'); },
        {
          sleep: async () => {},
          onRetry: (error, attempt) => retries.push({ error, attempt }),
        },
      ),
    ).rejects.toBeDefined();

    expect(retries).toHaveLength(3);
    expect(retries[0]!.attempt).toBe(0);
    expect(retries[1]!.attempt).toBe(1);
    expect(retries[2]!.attempt).toBe(2);
    expect(retries[0]!.error.category).toBe('feishu_api');
  });
});

// ---------------------------------------------------------------------------
// withRetry — plain Error wrapping
// ---------------------------------------------------------------------------

describe('withRetry() — plain Error wrapping', () => {
  it('wraps a plain Error as a non-retryable AppError', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new Error('plain error');
      }),
    ).rejects.toMatchObject({ message: 'plain error', retryable: false });
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// withRetry — custom policy override
// ---------------------------------------------------------------------------

describe('withRetry() — custom policy override', () => {
  it('respects a custom policy for feishu_api', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw AppError.feishuApi('T', 'fail');
        },
        {
          sleep: async () => {},
          policies: {
            feishu_api: { maxRetries: 1, baseDelay: 500, maxDelay: 1000, backoffMultiplier: 2 },
          },
        },
      ),
    ).rejects.toBeDefined();
    // 1 initial + 1 retry = 2 total calls
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// withRetry — succeeds within retry window
// ---------------------------------------------------------------------------

describe('withRetry() — succeeds within retry window', () => {
  it('succeeds on the last allowed retry', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        // Fail first 3 times (initial + 2 retries), succeed on 4th (3rd retry)
        if (calls < 4) throw AppError.feishuApi('T', 'fail');
        return 'success';
      },
      { sleep: async () => {} },
    );
    expect(result).toBe('success');
    expect(calls).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Spy-based test to verify no real timers are used
// ---------------------------------------------------------------------------

describe('withRetry() — no real delays in tests', () => {
  it('completes instantly when sleep is mocked', async () => {
    const start = Date.now();
    await expect(
      withRetry(
        async () => { throw AppError.feishuApi('T', 'fail'); },
        { sleep: async () => {} },
      ),
    ).rejects.toBeDefined();
    const elapsed = Date.now() - start;
    // Should complete in well under 100ms (no real sleeps)
    expect(elapsed).toBeLessThan(500);
  });
});
