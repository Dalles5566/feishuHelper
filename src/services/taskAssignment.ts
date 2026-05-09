/**
 * Task Assignment service.
 *
 * Manages the assignment relationship between tasks and developers,
 * including creating assignment records, querying assignments,
 * maintaining assignment status, and handling reassignment logic.
 *
 * Requirements: 3.1, 3.2, 3.3
 */

import type { TaskAssignment } from '../models/task.js';
import { insert, query, queryOne, update } from '../utils/db.js';
import { AppError, BusinessErrorCodes, ValidationErrorCodes } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parameters for creating a new task assignment. */
export interface AssignTaskParams {
  taskId: string;
  assigneeId: string;
  assigneeName: string;
  assignedBy: string;
}

/** Database row shape for the task_assignments table. */
interface TaskAssignmentRow extends Record<string, unknown> {
  id: string;
  task_id: string;
  assignee_id: string;
  assignee_name: string;
  assigned_by: string;
  assigned_at: Date;
  status: string;
}

// ---------------------------------------------------------------------------
// TaskAssignmentService
// ---------------------------------------------------------------------------

/**
 * Manages task assignment lifecycle including creation, querying,
 * reassignment, and status transitions.
 */
export class TaskAssignmentService {
  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Assign a task to a developer.
   *
   * If the task already has an active assignment, the old assignment is marked
   * as 'reassigned' and a new 'active' assignment is created.
   *
   * @param params - Assignment parameters.
   * @returns The created assignment record.
   * @throws AppError on validation failure.
   */
  async assignTask(params: AssignTaskParams): Promise<TaskAssignment> {
    this.validateAssignParams(params);

    // Check for existing active assignment on this task
    const existingAssignment = await queryOne<TaskAssignmentRow>(
      `SELECT * FROM task_assignments WHERE task_id = $1 AND status = 'active'`,
      [params.taskId],
    );

    // If there's an existing active assignment, mark it as reassigned
    if (existingAssignment) {
      await update(
        `UPDATE task_assignments SET status = 'reassigned' WHERE id = $1`,
        [existingAssignment.id],
      );
    }

    // Create the new active assignment
    const row = await insert<TaskAssignmentRow>(
      `INSERT INTO task_assignments (task_id, assignee_id, assignee_name, assigned_by, status)
       VALUES ($1, $2, $3, $4, 'active')
       RETURNING *`,
      [params.taskId, params.assigneeId, params.assigneeName, params.assignedBy],
    );

    return this.rowToAssignment(row);
  }

  /**
   * Confirm an assignment and begin monitoring the task status.
   *
   * This acknowledges the assignment, indicating the developer has accepted it.
   * The task status monitoring begins from this point.
   *
   * @param assignmentId - The assignment ID to confirm.
   * @returns The confirmed assignment.
   * @throws AppError if the assignment is not found or not in 'active' status.
   */
  async confirmAssignment(assignmentId: string): Promise<TaskAssignment> {
    const row = await queryOne<TaskAssignmentRow>(
      `SELECT * FROM task_assignments WHERE id = $1`,
      [assignmentId],
    );

    if (!row) {
      throw AppError.businessLogic(
        BusinessErrorCodes.TASK_NOT_FOUND,
        `Assignment ${assignmentId} not found`,
        { assignmentId },
        'Verify the assignment ID is correct.',
      );
    }

    if (row.status !== 'active') {
      throw AppError.businessLogic(
        'BUSINESS_INVALID_ASSIGNMENT_STATUS',
        `Cannot confirm assignment with status '${row.status}'. Only active assignments can be confirmed.`,
        { assignmentId, currentStatus: row.status },
        'Only active assignments can be confirmed.',
      );
    }

    return this.rowToAssignment(row);
  }

  /**
   * Get all assignments for a specific task.
   *
   * @param taskId - The task ID.
   * @returns Array of assignments for the task (all statuses).
   */
  async getAssignmentsByTaskId(taskId: string): Promise<TaskAssignment[]> {
    const result = await query<TaskAssignmentRow>(
      `SELECT * FROM task_assignments WHERE task_id = $1 ORDER BY assigned_at DESC`,
      [taskId],
    );

    return result.rows.map((row) => this.rowToAssignment(row));
  }

  /**
   * Get all assignments for a specific developer.
   *
   * @param assigneeId - The developer's user ID.
   * @returns Array of assignments for the developer (all statuses).
   */
  async getAssignmentsByAssigneeId(assigneeId: string): Promise<TaskAssignment[]> {
    const result = await query<TaskAssignmentRow>(
      `SELECT * FROM task_assignments WHERE assignee_id = $1 ORDER BY assigned_at DESC`,
      [assigneeId],
    );

    return result.rows.map((row) => this.rowToAssignment(row));
  }

  /**
   * Get all active assignments across all tasks.
   *
   * Returns the current mapping of tasks to developers.
   *
   * @returns Array of all active assignments.
   */
  async getActiveAssignments(): Promise<TaskAssignment[]> {
    const result = await query<TaskAssignmentRow>(
      `SELECT * FROM task_assignments WHERE status = 'active' ORDER BY assigned_at DESC`,
      [],
    );

    return result.rows.map((row) => this.rowToAssignment(row));
  }

  /**
   * Mark an assignment as completed.
   *
   * @param taskId - The task ID whose active assignment should be completed.
   * @returns The updated assignment, or null if no active assignment exists.
   */
  async completeAssignment(taskId: string): Promise<TaskAssignment | null> {
    const row = await queryOne<TaskAssignmentRow>(
      `SELECT * FROM task_assignments WHERE task_id = $1 AND status = 'active'`,
      [taskId],
    );

    if (!row) {
      return null;
    }

    await update(
      `UPDATE task_assignments SET status = 'completed' WHERE id = $1`,
      [row.id],
    );

    return this.rowToAssignment({ ...row, status: 'completed' });
  }

  /**
   * Get the current active assignment for a task.
   *
   * @param taskId - The task ID.
   * @returns The active assignment, or null if none exists.
   */
  async getActiveAssignmentForTask(taskId: string): Promise<TaskAssignment | null> {
    const row = await queryOne<TaskAssignmentRow>(
      `SELECT * FROM task_assignments WHERE task_id = $1 AND status = 'active'`,
      [taskId],
    );

    if (!row) return null;
    return this.rowToAssignment(row);
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  /**
   * Validate assignment parameters.
   */
  private validateAssignParams(params: AssignTaskParams): void {
    if (!params.taskId || params.taskId.trim() === '') {
      throw AppError.validation(
        ValidationErrorCodes.MISSING_FIELD,
        'Task ID is required for assignment',
        { params },
        'Provide a valid task ID.',
      );
    }

    if (!params.assigneeId || params.assigneeId.trim() === '') {
      throw AppError.validation(
        ValidationErrorCodes.MISSING_FIELD,
        'Assignee ID is required for assignment',
        { params },
        'Provide a valid assignee ID.',
      );
    }

    if (!params.assigneeName || params.assigneeName.trim() === '') {
      throw AppError.validation(
        ValidationErrorCodes.MISSING_FIELD,
        'Assignee name is required for assignment',
        { params },
        'Provide the assignee name.',
      );
    }

    if (!params.assignedBy || params.assignedBy.trim() === '') {
      throw AppError.validation(
        ValidationErrorCodes.MISSING_FIELD,
        'Assigned by field is required',
        { params },
        'Provide who is making the assignment.',
      );
    }
  }

  /**
   * Convert a database row to a TaskAssignment domain object.
   */
  private rowToAssignment(row: TaskAssignmentRow): TaskAssignment {
    return {
      id: row.id,
      taskId: row.task_id,
      assigneeId: row.assignee_id,
      assigneeName: row.assignee_name,
      assignedBy: row.assigned_by,
      assignedAt: row.assigned_at instanceof Date
        ? row.assigned_at.toISOString()
        : String(row.assigned_at),
      status: row.status as 'active' | 'reassigned' | 'completed',
    };
  }
}
