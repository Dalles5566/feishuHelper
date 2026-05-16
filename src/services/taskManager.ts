/**
 * Task Manager service.
 *
 * Provides CRUD operations for tasks, including creation via Feishu REST API,
 * task splitting into subtasks, description updates with history preservation,
 * and state transitions via the workflow state machine.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */

import type { Task, SubTask, TaskCreateParams, SubTaskParams, TaskFilter } from '../models/task.js';
import type { TransitionContext } from '../models/workflow.js';
import type { TaskState } from '../models/task.js';
// @ts-ignore — node-sdk ships CJS
import { Client } from '@larksuiteoapi/node-sdk';
import { insert, query, queryOne, update } from '../utils/db.js';
import { withRetry, type RetryOptions } from '../utils/retry.js';
import { transition } from '../workflow/stateMachine.js';
import { AppError, BusinessErrorCodes, ValidationErrorCodes } from '../utils/errors.js';
import { getConfig } from '../config/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for creating a TaskManager instance. */
export interface TaskManagerOptions {
  /** Override the Feishu Client instance (useful for testing). */
  feishuClient?: InstanceType<typeof Client>;
  /** Override retry options for task creation. */
  retryOptions?: RetryOptions;
}

/** Database row shape for the tasks table. */
interface TaskRow extends Record<string, unknown> {
  id: string;
  title: string;
  description: string;
  acceptance_criteria: string[];
  dependencies: string[];
  priority: string;
  state: string;
  assignee_id: string | null;
  parent_task_id: string | null;
  source_action_item_id: string;
  feishu_task_id: string | null;
  retry_count: number;
  failure_context: string | null;
  description_history: Array<{
    previousDescription: string;
    newDescription: string;
    reason: string;
    updatedBy: string;
    updatedAt: string;
  }>;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// TaskManager
// ---------------------------------------------------------------------------

/**
 * Manages task lifecycle operations including creation, splitting,
 * description updates, and state transitions.
 */
export class TaskManager {
  private readonly feishuClient: InstanceType<typeof Client>;
  private readonly retryOptions: RetryOptions;

  constructor(options: TaskManagerOptions = {}) {
    if (options.feishuClient) {
      this.feishuClient = options.feishuClient;
    } else {
      const config = getConfig();
      this.feishuClient = new Client({
        appId: config.feishu.appId,
        appSecret: config.feishu.appSecret,
      });
    }
    this.retryOptions = options.retryOptions ?? {};
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Create a new task from meeting action item parameters.
   *
   * 1. Creates the task in Feishu via MCP (with retry up to 3 times).
   * 2. Persists the task locally in the database.
   *
   * @param params - Task creation parameters.
   * @returns The created task.
   * @throws AppError on validation failure or after retries exhausted.
   */
  async createTask(params: TaskCreateParams): Promise<Task> {
    this.validateCreateParams(params);

    // Create task in Feishu via REST API with retry logic (up to 3 times)
    const feishuTaskId = await withRetry(
      async () => {
        const response = await this.feishuClient.task.v2.task.create({
          params: { user_id_type: 'open_id' },
          data: {
            summary: params.title,
            description: params.description,
            members: [{
              type: 'user',
              id: 'ou_371598589222259055562993853b8df0',
              role: 'assignee',
            }],
          },
        });

        if ((response as any)?.code !== 0) {
          throw AppError.feishuApi(
            'FEISHU_TASK_CREATE_FAILED',
            `Feishu task creation failed: ${JSON.stringify(response)}`,
            { params, response },
          );
        }

        const taskGuid = (response as any)?.data?.task?.guid;
        if (!taskGuid) {
          throw AppError.feishuApi(
            'FEISHU_TASK_CREATE_EMPTY_RESPONSE',
            'Feishu task creation returned no task GUID',
            { params, response },
          );
        }

        console.log(`[TaskManager] Feishu task created: ${taskGuid}`);
        return taskGuid;
      },
      {
        ...this.retryOptions,
        policies: {
          feishu_api: { maxRetries: 3, baseDelay: 1000, maxDelay: 30000, backoffMultiplier: 2 },
          ...this.retryOptions.policies,
        },
      },
    );

    // Persist task in the local database
    const row = await insert<TaskRow>(
      `INSERT INTO tasks (
        title, description, acceptance_criteria, dependencies,
        priority, state, source_action_item_id, feishu_task_id,
        retry_count, description_history
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        params.title,
        params.description,
        JSON.stringify(params.acceptanceCriteria),
        JSON.stringify(params.dependencies),
        params.priority,
        'Created',
        params.sourceActionItemId,
        feishuTaskId,
        0,
        JSON.stringify([]),
      ],
    );

    return this.rowToTask(row);
  }

  /**
   * Split a complex task into multiple subtasks.
   *
   * Validates that subtask scopes do not overlap and creates each subtask
   * both in Feishu and in the local database.
   *
   * @param taskId   - The parent task ID.
   * @param subtasks - Array of subtask parameters.
   * @returns Array of created subtasks.
   * @throws AppError if the parent task is not found or scopes overlap.
   */
  async splitTask(taskId: string, subtasks: SubTaskParams[]): Promise<SubTask[]> {
    // Verify parent task exists
    const parentTask = await this.getTask(taskId);
    if (!parentTask) {
      throw AppError.businessLogic(
        BusinessErrorCodes.TASK_NOT_FOUND,
        `Parent task ${taskId} not found`,
        { taskId },
        'Verify the task ID is correct.',
      );
    }

    // Validate subtask scopes do not overlap
    this.validateSubtaskScopes(subtasks);

    // Create each subtask
    const createdSubtasks: SubTask[] = [];
    for (const subtaskParams of subtasks) {
      // Create in Feishu via REST API with retry
      const feishuTaskId = await withRetry(
        async () => {
          const response = await this.feishuClient.task.v2.task.create({
            params: { user_id_type: 'open_id' },
            data: {
              summary: subtaskParams.title,
              description: subtaskParams.description,
            },
          });

          if ((response as any)?.code !== 0) {
            throw AppError.feishuApi(
              'FEISHU_TASK_CREATE_FAILED',
              `Feishu subtask creation failed: ${JSON.stringify(response)}`,
              { subtaskParams, response },
            );
          }

          const taskGuid = (response as any)?.data?.task?.guid;
          if (!taskGuid) {
            throw AppError.feishuApi(
              'FEISHU_TASK_CREATE_EMPTY_RESPONSE',
              'Feishu subtask creation returned no task GUID',
              { subtaskParams, response },
            );
          }

          return taskGuid;
        },
        {
          ...this.retryOptions,
          policies: {
            feishu_api: { maxRetries: 3, baseDelay: 1000, maxDelay: 30000, backoffMultiplier: 2 },
            ...this.retryOptions.policies,
          },
        },
      );

      // Persist subtask in the database
      const row = await insert<Record<string, unknown>>(
        `INSERT INTO tasks (
          title, description, acceptance_criteria, dependencies,
          priority, state, parent_task_id, source_action_item_id,
          feishu_task_id, retry_count, description_history
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *`,
        [
          subtaskParams.title,
          subtaskParams.description,
          JSON.stringify([]),
          JSON.stringify([]),
          parentTask.priority,
          'Created',
          taskId,
          parentTask.sourceActionItemId,
          feishuTaskId,
          0,
          JSON.stringify([]),
        ],
      );

      createdSubtasks.push({
        id: row.id as string,
        title: subtaskParams.title,
        description: subtaskParams.description,
        scope: subtaskParams.scope,
        estimatedEffort: subtaskParams.estimatedEffort,
        parentTaskId: taskId,
        state: 'Created',
        feishuTaskId,
        createdAt: (row.created_at as Date).toISOString(),
        updatedAt: (row.updated_at as Date).toISOString(),
      });
    }

    return createdSubtasks;
  }

  /**
   * Update a task's description while preserving the update history.
   *
   * Each update records the previous description, new description,
   * modification reason, and timestamp.
   *
   * @param taskId      - The task ID to update.
   * @param description - The new description text.
   * @param reason      - Human-readable reason for the update.
   * @returns The updated task.
   * @throws AppError if the task is not found or description is empty.
   */
  async updateTaskDescription(
    taskId: string,
    description: string,
    reason: string,
  ): Promise<Task> {
    if (!description || description.trim() === '') {
      throw AppError.validation(
        ValidationErrorCodes.EMPTY_CONTENT,
        'Task description cannot be empty',
        { taskId },
        'Provide a non-empty description.',
      );
    }

    if (!reason || reason.trim() === '') {
      throw AppError.validation(
        ValidationErrorCodes.MISSING_FIELD,
        'Update reason is required',
        { taskId },
        'Provide a reason for the description update.',
      );
    }

    const task = await this.getTask(taskId);
    if (!task) {
      throw AppError.businessLogic(
        BusinessErrorCodes.TASK_NOT_FOUND,
        `Task ${taskId} not found`,
        { taskId },
        'Verify the task ID is correct.',
      );
    }

    // Build the new history entry
    const historyEntry = {
      previousDescription: task.description,
      newDescription: description,
      reason,
      updatedBy: 'system',
      updatedAt: new Date().toISOString(),
    };

    const updatedHistory = [...task.descriptionHistory, historyEntry];

    // Update the database
    await update(
      `UPDATE tasks
       SET description = $1,
           description_history = $2,
           updated_at = NOW()
       WHERE id = $3`,
      [description, JSON.stringify(updatedHistory), taskId],
    );

    // Return the updated task
    return {
      ...task,
      description,
      descriptionHistory: updatedHistory,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Update a task's state by invoking the workflow state machine.
   *
   * @param taskId   - The task ID.
   * @param newState - The target state.
   * @param trigger  - What triggered this transition.
   * @returns The updated task.
   * @throws AppError if the transition is invalid or the task is not found.
   */
  async updateTaskState(
    taskId: string,
    newState: TaskState,
    trigger: string,
  ): Promise<Task> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw AppError.businessLogic(
        BusinessErrorCodes.TASK_NOT_FOUND,
        `Task ${taskId} not found`,
        { taskId },
        'Verify the task ID is correct.',
      );
    }

    const context: TransitionContext = {
      trigger,
      actor: 'system',
      reason: trigger,
    };

    // Execute the state transition via the state machine
    await transition(taskId, newState, context);

    // Return the updated task
    return {
      ...task,
      state: newState,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Retrieve a task by ID.
   *
   * @param taskId - The task ID.
   * @returns The task, or null if not found.
   */
  async getTask(taskId: string): Promise<Task | null> {
    const row = await queryOne<TaskRow>(
      'SELECT * FROM tasks WHERE id = $1',
      [taskId],
    );

    if (!row) return null;
    return this.rowToTask(row);
  }

  /**
   * List tasks matching the given filter criteria.
   *
   * @param filter - Optional filter criteria.
   * @returns Array of matching tasks.
   */
  async listTasks(filter: TaskFilter = {}): Promise<Task[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filter.state) {
      conditions.push(`state = $${paramIndex++}`);
      params.push(filter.state);
    }
    if (filter.assignee) {
      conditions.push(`assignee_id = $${paramIndex++}`);
      params.push(filter.assignee);
    }
    if (filter.priority) {
      conditions.push(`priority = $${paramIndex++}`);
      params.push(filter.priority);
    }
    if (filter.parentTaskId) {
      conditions.push(`parent_task_id = $${paramIndex++}`);
      params.push(filter.parentTaskId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM tasks ${whereClause} ORDER BY created_at DESC`;

    const result = await query<TaskRow>(sql, params);
    return result.rows.map((row) => this.rowToTask(row));
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  /**
   * Validate task creation parameters.
   */
  private validateCreateParams(params: TaskCreateParams): void {
    if (!params.title || params.title.trim() === '') {
      throw AppError.validation(
        ValidationErrorCodes.MISSING_FIELD,
        'Task title is required',
        { params },
        'Provide a non-empty title.',
      );
    }

    if (!params.description || params.description.trim() === '') {
      throw AppError.validation(
        ValidationErrorCodes.EMPTY_CONTENT,
        'Task description is required',
        { params },
        'Provide a non-empty description.',
      );
    }

    if (!params.sourceActionItemId || params.sourceActionItemId.trim() === '') {
      throw AppError.validation(
        ValidationErrorCodes.MISSING_FIELD,
        'Source action item ID is required',
        { params },
        'Provide the action item ID from the meeting analysis.',
      );
    }
  }

  /**
   * Validate that subtask scopes do not overlap.
   *
   * Two scopes are considered overlapping if one contains the other
   * as a substring (case-insensitive comparison).
   */
  private validateSubtaskScopes(subtasks: SubTaskParams[]): void {
    if (subtasks.length === 0) {
      throw AppError.validation(
        ValidationErrorCodes.EMPTY_CONTENT,
        'At least one subtask is required for splitting',
        { subtasks },
        'Provide at least one subtask with a distinct scope.',
      );
    }

    const scopes = subtasks.map((s) => s.scope.toLowerCase().trim());

    for (let i = 0; i < scopes.length; i++) {
      for (let j = i + 1; j < scopes.length; j++) {
        if (scopes[i] === scopes[j]) {
          throw AppError.validation(
            'VALIDATION_SCOPE_OVERLAP',
            `Subtask scopes overlap: "${subtasks[i].scope}" and "${subtasks[j].scope}" are identical`,
            { scope1: subtasks[i].scope, scope2: subtasks[j].scope },
            'Ensure each subtask has a distinct, non-overlapping scope.',
          );
        }
        if (scopes[i].includes(scopes[j]) || scopes[j].includes(scopes[i])) {
          throw AppError.validation(
            'VALIDATION_SCOPE_OVERLAP',
            `Subtask scopes overlap: "${subtasks[i].scope}" and "${subtasks[j].scope}"`,
            { scope1: subtasks[i].scope, scope2: subtasks[j].scope },
            'Ensure each subtask has a distinct, non-overlapping scope.',
          );
        }
      }
    }
  }

  /**
   * Convert a database row to a Task domain object.
   */
  private rowToTask(row: TaskRow): Task {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      acceptanceCriteria: Array.isArray(row.acceptance_criteria)
        ? row.acceptance_criteria
        : JSON.parse(row.acceptance_criteria as unknown as string),
      dependencies: Array.isArray(row.dependencies)
        ? row.dependencies
        : JSON.parse(row.dependencies as unknown as string),
      priority: row.priority as 'high' | 'medium' | 'low',
      state: row.state as TaskState,
      assignee: row.assignee_id ?? undefined,
      parentTaskId: row.parent_task_id ?? undefined,
      sourceActionItemId: row.source_action_item_id,
      feishuTaskId: row.feishu_task_id ?? undefined,
      retryCount: row.retry_count,
      failureContext: row.failure_context ?? undefined,
      descriptionHistory: Array.isArray(row.description_history)
        ? row.description_history
        : JSON.parse(row.description_history as unknown as string),
      createdAt: row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
      updatedAt: row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row.updated_at),
    };
  }
}
