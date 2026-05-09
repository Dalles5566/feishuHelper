/**
 * Unit tests for TaskAssignmentService.
 *
 * Tests assignment CRUD operations with mocked database calls:
 * - Creating assignments
 * - Querying by task ID and assignee ID
 * - Reassignment logic (old assignment marked as 'reassigned')
 * - Assignment status transitions (active, reassigned, completed)
 * - Confirming assignments to begin monitoring
 *
 * Requirements: 3.1, 3.2, 3.3
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskAssignmentService } from './taskAssignment.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../utils/db.js', () => ({
  insert: vi.fn(),
  query: vi.fn(),
  queryOne: vi.fn(),
  update: vi.fn(),
}));

import { insert, query, queryOne, update } from '../utils/db.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createService(): TaskAssignmentService {
  return new TaskAssignmentService();
}

const sampleAssignmentRow = {
  id: 'assign-001',
  task_id: 'task-123',
  assignee_id: 'user-456',
  assignee_name: 'Alice',
  assigned_by: 'manager-789',
  assigned_at: new Date('2025-01-15T10:00:00Z'),
  status: 'active',
};

const sampleAssignParams = {
  taskId: 'task-123',
  assigneeId: 'user-456',
  assigneeName: 'Alice',
  assignedBy: 'manager-789',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskAssignmentService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // assignTask
  // -------------------------------------------------------------------------

  describe('assignTask', () => {
    it('should create a new assignment when no active assignment exists', async () => {
      const service = createService();
      vi.mocked(queryOne).mockResolvedValue(null); // no existing active assignment
      vi.mocked(insert).mockResolvedValue(sampleAssignmentRow);

      const result = await service.assignTask(sampleAssignParams);

      expect(result.id).toBe('assign-001');
      expect(result.taskId).toBe('task-123');
      expect(result.assigneeId).toBe('user-456');
      expect(result.assigneeName).toBe('Alice');
      expect(result.assignedBy).toBe('manager-789');
      expect(result.status).toBe('active');
      expect(vi.mocked(insert)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(update)).not.toHaveBeenCalled();
    });

    it('should mark old assignment as reassigned when reassigning', async () => {
      const service = createService();
      const existingRow = { ...sampleAssignmentRow, id: 'assign-old' };
      vi.mocked(queryOne).mockResolvedValue(existingRow); // existing active assignment
      vi.mocked(update).mockResolvedValue(1);
      vi.mocked(insert).mockResolvedValue({
        ...sampleAssignmentRow,
        id: 'assign-new',
        assignee_id: 'user-999',
        assignee_name: 'Bob',
      });

      const result = await service.assignTask({
        taskId: 'task-123',
        assigneeId: 'user-999',
        assigneeName: 'Bob',
        assignedBy: 'manager-789',
      });

      // Old assignment should be marked as reassigned
      expect(vi.mocked(update)).toHaveBeenCalledWith(
        `UPDATE task_assignments SET status = 'reassigned' WHERE id = $1`,
        ['assign-old'],
      );
      // New assignment should be created
      expect(result.id).toBe('assign-new');
      expect(result.assigneeId).toBe('user-999');
      expect(result.assigneeName).toBe('Bob');
      expect(result.status).toBe('active');
    });

    it('should throw validation error for empty taskId', async () => {
      const service = createService();

      await expect(
        service.assignTask({ ...sampleAssignParams, taskId: '' }),
      ).rejects.toThrow('Task ID is required for assignment');
    });

    it('should throw validation error for empty assigneeId', async () => {
      const service = createService();

      await expect(
        service.assignTask({ ...sampleAssignParams, assigneeId: '' }),
      ).rejects.toThrow('Assignee ID is required for assignment');
    });

    it('should throw validation error for empty assigneeName', async () => {
      const service = createService();

      await expect(
        service.assignTask({ ...sampleAssignParams, assigneeName: '' }),
      ).rejects.toThrow('Assignee name is required for assignment');
    });

    it('should throw validation error for empty assignedBy', async () => {
      const service = createService();

      await expect(
        service.assignTask({ ...sampleAssignParams, assignedBy: '' }),
      ).rejects.toThrow('Assigned by field is required');
    });
  });

  // -------------------------------------------------------------------------
  // confirmAssignment
  // -------------------------------------------------------------------------

  describe('confirmAssignment', () => {
    it('should confirm an active assignment', async () => {
      const service = createService();
      vi.mocked(queryOne).mockResolvedValue(sampleAssignmentRow);

      const result = await service.confirmAssignment('assign-001');

      expect(result.id).toBe('assign-001');
      expect(result.status).toBe('active');
    });

    it('should throw if assignment not found', async () => {
      const service = createService();
      vi.mocked(queryOne).mockResolvedValue(null);

      await expect(
        service.confirmAssignment('nonexistent'),
      ).rejects.toThrow('Assignment nonexistent not found');
    });

    it('should throw if assignment is not active', async () => {
      const service = createService();
      vi.mocked(queryOne).mockResolvedValue({
        ...sampleAssignmentRow,
        status: 'completed',
      });

      await expect(
        service.confirmAssignment('assign-001'),
      ).rejects.toThrow("Cannot confirm assignment with status 'completed'");
    });
  });

  // -------------------------------------------------------------------------
  // getAssignmentsByTaskId
  // -------------------------------------------------------------------------

  describe('getAssignmentsByTaskId', () => {
    it('should return all assignments for a task', async () => {
      const service = createService();
      vi.mocked(query).mockResolvedValue({
        rows: [
          sampleAssignmentRow,
          { ...sampleAssignmentRow, id: 'assign-002', status: 'reassigned' },
        ],
        rowCount: 2,
      });

      const result = await service.getAssignmentsByTaskId('task-123');

      expect(result).toHaveLength(2);
      expect(result[0].status).toBe('active');
      expect(result[1].status).toBe('reassigned');
    });

    it('should return empty array when no assignments exist', async () => {
      const service = createService();
      vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await service.getAssignmentsByTaskId('task-no-assignments');

      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getAssignmentsByAssigneeId
  // -------------------------------------------------------------------------

  describe('getAssignmentsByAssigneeId', () => {
    it('should return all assignments for a developer', async () => {
      const service = createService();
      vi.mocked(query).mockResolvedValue({
        rows: [
          sampleAssignmentRow,
          { ...sampleAssignmentRow, id: 'assign-003', task_id: 'task-456' },
        ],
        rowCount: 2,
      });

      const result = await service.getAssignmentsByAssigneeId('user-456');

      expect(result).toHaveLength(2);
      expect(result[0].taskId).toBe('task-123');
      expect(result[1].taskId).toBe('task-456');
    });

    it('should return empty array when developer has no assignments', async () => {
      const service = createService();
      vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await service.getAssignmentsByAssigneeId('user-no-tasks');

      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getActiveAssignments
  // -------------------------------------------------------------------------

  describe('getActiveAssignments', () => {
    it('should return all active assignments', async () => {
      const service = createService();
      vi.mocked(query).mockResolvedValue({
        rows: [
          sampleAssignmentRow,
          { ...sampleAssignmentRow, id: 'assign-004', task_id: 'task-789', assignee_id: 'user-111' },
        ],
        rowCount: 2,
      });

      const result = await service.getActiveAssignments();

      expect(result).toHaveLength(2);
      expect(result.every((a) => a.status === 'active')).toBe(true);
    });

    it('should return empty array when no active assignments exist', async () => {
      const service = createService();
      vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await service.getActiveAssignments();

      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // completeAssignment
  // -------------------------------------------------------------------------

  describe('completeAssignment', () => {
    it('should mark active assignment as completed', async () => {
      const service = createService();
      vi.mocked(queryOne).mockResolvedValue(sampleAssignmentRow);
      vi.mocked(update).mockResolvedValue(1);

      const result = await service.completeAssignment('task-123');

      expect(result).not.toBeNull();
      expect(result!.status).toBe('completed');
      expect(vi.mocked(update)).toHaveBeenCalledWith(
        `UPDATE task_assignments SET status = 'completed' WHERE id = $1`,
        ['assign-001'],
      );
    });

    it('should return null when no active assignment exists for the task', async () => {
      const service = createService();
      vi.mocked(queryOne).mockResolvedValue(null);

      const result = await service.completeAssignment('task-no-assignment');

      expect(result).toBeNull();
      expect(vi.mocked(update)).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // getActiveAssignmentForTask
  // -------------------------------------------------------------------------

  describe('getActiveAssignmentForTask', () => {
    it('should return the active assignment for a task', async () => {
      const service = createService();
      vi.mocked(queryOne).mockResolvedValue(sampleAssignmentRow);

      const result = await service.getActiveAssignmentForTask('task-123');

      expect(result).not.toBeNull();
      expect(result!.taskId).toBe('task-123');
      expect(result!.status).toBe('active');
    });

    it('should return null when no active assignment exists', async () => {
      const service = createService();
      vi.mocked(queryOne).mockResolvedValue(null);

      const result = await service.getActiveAssignmentForTask('task-no-assignment');

      expect(result).toBeNull();
    });
  });
});
