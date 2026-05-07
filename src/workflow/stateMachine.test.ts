/**
 * Unit tests for the task workflow state machine.
 *
 * Database calls are mocked so these tests run without a real PostgreSQL
 * instance.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockInstance } from 'vitest';
import type pg from 'pg';

// ---------------------------------------------------------------------------
// Mock the db utilities BEFORE importing the module under test so that the
// module picks up the mocked versions.
// ---------------------------------------------------------------------------
vi.mock('../utils/db.js', () => ({
  withTransaction: vi.fn(),
  clientQuery: vi.fn(),
}));

import * as db from '../utils/db.js';
import { validateTransition, transition, getValidNextStates } from './stateMachine.js';
import { AppError } from '../utils/errors.js';
import type { TaskState } from '../models/task.js';
import type { TransitionContext } from '../models/workflow.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal TransitionContext for tests. */
function makeContext(overrides: Partial<TransitionContext> = {}): TransitionContext {
  return {
    trigger: 'test_trigger',
    actor: 'user_123',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateTransition
// ---------------------------------------------------------------------------

describe('validateTransition', () => {
  // --- Valid forward transitions ---
  const validPairs: [TaskState, TaskState][] = [
    ['Created', 'Assigned'],
    ['Assigned', 'InDevelopment'],
    ['InDevelopment', 'VerificationPending'],
    ['VerificationPending', 'VerificationPassed'],
    ['VerificationPending', 'VerificationFailed'],
    ['VerificationFailed', 'InDevelopment'],
    ['VerificationPassed', 'QAPending'],
    ['QAPending', 'QAPassed'],
    ['QAPending', 'QAFailed'],
    ['QAFailed', 'InDevelopment'],
    ['QAPassed', 'DocumentationUpdated'],
    ['DocumentationUpdated', 'Completed'],
  ];

  it.each(validPairs)('allows %s → %s', (from, to) => {
    expect(validateTransition(from, to)).toBe(true);
  });

  // --- Valid revert / meeting-update transitions ---
  const revertPairs: [TaskState, TaskState][] = [
    ['Assigned', 'Created'],
    ['InDevelopment', 'Created'],
    ['VerificationFailed', 'Created'],
    ['QAFailed', 'Created'],
    ['Created', 'Created'], // self-transition for meeting re-trigger
  ];

  it.each(revertPairs)('allows revert %s → %s', (from, to) => {
    expect(validateTransition(from, to)).toBe(true);
  });

  // --- Invalid transitions ---
  const invalidPairs: [TaskState, TaskState][] = [
    ['Created', 'InDevelopment'],       // skips Assigned
    ['Created', 'Completed'],           // skips everything
    ['Assigned', 'VerificationPending'],// skips InDevelopment
    ['Completed', 'Created'],           // no going back from Completed
    ['VerificationPassed', 'Created'],  // not a defined revert
    ['QAPassed', 'Created'],            // not a defined revert
    ['DocumentationUpdated', 'QAPending'], // backwards
  ];

  it.each(invalidPairs)('rejects %s → %s', (from, to) => {
    expect(validateTransition(from, to)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getValidNextStates
// ---------------------------------------------------------------------------

describe('getValidNextStates', () => {
  it('returns correct next states for Created', () => {
    const next = getValidNextStates('Created');
    expect(next).toContain('Assigned');
    expect(next).toContain('Created'); // self-transition
    expect(next).not.toContain('InDevelopment');
  });

  it('returns correct next states for VerificationPending', () => {
    const next = getValidNextStates('VerificationPending');
    expect(next).toContain('VerificationPassed');
    expect(next).toContain('VerificationFailed');
    expect(next).toHaveLength(2);
  });

  it('returns empty array for Completed (terminal state)', () => {
    expect(getValidNextStates('Completed')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// transition — setup
// ---------------------------------------------------------------------------

describe('transition', () => {
  let withTransactionMock: MockInstance;
  let clientQueryMock: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    withTransactionMock = vi.mocked(db.withTransaction);
    clientQueryMock = vi.mocked(db.clientQuery);

    // Default: withTransaction executes the callback with a fake client
    withTransactionMock.mockImplementation(
      async (fn: (client: pg.PoolClient) => Promise<unknown>) => fn({} as pg.PoolClient),
    );
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it('returns true on a valid transition', async () => {
    // SELECT returns a task row
    clientQueryMock
      .mockResolvedValueOnce({
        rows: [{ id: 'task-1', state: 'Created', retry_count: 0, updated_at: new Date() }],
        rowCount: 1,
      })
      // UPDATE returns the updated row
      .mockResolvedValueOnce({ rows: [{ id: 'task-1' }], rowCount: 1 })
      // INSERT into workflow_logs
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await transition('task-1', 'Assigned', makeContext());
    expect(result).toBe(true);
  });

  it('passes correct SQL parameters to the UPDATE', async () => {
    const updatedAt = new Date('2025-01-01T00:00:00Z');
    clientQueryMock
      .mockResolvedValueOnce({
        rows: [{ id: 'task-1', state: 'Created', retry_count: 0, updated_at: updatedAt }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'task-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await transition('task-1', 'Assigned', makeContext({ trigger: 'manual_assign', actor: 'pm_001' }));

    // Second call is the UPDATE
    const updateCall = clientQueryMock.mock.calls[1];
    const params = updateCall[2] as unknown[];
    expect(params[0]).toBe('Assigned');   // new state
    expect(params[3]).toBe('task-1');     // task id
    expect(params[4]).toEqual(updatedAt); // optimistic lock timestamp
  });

  it('inserts a workflow_log row with correct fields', async () => {
    const updatedAt = new Date();
    clientQueryMock
      .mockResolvedValueOnce({
        rows: [{ id: 'task-1', state: 'Assigned', retry_count: 1, updated_at: updatedAt }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'task-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const ctx = makeContext({ trigger: 'dev_confirm', actor: 'dev_007', reason: 'Starting work' });
    await transition('task-1', 'InDevelopment', ctx);

    const logCall = clientQueryMock.mock.calls[2];
    const logParams = logCall[2] as unknown[];
    expect(logParams[0]).toBe('task-1');         // task_id
    expect(logParams[1]).toBe('Assigned');        // from_state
    expect(logParams[2]).toBe('InDevelopment');   // to_state
    expect(logParams[3]).toBe('dev_confirm');     // trigger
    expect(logParams[4]).toBe('dev_007');         // actor
    expect(logParams[5]).toBe('Starting work');   // reason
  });

  // -------------------------------------------------------------------------
  // Retry counter
  // -------------------------------------------------------------------------

  it('increments retry_count when transitioning to VerificationFailed', async () => {
    const updatedAt = new Date();
    clientQueryMock
      .mockResolvedValueOnce({
        rows: [{ id: 'task-1', state: 'VerificationPending', retry_count: 0, updated_at: updatedAt }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'task-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await transition('task-1', 'VerificationFailed', makeContext({ reason: 'Criteria not met' }));

    const updateParams = clientQueryMock.mock.calls[1][2] as unknown[];
    expect(updateParams[1]).toBe(1); // retry_count incremented from 0 to 1
  });

  it('increments retry_count when transitioning to QAFailed', async () => {
    const updatedAt = new Date();
    clientQueryMock
      .mockResolvedValueOnce({
        rows: [{ id: 'task-1', state: 'QAPending', retry_count: 2, updated_at: updatedAt }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'task-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await transition('task-1', 'QAFailed', makeContext({ reason: 'Test failed' }));

    const updateParams = clientQueryMock.mock.calls[1][2] as unknown[];
    expect(updateParams[1]).toBe(3); // 2 + 1
  });

  it('increments retry_count when reverting to Created from a later state', async () => {
    const updatedAt = new Date();
    clientQueryMock
      .mockResolvedValueOnce({
        rows: [{ id: 'task-1', state: 'InDevelopment', retry_count: 1, updated_at: updatedAt }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'task-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await transition('task-1', 'Created', makeContext({ reason: 'Meeting update changed requirements' }));

    const updateParams = clientQueryMock.mock.calls[1][2] as unknown[];
    expect(updateParams[1]).toBe(2); // 1 + 1
  });

  it('does NOT increment retry_count for a normal forward transition', async () => {
    const updatedAt = new Date();
    clientQueryMock
      .mockResolvedValueOnce({
        rows: [{ id: 'task-1', state: 'Created', retry_count: 0, updated_at: updatedAt }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'task-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await transition('task-1', 'Assigned', makeContext());

    const updateParams = clientQueryMock.mock.calls[1][2] as unknown[];
    expect(updateParams[1]).toBe(0); // unchanged
  });

  it('does NOT increment retry_count for Created → Created self-transition', async () => {
    const updatedAt = new Date();
    clientQueryMock
      .mockResolvedValueOnce({
        rows: [{ id: 'task-1', state: 'Created', retry_count: 0, updated_at: updatedAt }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'task-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await transition('task-1', 'Created', makeContext({ reason: 'Meeting re-trigger' }));

    const updateParams = clientQueryMock.mock.calls[1][2] as unknown[];
    expect(updateParams[1]).toBe(0); // no increment for self-transition from Created
  });

  // -------------------------------------------------------------------------
  // Error cases
  // -------------------------------------------------------------------------

  it('throws STATE_TASK_NOT_FOUND when task does not exist', async () => {
    clientQueryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(transition('missing-id', 'Assigned', makeContext())).rejects.toMatchObject({
      code: 'STATE_TASK_NOT_FOUND',
    });
  });

  it('throws STATE_INVALID_TRANSITION for an illegal state change', async () => {
    const updatedAt = new Date();
    clientQueryMock.mockResolvedValueOnce({
      rows: [{ id: 'task-1', state: 'Created', retry_count: 0, updated_at: updatedAt }],
      rowCount: 1,
    });

    await expect(transition('task-1', 'Completed', makeContext())).rejects.toMatchObject({
      code: 'STATE_INVALID_TRANSITION',
    });
  });

  it('throws STATE_CONCURRENT_MODIFICATION when optimistic lock fails', async () => {
    const updatedAt = new Date();
    clientQueryMock
      .mockResolvedValueOnce({
        rows: [{ id: 'task-1', state: 'Created', retry_count: 0, updated_at: updatedAt }],
        rowCount: 1,
      })
      // UPDATE returns no rows — another process modified the row
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(transition('task-1', 'Assigned', makeContext())).rejects.toMatchObject({
      code: 'STATE_CONCURRENT_MODIFICATION',
    });
  });

  it('thrown errors are instances of AppError', async () => {
    clientQueryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const err = await transition('x', 'Assigned', makeContext()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
  });

  it('includes suggestedAction in INVALID_TRANSITION error', async () => {
    const updatedAt = new Date();
    clientQueryMock.mockResolvedValueOnce({
      rows: [{ id: 'task-1', state: 'Created', retry_count: 0, updated_at: updatedAt }],
      rowCount: 1,
    });

    const err = await transition('task-1', 'Completed', makeContext()).catch((e: unknown) => e);
    expect((err as AppError).suggestedAction).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Metadata passthrough
  // -------------------------------------------------------------------------

  it('serialises metadata into the workflow_log INSERT', async () => {
    const updatedAt = new Date();
    clientQueryMock
      .mockResolvedValueOnce({
        rows: [{ id: 'task-1', state: 'Assigned', retry_count: 0, updated_at: updatedAt }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 'task-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const meta = { source: 'webhook', eventId: 'evt-42' };
    await transition('task-1', 'InDevelopment', makeContext({ metadata: meta }));

    const logParams = clientQueryMock.mock.calls[2][2] as unknown[];
    expect(logParams[6]).toBe(JSON.stringify(meta));
  });
});
