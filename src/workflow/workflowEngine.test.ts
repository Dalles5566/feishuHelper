/**
 * Unit tests for the Workflow Engine.
 *
 * The state machine transition() and database calls are mocked so these
 * tests run without a real PostgreSQL instance.
 *
 * Requirements: 9.1, 9.5, 9.6
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockInstance } from 'vitest';

// ---------------------------------------------------------------------------
// Mock dependencies BEFORE importing the module under test
// ---------------------------------------------------------------------------
vi.mock('./stateMachine.js', () => ({
  transition: vi.fn(),
}));

vi.mock('../utils/db.js', () => ({
  insert: vi.fn(),
  query: vi.fn(),
}));

import * as stateMachine from './stateMachine.js';
import * as db from '../utils/db.js';
import {
  startWorkflow,
  advanceWorkflow,
  revertWorkflow,
  handleMeetingUpdateForAllTasks,
  getWorkflowStatus,
} from './workflowEngine.js';
import { AppError } from '../utils/errors.js';
import type { MeetingAnalysis } from '../models/meeting.js';
import type { WorkflowEvent } from '../models/workflow.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMeetingAnalysis(actionItemCount = 2): MeetingAnalysis {
  const actionItems = Array.from({ length: actionItemCount }, (_, i) => ({
    id: `action-${i + 1}`,
    description: `Action item ${i + 1} description`,
    context: `Context for action item ${i + 1}`,
    priority: 'medium' as const,
    dependencies: [],
  }));

  return {
    summary: {
      title: 'Test Meeting',
      date: '2025-01-15',
      participants: ['user_1', 'user_2'],
      keyPoints: ['Point 1'],
      overallSummary: 'A test meeting summary',
    },
    actionItems,
    decisions: [],
    discussionPoints: [],
  };
}

function makeEvent(overrides: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return {
    type: 'assignment',
    payload: {},
    actor: 'user_123',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// startWorkflow
// ---------------------------------------------------------------------------

describe('startWorkflow', () => {
  let insertMock: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    insertMock = vi.mocked(db.insert);
    insertMock.mockResolvedValue({ id: 'task-new' });
  });

  it('creates a task for each action item', async () => {
    const analysis = makeMeetingAnalysis(3);
    await startWorkflow(analysis, 'meeting-1', 'user_pm');

    expect(insertMock).toHaveBeenCalledTimes(3);
  });

  it('returns the meeting ID', async () => {
    const analysis = makeMeetingAnalysis(1);
    const result = await startWorkflow(analysis, 'meeting-42', 'user_pm');

    expect(result).toBe('meeting-42');
  });

  it('passes correct parameters to insert', async () => {
    const analysis = makeMeetingAnalysis(1);
    await startWorkflow(analysis, 'meeting-1', 'user_pm');

    const callArgs = insertMock.mock.calls[0];
    const params = callArgs[1] as unknown[];
    expect(params[4]).toBe('medium'); // priority
    expect(params[5]).toBe('meeting-1'); // meeting_id
    expect(params[6]).toBe('action-1'); // source_action_item_id
  });

  it('throws validation error when no action items', async () => {
    const analysis = makeMeetingAnalysis(0);

    await expect(startWorkflow(analysis, 'meeting-1', 'user_pm')).rejects.toMatchObject({
      code: 'VALIDATION_EMPTY_CONTENT',
    });
  });

  it('thrown error is an AppError instance', async () => {
    const analysis = makeMeetingAnalysis(0);

    const err = await startWorkflow(analysis, 'meeting-1', 'user_pm').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
  });
});

// ---------------------------------------------------------------------------
// advanceWorkflow
// ---------------------------------------------------------------------------

describe('advanceWorkflow', () => {
  let transitionMock: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    transitionMock = vi.mocked(stateMachine.transition);
    transitionMock.mockResolvedValue(true);
  });

  it('maps assignment event to Assigned state', async () => {
    await advanceWorkflow('task-1', makeEvent({ type: 'assignment' }));

    expect(transitionMock).toHaveBeenCalledWith(
      'task-1',
      'Assigned',
      expect.objectContaining({ trigger: 'assignment' }),
      undefined,
    );
  });

  it('maps dev_complete event to VerificationPending state', async () => {
    await advanceWorkflow('task-1', makeEvent({ type: 'dev_complete' }));

    expect(transitionMock).toHaveBeenCalledWith(
      'task-1',
      'VerificationPending',
      expect.objectContaining({ trigger: 'dev_complete' }),
      undefined,
    );
  });

  it('maps verification_result (passed) to VerificationPassed', async () => {
    await advanceWorkflow('task-1', makeEvent({
      type: 'verification_result',
      payload: { passed: true },
    }));

    expect(transitionMock).toHaveBeenCalledWith(
      'task-1',
      'VerificationPassed',
      expect.objectContaining({ trigger: 'verification_result' }),
      undefined,
    );
  });

  it('maps verification_result (failed) to VerificationFailed', async () => {
    await advanceWorkflow('task-1', makeEvent({
      type: 'verification_result',
      payload: { passed: false },
    }));

    expect(transitionMock).toHaveBeenCalledWith(
      'task-1',
      'VerificationFailed',
      expect.objectContaining({ trigger: 'verification_result' }),
      undefined,
    );
  });

  it('maps qa_result (passed) to QAPassed', async () => {
    await advanceWorkflow('task-1', makeEvent({
      type: 'qa_result',
      payload: { passed: true },
    }));

    expect(transitionMock).toHaveBeenCalledWith(
      'task-1',
      'QAPassed',
      expect.objectContaining({ trigger: 'qa_result' }),
      undefined,
    );
  });

  it('maps qa_result (failed) to QAFailed', async () => {
    await advanceWorkflow('task-1', makeEvent({
      type: 'qa_result',
      payload: { passed: false },
    }));

    expect(transitionMock).toHaveBeenCalledWith(
      'task-1',
      'QAFailed',
      expect.objectContaining({ trigger: 'qa_result' }),
      undefined,
    );
  });

  it('maps doc_updated event to DocumentationUpdated', async () => {
    await advanceWorkflow('task-1', makeEvent({ type: 'doc_updated' }));

    expect(transitionMock).toHaveBeenCalledWith(
      'task-1',
      'DocumentationUpdated',
      expect.objectContaining({ trigger: 'doc_updated' }),
      undefined,
    );
  });

  it('handles meeting_update event by reverting to Created', async () => {
    await advanceWorkflow('task-1', makeEvent({
      type: 'meeting_update',
      payload: { reason: 'Requirements changed' },
    }));

    expect(transitionMock).toHaveBeenCalledWith(
      'task-1',
      'Created',
      expect.objectContaining({
        trigger: 'meeting_update',
        reason: 'Requirements changed',
      }),
      undefined,
    );
  });

  it('passes actor from event to transition context', async () => {
    await advanceWorkflow('task-1', makeEvent({
      type: 'assignment',
      actor: 'pm_007',
    }));

    expect(transitionMock).toHaveBeenCalledWith(
      'task-1',
      'Assigned',
      expect.objectContaining({ actor: 'pm_007' }),
      undefined,
    );
  });

  it('passes payload reason to transition context', async () => {
    await advanceWorkflow('task-1', makeEvent({
      type: 'dev_complete',
      payload: { reason: 'All criteria met' },
    }));

    expect(transitionMock).toHaveBeenCalledWith(
      'task-1',
      'VerificationPending',
      expect.objectContaining({ reason: 'All criteria met' }),
      undefined,
    );
  });

  it('throws validation error for unknown event type', async () => {
    const badEvent = makeEvent({ type: 'unknown_event' as WorkflowEvent['type'] });

    await expect(advanceWorkflow('task-1', badEvent)).rejects.toMatchObject({
      code: 'VALIDATION_INVALID_FORMAT',
    });
  });
});

// ---------------------------------------------------------------------------
// revertWorkflow
// ---------------------------------------------------------------------------

describe('revertWorkflow', () => {
  let transitionMock: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    transitionMock = vi.mocked(stateMachine.transition);
    transitionMock.mockResolvedValue(true);
  });

  it('calls transition with target state and reason', async () => {
    await revertWorkflow('task-1', 'Created', 'Requirement unclear', 'pm_001');

    expect(transitionMock).toHaveBeenCalledWith(
      'task-1',
      'Created',
      expect.objectContaining({
        trigger: 'revert',
        actor: 'pm_001',
        reason: 'Requirement unclear',
      }),
      undefined,
    );
  });

  it('propagates transition errors', async () => {
    transitionMock.mockRejectedValue(
      AppError.stateTransition('STATE_INVALID_TRANSITION', 'Invalid transition', {}),
    );

    await expect(
      revertWorkflow('task-1', 'Completed', 'test', 'user_1'),
    ).rejects.toMatchObject({
      code: 'STATE_INVALID_TRANSITION',
    });
  });
});

// ---------------------------------------------------------------------------
// handleMeetingUpdateForAllTasks
// ---------------------------------------------------------------------------

describe('handleMeetingUpdateForAllTasks', () => {
  let transitionMock: MockInstance;
  let queryMock: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    transitionMock = vi.mocked(stateMachine.transition);
    transitionMock.mockResolvedValue(true);
    queryMock = vi.mocked(db.query);
  });

  it('reverts all tasks beyond Created to Created', async () => {
    queryMock.mockResolvedValue({
      rows: [
        { id: 'task-1', state: 'Assigned' },
        { id: 'task-2', state: 'InDevelopment' },
        { id: 'task-3', state: 'VerificationPending' },
      ],
      rowCount: 3,
    });

    const event = makeEvent({
      type: 'meeting_update',
      payload: { reason: 'New requirements from meeting' },
    });

    const reverted = await handleMeetingUpdateForAllTasks('meeting-1', event);

    expect(transitionMock).toHaveBeenCalledTimes(3);
    expect(reverted).toEqual(['task-1', 'task-2', 'task-3']);
  });

  it('returns empty array when no tasks need reverting', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });

    const event = makeEvent({ type: 'meeting_update', payload: {} });
    const reverted = await handleMeetingUpdateForAllTasks('meeting-1', event);

    expect(reverted).toEqual([]);
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it('passes meeting_update trigger and reason to each transition', async () => {
    queryMock.mockResolvedValue({
      rows: [{ id: 'task-1', state: 'Assigned' }],
      rowCount: 1,
    });

    const event = makeEvent({
      type: 'meeting_update',
      actor: 'pm_lead',
      payload: { reason: 'Scope changed' },
    });

    await handleMeetingUpdateForAllTasks('meeting-1', event);

    expect(transitionMock).toHaveBeenCalledWith(
      'task-1',
      'Created',
      expect.objectContaining({
        trigger: 'meeting_update',
        actor: 'pm_lead',
        reason: 'Scope changed',
      }),
      undefined,
    );
  });

  it('uses default reason when payload has no reason', async () => {
    queryMock.mockResolvedValue({
      rows: [{ id: 'task-1', state: 'InDevelopment' }],
      rowCount: 1,
    });

    const event = makeEvent({
      type: 'meeting_update',
      payload: {},
    });

    await handleMeetingUpdateForAllTasks('meeting-1', event);

    expect(transitionMock).toHaveBeenCalledWith(
      'task-1',
      'Created',
      expect.objectContaining({
        reason: 'Meeting update changed requirements',
      }),
      undefined,
    );
  });

  it('queries only tasks with state != Created', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });

    const event = makeEvent({ type: 'meeting_update', payload: {} });
    await handleMeetingUpdateForAllTasks('meeting-1', event);

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("state != 'Created'"),
      ['meeting-1'],
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// getWorkflowStatus
// ---------------------------------------------------------------------------

describe('getWorkflowStatus', () => {
  let queryMock: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    queryMock = vi.mocked(db.query);
  });

  it('returns workflow status with history', async () => {
    // First query: task state
    queryMock
      .mockResolvedValueOnce({
        rows: [{ id: 'task-1', state: 'InDevelopment', retry_count: 1, failure_context: 'prev failure' }],
        rowCount: 1,
      })
      // Second query: workflow logs
      .mockResolvedValueOnce({
        rows: [
          { from_state: 'Created', to_state: 'Assigned', trigger: 'assignment', actor: 'pm_1', timestamp: '2025-01-01T00:00:00Z', reason: null },
          { from_state: 'Assigned', to_state: 'InDevelopment', trigger: 'dev_confirm', actor: 'dev_1', timestamp: '2025-01-02T00:00:00Z', reason: null },
        ],
        rowCount: 2,
      });

    const status = await getWorkflowStatus('task-1');

    expect(status.taskId).toBe('task-1');
    expect(status.currentState).toBe('InDevelopment');
    expect(status.retryCount).toBe(1);
    expect(status.failureContext).toBe('prev failure');
    expect(status.history).toHaveLength(2);
    expect(status.history[0].fromState).toBe('Created');
    expect(status.history[0].toState).toBe('Assigned');
    expect(status.history[1].trigger).toBe('dev_confirm');
  });

  it('throws when task not found', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(getWorkflowStatus('missing-id')).rejects.toMatchObject({
      code: 'STATE_TASK_NOT_FOUND',
    });
  });

  it('returns empty history when no transitions logged', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{ id: 'task-1', state: 'Created', retry_count: 0, failure_context: null }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const status = await getWorkflowStatus('task-1');

    expect(status.history).toEqual([]);
    expect(status.failureContext).toBeUndefined();
  });
});
