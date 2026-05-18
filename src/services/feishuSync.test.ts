/**
 * Unit tests for FeishuSyncService.
 *
 * FeishuSyncService is READ-ONLY: it compares Feishu task data with the local
 * DB and returns a list of diffs. It does NOT write to the DB or Feishu.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuSyncService } from './feishuSync.js';

vi.mock('../utils/db.js', () => ({
  queryOne: vi.fn(),
}));

vi.mock('../config/index.js', () => ({
  getConfig: vi.fn(() => ({
    feishu: { appId: 'test-app-id', appSecret: 'test-app-secret' },
  })),
}));

import { queryOne } from '../utils/db.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockClient() {
  return { task: { v2: { task: { get: vi.fn() } } } };
}

const baseRow = {
  id: 'task-uuid-123',
  display_id: 'F-000001',
  title: 'Implement login',
  description: 'Implement user login with OAuth',
  assignee_id: 'user-open-id-1',
  feishu_task_id: 'feishu-guid-abc',
  due_date: '2025-06-15',
};

const baseFeishuTask = {
  guid: 'feishu-guid-abc',
  summary: 'F-000001-Implement login',
  description: 'Implement user login with OAuth',
  members: [{ type: 'user', id: 'user-open-id-1', role: 'assignee' }],
  due: { timestamp: String(new Date('2025-06-15T00:00:00Z').getTime()), is_all_day: true },
};

function feishuOk(task: object) {
  return { code: 0, data: { task } };
}

function makeService(client: ReturnType<typeof makeMockClient>) {
  return new FeishuSyncService({ feishuClient: client as any });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FeishuSyncService.diff', () => {
  let client: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = makeMockClient();
  });

  // -------------------------------------------------------------------------
  // No-op cases
  // -------------------------------------------------------------------------

  it('returns null when task not found in DB', async () => {
    vi.mocked(queryOne).mockResolvedValue(null);
    expect(await makeService(client).diff('task-uuid-123')).toBeNull();
  });

  it('returns null when task has no feishu_task_id', async () => {
    vi.mocked(queryOne).mockResolvedValue({ ...baseRow, feishu_task_id: null });
    expect(await makeService(client).diff('task-uuid-123')).toBeNull();
    expect(client.task.v2.task.get).not.toHaveBeenCalled();
  });

  it('returns null when Feishu API returns error', async () => {
    vi.mocked(queryOne).mockResolvedValue(baseRow);
    client.task.v2.task.get.mockResolvedValue({ code: 99999 });
    expect(await makeService(client).diff('task-uuid-123')).toBeNull();
  });

  it('returns null when Feishu API throws', async () => {
    vi.mocked(queryOne).mockResolvedValue(baseRow);
    client.task.v2.task.get.mockRejectedValue(new Error('Network timeout'));
    expect(await makeService(client).diff('task-uuid-123')).toBeNull();
  });

  it('returns empty diffs when Feishu matches local', async () => {
    vi.mocked(queryOne).mockResolvedValue(baseRow);
    client.task.v2.task.get.mockResolvedValue(feishuOk(baseFeishuTask));
    const result = await makeService(client).diff('task-uuid-123');
    expect(result?.diffs).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Diff detection
  // -------------------------------------------------------------------------

  it('detects title change', async () => {
    vi.mocked(queryOne).mockResolvedValue(baseRow);
    client.task.v2.task.get.mockResolvedValue(feishuOk({
      ...baseFeishuTask, summary: 'F-000001-Updated Title',
    }));
    const result = await makeService(client).diff('task-uuid-123');
    expect(result?.diffs).toContainEqual({
      field: 'title', localValue: 'Implement login', feishuValue: 'Updated Title',
    });
  });

  it('detects description change', async () => {
    vi.mocked(queryOne).mockResolvedValue(baseRow);
    client.task.v2.task.get.mockResolvedValue(feishuOk({
      ...baseFeishuTask, description: 'Implement user login with OAuth and MFA',
    }));
    const result = await makeService(client).diff('task-uuid-123');
    expect(result?.diffs).toContainEqual({
      field: 'description',
      localValue: 'Implement user login with OAuth',
      feishuValue: 'Implement user login with OAuth and MFA',
    });
  });

  it('strips history section before comparing description', async () => {
    vi.mocked(queryOne).mockResolvedValue(baseRow);
    client.task.v2.task.get.mockResolvedValue(feishuOk({
      ...baseFeishuTask,
      description: 'Implement user login with OAuth\n\n--- 变更历史 ---\n[2025-01-15] 任务创建',
    }));
    const result = await makeService(client).diff('task-uuid-123');
    expect(result?.diffs.find((d) => d.field === 'description')).toBeUndefined();
  });

  it('detects description change even when history section is present', async () => {
    vi.mocked(queryOne).mockResolvedValue(baseRow);
    client.task.v2.task.get.mockResolvedValue(feishuOk({
      ...baseFeishuTask,
      description: 'Implement user login with OAuth and MFA\n\n--- 变更历史 ---\n[2025-01-15] 任务创建',
    }));
    const result = await makeService(client).diff('task-uuid-123');
    expect(result?.diffs).toContainEqual({
      field: 'description',
      localValue: 'Implement user login with OAuth',
      feishuValue: 'Implement user login with OAuth and MFA',
    });
  });

  it('detects due_date change', async () => {
    vi.mocked(queryOne).mockResolvedValue(baseRow);
    client.task.v2.task.get.mockResolvedValue(feishuOk({
      ...baseFeishuTask,
      due: { timestamp: String(new Date('2025-07-01T00:00:00Z').getTime()), is_all_day: true },
    }));
    const result = await makeService(client).diff('task-uuid-123');
    expect(result?.diffs).toContainEqual({
      field: 'due_date', localValue: '2025-06-15', feishuValue: '2025-07-01',
    });
  });

  it('does not report due_date change when Date object matches Feishu timestamp', async () => {
    vi.mocked(queryOne).mockResolvedValue({
      ...baseRow, due_date: new Date('2025-06-15T00:00:00Z') as any,
    });
    client.task.v2.task.get.mockResolvedValue(feishuOk(baseFeishuTask));
    const result = await makeService(client).diff('task-uuid-123');
    expect(result?.diffs.find((d) => d.field === 'due_date')).toBeUndefined();
  });

  it('detects assignee change', async () => {
    vi.mocked(queryOne).mockResolvedValue(baseRow);
    client.task.v2.task.get.mockResolvedValue(feishuOk({
      ...baseFeishuTask,
      members: [{ type: 'user', id: 'user-open-id-2', role: 'assignee' }],
    }));
    const result = await makeService(client).diff('task-uuid-123');
    expect(result?.diffs).toContainEqual({
      field: 'assignee_id', localValue: 'user-open-id-1', feishuValue: 'user-open-id-2',
    });
  });

  // -------------------------------------------------------------------------
  // Read-only guarantee
  // -------------------------------------------------------------------------

  it('does NOT write to DB (only one queryOne call for the SELECT)', async () => {
    vi.mocked(queryOne).mockResolvedValue(baseRow);
    client.task.v2.task.get.mockResolvedValue(feishuOk({
      ...baseFeishuTask, summary: 'F-000001-Changed Title',
    }));
    await makeService(client).diff('task-uuid-123');
    // Only the initial SELECT should have been called — no inserts or updates
    expect(vi.mocked(queryOne)).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // display_id support
  // -------------------------------------------------------------------------

  it('accepts display_id as input', async () => {
    vi.mocked(queryOne).mockResolvedValue(baseRow);
    client.task.v2.task.get.mockResolvedValue(feishuOk(baseFeishuTask));
    const result = await makeService(client).diff('F-000001');
    expect(result?.taskId).toBe('task-uuid-123');
  });
});
