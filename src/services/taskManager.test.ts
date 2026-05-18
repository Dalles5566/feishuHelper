/**
 * Unit tests for TaskManager service.
 *
 * Tests task CRUD operations with mocked dependencies:
 * - FeishuMcpService (Feishu API calls)
 * - Database utilities (persistence)
 * - State machine (state transitions)
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskManager } from './taskManager.js';
import { AppError } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('./feishuMcp.js', () => ({
  FeishuMcpService: vi.fn().mockImplementation(() => ({
    callTool: vi.fn(),
  })),
}));

vi.mock('../utils/db.js', () => ({
  insert: vi.fn(),
  query: vi.fn(),
  queryOne: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../utils/retry.js', () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../workflow/stateMachine.js', () => ({
  transition: vi.fn().mockResolvedValue(true),
}));

// Import mocked modules
import { FeishuMcpService } from './feishuMcp.js';
import { insert, query, queryOne, update } from '../utils/db.js';
import { withRetry } from '../utils/retry.js';
import { transition } from '../workflow/stateMachine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockFeishuMcpService = {
  callTool: vi.fn(),
};

function createTaskManager(): TaskManager {
  return new TaskManager({
    feishuMcpService: mockFeishuMcpService as unknown as FeishuMcpService,
    retryOptions: { sleep: async () => {} },
  });
}

const sampleTaskRow = {
  id: 'task-123',
  title: 'Implement login',
  description: 'Implement user login with OAuth',
  dependencies: ['dep-1'],
  priority: 'high',
  state: 'Created',
  assignee_id: null,
  parent_task_id: null,
  meeting_id: 'meeting-456',
  source_action_item_id: 'action-789',
  feishu_task_id: 'feishu-task-001',
  retry_count: 0,
  failure_context: null,
  description_history: [],
  created_at: new Date('2025-01-15T10:00:00Z'),
  updated_at: new Date('2025-01-15T10:00:00Z'),
};

const sampleCreateParams = {
  title: 'Implement login',
  description: 'Implement user login with OAuth',
  dependencies: ['dep-1'],
  priority: 'high' as const,
  sourceActionItemId: 'action-789',
  meetingId: 'meeting-456',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFeishuMcpService.callTool.mockResolvedValue({
      isError: false,
      content: [{ type: 'text', text: JSON.stringify({ task_id: 'feishu-task-001' }) }],
    });
  });

  // -------------------------------------------------------------------------
  // createTask
  // -------------------------------------------------------------------------

  describe('createTask', () => {
    it('should create a task in Feishu and persist it locally', async () => {
      const manager = createTaskManager();
      vi.mocked(withRetry).mockImplementation(async (fn) => (fn as () => Promise<unknown>)());
      mockFeishuMcpService.callTool.mockResolvedValue({
        isError: false,
        content: [{ type: 'text', text: JSON.stringify({ task_id: 'feishu-task-001' }) }],
      });
      vi.mocked(insert).mockResolvedValue(sampleTaskRow);

      const result = await manager.createTask(sampleCreateParams);

      expect(result.id).toBe('task-123');
      expect(result.title).toBe('Implement login');
      expect(result.feishuTaskId).toBe('feishu-task-001');
      expect(result.state).toBe('Created');
      expect(result.descriptionHistory).toEqual([]);
      expect(vi.mocked(insert)).toHaveBeenCalledTimes(1);
    });

    it('should use withRetry for Feishu MCP call', async () => {
      const manager = createTaskManager();
      vi.mocked(withRetry).mockImplementation(async (fn) => (fn as () => Promise<unknown>)());
      mockFeishuMcpService.callTool.mockResolvedValue({
        isError: false,
        content: [{ type: 'text', text: JSON.stringify({ task_id: 'feishu-task-001' }) }],
      });
      vi.mocked(insert).mockResolvedValue(sampleTaskRow);

      await manager.createTask(sampleCreateParams);

      expect(vi.mocked(withRetry)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(withRetry)).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          policies: expect.objectContaining({
            feishu_api: expect.objectContaining({ maxRetries: 3 }),
          }),
        }),
      );
    });

    it('should throw validation error for empty title', async () => {
      const manager = createTaskManager();

      await expect(
        manager.createTask({ ...sampleCreateParams, title: '' }),
      ).rejects.toThrow('Task title is required');
    });

    it('should throw validation error for empty description', async () => {
      const manager = createTaskManager();

      await expect(
        manager.createTask({ ...sampleCreateParams, description: '' }),
      ).rejects.toThrow('Task description is required');
    });

    it('should throw validation error for empty meetingId', async () => {
      const manager = createTaskManager();

      await expect(
        manager.createTask({ ...sampleCreateParams, meetingId: '' }),
      ).rejects.toThrow('Meeting ID is required');
    });

    it('should throw validation error for empty sourceActionItemId', async () => {
      const manager = createTaskManager();

      await expect(
        manager.createTask({ ...sampleCreateParams, sourceActionItemId: '' }),
      ).rejects.toThrow('Source action item ID is required');
    });

    it('should handle non-JSON Feishu response as raw task ID', async () => {
      const manager = createTaskManager();
      vi.mocked(withRetry).mockImplementation(async (fn) => (fn as () => Promise<unknown>)());
      mockFeishuMcpService.callTool.mockResolvedValue({
        isError: false,
        content: [{ type: 'text', text: 'raw-feishu-id-123' }],
      });
      vi.mocked(insert).mockResolvedValue({
        ...sampleTaskRow,
        feishu_task_id: 'raw-feishu-id-123',
      });

      const result = await manager.createTask(sampleCreateParams);

      expect(result.feishuTaskId).toBe('raw-feishu-id-123');
    });
  });

  // -------------------------------------------------------------------------
  // splitTask
  // -------------------------------------------------------------------------

  describe('splitTask', () => {
    const subtaskParams = [
      { title: 'Frontend login UI', description: 'Build login form', scope: 'frontend UI' },
      { title: 'Backend auth API', description: 'Build auth endpoint', scope: 'backend API' },
    ];

    it('should split a task into subtasks', async () => {
      const manager = createTaskManager();
      vi.mocked(queryOne).mockResolvedValue(sampleTaskRow);
      vi.mocked(withRetry).mockImplementation(async (fn) => (fn as () => Promise<unknown>)());
      mockFeishuMcpService.callTool.mockResolvedValue({
        isError: false,
        content: [{ type: 'text', text: JSON.stringify({ task_id: 'feishu-sub-001' }) }],
      });
      vi.mocked(insert).mockResolvedValue({
        ...sampleTaskRow,
        id: 'subtask-1',
        parent_task_id: 'task-123',
      });

      const result = await manager.splitTask('task-123', subtaskParams);

      expect(result).toHaveLength(2);
      expect(result[0].parentTaskId).toBe('task-123');
      expect(result[0].scope).toBe('frontend UI');
      expect(result[1].scope).toBe('backend API');
    });

    it('should throw if parent task not found', async () => {
      const manager = createTaskManager();
      vi.mocked(queryOne).mockResolvedValue(null);

      await expect(
        manager.splitTask('nonexistent-id', subtaskParams),
      ).rejects.toThrow('Parent task nonexistent-id not found');
    });

    it('should throw if subtask scopes are identical', async () => {
      const manager = createTaskManager();
      vi.mocked(queryOne).mockResolvedValue(sampleTaskRow);

      const overlapping = [
        { title: 'Task A', description: 'Desc A', scope: 'frontend' },
        { title: 'Task B', description: 'Desc B', scope: 'frontend' },
      ];

      await expect(
        manager.splitTask('task-123', overlapping),
      ).rejects.toThrow(/scopes overlap/i);
    });

    it('should throw if one scope contains another', async () => {
      const manager = createTaskManager();
      vi.mocked(queryOne).mockResolvedValue(sampleTaskRow);

      const overlapping = [
        { title: 'Task A', description: 'Desc A', scope: 'frontend UI components' },
        { title: 'Task B', description: 'Desc B', scope: 'frontend UI' },
      ];

      await expect(
        manager.splitTask('task-123', overlapping),
      ).rejects.toThrow(/scopes overlap/i);
    });

    it('should throw if no subtasks provided', async () => {
      const manager = createTaskManager();
      vi.mocked(queryOne).mockResolvedValue(sampleTaskRow);

      await expect(
        manager.splitTask('task-123', []),
      ).rejects.toThrow('At least one subtask is required');
    });
  });

  // -------------------------------------------------------------------------
  // updateTaskDescription
  // -------------------------------------------------------------------------

  describe('updateTaskDescription', () => {
    it('should update description and preserve history', async () => {
      const manager = createTaskManager();
      vi.mocked(queryOne).mockResolvedValue(sampleTaskRow);
      vi.mocked(update).mockResolvedValue(1);

      const result = await manager.updateTaskDescription(
        'task-123',
        'Updated description',
        'Meeting update on 2025-01-16',
      );

      expect(result.description).toBe('Updated description');
      expect(result.descriptionHistory).toHaveLength(1);
      expect(result.descriptionHistory[0].previousDescription).toBe(
        'Implement user login with OAuth',
      );
      expect(result.descriptionHistory[0].newDescription).toBe('Updated description');
      expect(result.descriptionHistory[0].reason).toBe('Meeting update on 2025-01-16');
      expect(result.descriptionHistory[0].updatedAt).toBeDefined();
    });

    it('should append to existing history', async () => {
      const manager = createTaskManager();
      const existingHistory = [
        {
          previousDescription: 'Original',
          newDescription: 'First update',
          reason: 'Initial change',
          updatedBy: 'system',
          updatedAt: '2025-01-14T10:00:00Z',
        },
      ];
      vi.mocked(queryOne).mockResolvedValue({
        ...sampleTaskRow,
        description: 'First update',
        description_history: existingHistory,
      });
      vi.mocked(update).mockResolvedValue(1);

      const result = await manager.updateTaskDescription(
        'task-123',
        'Second update',
        'Another meeting',
      );

      expect(result.descriptionHistory).toHaveLength(2);
      expect(result.descriptionHistory[0].reason).toBe('Initial change');
      expect(result.descriptionHistory[1].previousDescription).toBe('First update');
      expect(result.descriptionHistory[1].newDescription).toBe('Second update');
      expect(result.descriptionHistory[1].reason).toBe('Another meeting');
    });

    it('should throw if task not found', async () => {
      const manager = createTaskManager();
      vi.mocked(queryOne).mockResolvedValue(null);

      await expect(
        manager.updateTaskDescription('nonexistent', 'New desc', 'reason'),
      ).rejects.toThrow('Task nonexistent not found');
    });

    it('should throw if description is empty', async () => {
      const manager = createTaskManager();

      await expect(
        manager.updateTaskDescription('task-123', '', 'reason'),
      ).rejects.toThrow('Task description cannot be empty');
    });

    it('should throw if reason is empty', async () => {
      const manager = createTaskManager();

      await expect(
        manager.updateTaskDescription('task-123', 'New desc', ''),
      ).rejects.toThrow('Update reason is required');
    });
  });

  // -------------------------------------------------------------------------
  // updateTaskState
  // -------------------------------------------------------------------------

  describe('updateTaskState', () => {
    it('should transition task state via state machine', async () => {
      const manager = createTaskManager();
      vi.mocked(queryOne).mockResolvedValue(sampleTaskRow);
      vi.mocked(transition).mockResolvedValue(true);

      const result = await manager.updateTaskState(
        'task-123',
        'Assigned',
        'User assigned task',
      );

      expect(result.state).toBe('Assigned');
      expect(vi.mocked(transition)).toHaveBeenCalledWith(
        'task-123',
        'Assigned',
        expect.objectContaining({
          trigger: 'User assigned task',
          actor: 'system',
          reason: 'User assigned task',
        }),
      );
    });

    it('should throw if task not found', async () => {
      const manager = createTaskManager();
      vi.mocked(queryOne).mockResolvedValue(null);

      await expect(
        manager.updateTaskState('nonexistent', 'Assigned', 'trigger'),
      ).rejects.toThrow('Task nonexistent not found');
    });

    it('should propagate state machine errors', async () => {
      const manager = createTaskManager();
      vi.mocked(queryOne).mockResolvedValue(sampleTaskRow);
      vi.mocked(transition).mockRejectedValue(
        AppError.stateTransition(
          'STATE_INVALID_TRANSITION',
          'Invalid transition: Created → Completed',
        ),
      );

      await expect(
        manager.updateTaskState('task-123', 'Completed', 'skip ahead'),
      ).rejects.toThrow('Invalid transition');
    });
  });

  // -------------------------------------------------------------------------
  // getTask
  // -------------------------------------------------------------------------

  describe('getTask', () => {
    it('should return a task by ID', async () => {
      const manager = createTaskManager();
      vi.mocked(queryOne).mockResolvedValue(sampleTaskRow);

      const result = await manager.getTask('task-123');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('task-123');
      expect(result!.title).toBe('Implement login');
    });

    it('should return null if task not found', async () => {
      const manager = createTaskManager();
      vi.mocked(queryOne).mockResolvedValue(null);

      const result = await manager.getTask('nonexistent');

      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // listTasks
  // -------------------------------------------------------------------------

  describe('listTasks', () => {
    it('should list all tasks without filter', async () => {
      const manager = createTaskManager();
      vi.mocked(query).mockResolvedValue({
        rows: [sampleTaskRow],
        rowCount: 1,
      });

      const result = await manager.listTasks();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('task-123');
    });

    it('should apply state filter', async () => {
      const manager = createTaskManager();
      vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 });

      await manager.listTasks({ state: 'Assigned' });

      expect(vi.mocked(query)).toHaveBeenCalledWith(
        expect.stringContaining('WHERE state = $1'),
        ['Assigned'],
      );
    });

    it('should apply multiple filters', async () => {
      const manager = createTaskManager();
      vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 });

      await manager.listTasks({ state: 'Created', priority: 'high' });

      expect(vi.mocked(query)).toHaveBeenCalledWith(
        expect.stringContaining('state = $1'),
        expect.arrayContaining(['Created', 'high']),
      );
    });

    it('should return empty array when no tasks match', async () => {
      const manager = createTaskManager();
      vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await manager.listTasks({ assignee: 'nobody' });

      expect(result).toEqual([]);
    });
  });
});
