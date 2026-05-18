/**
 * Feishu Data Synchronization Service.
 *
 * Responsibility: compare a task's current state in Feishu with the local DB
 * and return a list of detected differences.
 *
 * This service is READ-ONLY — it does NOT write to the DB or Feishu.
 * The caller (sync_task tool) receives the diff and decides which tools to
 * invoke (update_task, assign_task, etc.) to apply the changes through the
 * normal flow, so history, Feishu sync, and state machine all work correctly.
 */

// @ts-ignore — node-sdk ships CJS
import { Client } from '@larksuiteoapi/node-sdk';
import { queryOne } from '../utils/db.js';
import { getConfig } from '../config/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeishuSyncOptions {
  feishuClient?: InstanceType<typeof Client>;
}

/** A single field difference between Feishu and local DB. */
export interface SyncDiff {
  field: 'title' | 'description' | 'due_date' | 'assignee_id';
  localValue: string | null;
  feishuValue: string | null;
}

/** Result returned to the caller. */
export interface SyncDiffResult {
  taskId: string;
  displayId: string;
  feishuTaskId: string;
  diffs: SyncDiff[];
}

interface FeishuTaskData {
  guid?: string;
  summary?: string;
  description?: string;
  due?: { timestamp?: string; is_all_day?: boolean } | null;
  members?: Array<{ type?: string; id?: string; role?: string }>;
}

interface FeishuTaskResponse {
  code?: number;
  data?: { task?: FeishuTaskData };
}

interface TaskRow extends Record<string, unknown> {
  id: string;
  display_id: string;
  title: string;
  description: string;
  assignee_id: string | null;
  feishu_task_id: string | null;
  due_date: unknown;
}

// ---------------------------------------------------------------------------
// FeishuSyncService
// ---------------------------------------------------------------------------

export class FeishuSyncService {
  private readonly feishuClient: InstanceType<typeof Client>;

  constructor(options: FeishuSyncOptions = {}) {
    if (options.feishuClient) {
      this.feishuClient = options.feishuClient;
    } else {
      const config = getConfig();
      this.feishuClient = new Client({
        appId: config.feishu.appId,
        appSecret: config.feishu.appSecret,
      });
    }
  }

  /**
   * Compare a task's Feishu state with the local DB.
   * Returns the list of differences — does NOT write anything.
   *
   * @param taskId - Local task UUID or display_id (e.g. F-000001)
   */
  async diff(taskId: string): Promise<SyncDiffResult | null> {
    // Support both UUID and display_id
    const field = /^[FB]-\d{6}$/.test(taskId) ? 'display_id' : 'id';
    const row = await queryOne<TaskRow>(
      `SELECT id, display_id, title, description, assignee_id, feishu_task_id, due_date
       FROM tasks WHERE ${field} = $1`,
      [taskId],
    );

    if (!row) return null;
    if (!row.feishu_task_id) return null;

    const feishuTask = await this.fetchFeishuTask(row.feishu_task_id);
    if (!feishuTask) return null;

    const diffs = this.detectDiffs(row, feishuTask);

    return {
      taskId: row.id,
      displayId: row.display_id,
      feishuTaskId: row.feishu_task_id,
      diffs,
    };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private detectDiffs(row: TaskRow, feishuTask: FeishuTaskData): SyncDiff[] {
    const diffs: SyncDiff[] = [];

    // Title
    if (feishuTask.summary !== undefined) {
      const feishuTitle = this.stripDisplayIdPrefix(feishuTask.summary, row.display_id);
      if (feishuTitle !== row.title) {
        diffs.push({ field: 'title', localValue: row.title, feishuValue: feishuTitle });
      }
    }

    // Description — strip history section from Feishu value
    if (feishuTask.description !== undefined) {
      const feishuContent = this.stripHistorySection(feishuTask.description).trim();
      const localContent = (row.description || '').trim();
      if (feishuContent !== localContent) {
        diffs.push({ field: 'description', localValue: localContent, feishuValue: feishuContent });
      }
    }

    // Due date
    if (feishuTask.due !== undefined) {
      const feishuDue = this.parseDueDate(feishuTask.due);
      const localDue = this.normalizeDateString(row.due_date);
      if (feishuDue !== localDue) {
        diffs.push({ field: 'due_date', localValue: localDue, feishuValue: feishuDue });
      }
    }

    // Assignee
    if (feishuTask.members !== undefined) {
      const assignee = feishuTask.members?.find((m) => m.role === 'assignee' && m.type === 'user');
      const feishuAssigneeId = assignee?.id ?? null;
      if (feishuAssigneeId !== row.assignee_id) {
        diffs.push({ field: 'assignee_id', localValue: row.assignee_id, feishuValue: feishuAssigneeId });
      }
    }

    return diffs;
  }

  private async fetchFeishuTask(feishuTaskId: string): Promise<FeishuTaskData | null> {
    try {
      const response = await this.feishuClient.task.v2.task.get({
        path: { task_guid: feishuTaskId },
        params: { user_id_type: 'open_id' },
      }) as FeishuTaskResponse;

      if (response?.code !== 0 || !response?.data?.task) return null;
      return response.data.task;
    } catch (err) {
      console.error(`[FeishuSyncService] API error for ${feishuTaskId}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private stripDisplayIdPrefix(summary: string, displayId: string): string {
    const prefix = `${displayId}-`;
    return summary.startsWith(prefix) ? summary.slice(prefix.length) : summary;
  }

  private stripHistorySection(text: string): string {
    const idx = text.indexOf('--- 变更历史 ---');
    return idx === -1 ? text : text.slice(0, idx);
  }

  private parseDueDate(due: FeishuTaskData['due']): string | null {
    if (!due?.timestamp) return null;
    const ts = parseInt(due.timestamp, 10);
    if (isNaN(ts)) return null;
    const d = new Date(ts);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  private normalizeDateString(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) {
      return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
    }
    const str = String(value).trim();
    if (!str) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
    const parsed = new Date(str);
    if (isNaN(parsed.getTime())) return str;
    return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}-${String(parsed.getUTCDate()).padStart(2, '0')}`;
  }
}
