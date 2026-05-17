/**
 * Agent Core Tool Box Register
 *
 * Defines and exports all LangChain DynamicStructuredTools for the AgentCore.
 * Each tool represents a capability the LLM can invoke.
 *
 * Tools:
 * 1. analyze_meeting - Analyze meeting content, save to DB
 * 2. query_sql - Read-only SQL queries
 * 3. create_feishu_task - Create task (DB + Feishu API)
 * 4. update_task - Update task fields (DB + Feishu sync)
 * 5. assign_task - Assign task to person (DB + Feishu addMembers)
 * 6. advance_task - Advance task state via workflow state machine
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod/v3';

/**
 * Register all agent tools and return them as an array.
 * @param feishuClient - The initialized @larksuiteoapi/node-sdk Client instance
 */
export function registerTools(feishuClient: any): DynamicStructuredTool[] {
  return [
    // Tool 1: Analyze meeting content
    new DynamicStructuredTool({
      name: 'analyze_meeting',
      description: 'Analyze meeting minutes or conversation records to extract structured action items, decisions, and summary. MUST be called first when receiving meeting content.',
      schema: z.object({
        content: z.string().describe('The meeting minutes or conversation text to analyze'),
      }),
      func: async ({ content }) => {
        try {
          const { MeetingAnalyzer } = await import('../services/meetingAnalyzer.js');
          const { insert } = await import('../utils/db.js');
          const analyzer = new MeetingAnalyzer();
          const result = await analyzer.analyze(content);

          // Save meeting to database
          const meetingRow = await insert(
            `INSERT INTO meetings (title, feishu_doc_id, raw_content, analysis)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [
              result.summary?.title || 'Untitled Meeting',
              `msg-${Date.now()}`,
              content,
              JSON.stringify(result),
            ],
          );
          const meetingId = (meetingRow as any).id;

          return JSON.stringify({ meetingId, ...result }, null, 2);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `❌ 会议分析失败: ${msg}`;
        }
      },
    }),

    // Tool 2: Read-only SQL query
    new DynamicStructuredTool({
      name: 'query_sql',
      description: 'Execute a read-only SQL SELECT query against the database. Use this for ANY data lookup: finding tasks, checking assignees, counting items, looking up employees, etc. ONLY SELECT statements are allowed — no INSERT, UPDATE, DELETE, DROP, ALTER, etc.',
      schema: z.object({
        sql: z.string().describe('The SQL SELECT query to execute. Must start with SELECT.'),
      }),
      func: async ({ sql }) => {
        try {
          const trimmed = sql.trim().toUpperCase();
          if (!trimmed.startsWith('SELECT')) {
            return '❌ 只允许 SELECT 查询。增删改请使用对应的专用工具。';
          }

          // Block dangerous statements (check as whole words, not substrings)
          const forbidden = /\b(INSERT|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE)\b/;
          if (forbidden.test(trimmed)) {
            const match = trimmed.match(forbidden);
            return `❌ SQL 中包含不允许的关键字: ${match?.[0]}`;
          }

          const { query: dbQuery } = await import('../utils/db.js');
          const result = await dbQuery<any>(sql, []);

          if (result.rows.length === 0) {
            return '查询结果为空。';
          }

          const maxRows = 20;
          const rows = result.rows.slice(0, maxRows);
          const output = JSON.stringify(rows, null, 2);

          return result.rows.length > maxRows
            ? `${output}\n\n... 共 ${result.rows.length} 行，仅显示前 ${maxRows} 行。`
            : output;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `❌ SQL 查询失败: ${msg}`;
        }
      },
    }),

    // Tool 3: Create a task in Feishu
    new DynamicStructuredTool({
      name: 'create_feishu_task',
      description: 'Create a task in Feishu. Use this after analyzing meeting content for each action item, or when the user directly asks to create a task. If assigning to someone, use query_sql to look up their open_id first.',
      schema: z.object({
        summary: z.string().describe('Task title/summary'),
        description: z.string().optional().describe('Task description with context'),
        due_date: z.string().optional().describe('Due date in YYYY-MM-DD format, e.g. 2026-05-25'),
        meeting_id: z.string().optional().describe('The meeting ID returned by analyze_meeting, to link the task to the meeting'),
        task_type: z.enum(['feature', 'bugfix']).optional().describe('Task type: "feature" (prefix F-) or "bugfix" (prefix B-). Defaults to "feature"'),
        priority: z.enum(['high', 'medium', 'low']).optional().describe('Task priority. Defaults to "medium"'),
        assignee_open_id: z.string().optional().describe('Feishu open_id of the assignee. Look up via query_sql from employees table if needed'),
        acceptance_criteria: z.array(z.string()).optional().describe('List of acceptance criteria for the task. Extract from meeting analysis action items.'),
        dependencies: z.array(z.string()).optional().describe('List of task dependencies (other task display_ids or descriptions). Extract from meeting analysis.'),
      }),
      func: async ({ summary, description, due_date, meeting_id, task_type, priority, assignee_open_id, acceptance_criteria, dependencies }) => {
        try {
          const { TaskManager } = await import('../services/taskManager.js');
          const taskManager = new TaskManager({ feishuClient });

          const task = await taskManager.createTask({
            title: summary,
            description: description || '',
            acceptanceCriteria: acceptance_criteria || [],
            dependencies: dependencies || [],
            priority: priority || 'medium',
            sourceActionItemId: `agent-${Date.now()}`,
            taskType: task_type || 'feature',
            dueDate: due_date,
            assigneeId: assignee_open_id,
          });

          // Link task to meeting if meeting_id provided
          if (meeting_id) {
            const { query: dbQuery } = await import('../utils/db.js');
            await dbQuery(
              `INSERT INTO task_meetings (task_id, meeting_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
              [task.id, meeting_id],
            );
          }

          // Auto-advance to Assigned if assignee was provided
          if (assignee_open_id) {
            try {
              const taskMgr = new (await import('../services/taskManager.js')).TaskManager({ feishuClient });
              await taskMgr.updateTaskState(task.id, 'Assigned', 'Assigned on creation');
            } catch {
              // Non-critical
            }
          }

          const taskUrl = `https://applink.feishu.cn/client/todo/detail?guid=${task.feishuTaskId}`;
          return `✅ 任务创建成功！\n编号: ${task.displayId}\n标题: ${summary}\n优先级: ${task.priority}\n链接: ${taskUrl}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `❌ 任务创建失败: ${msg}`;
        }
      },
    }),

    // Tool 4: Update task fields
    new DynamicStructuredTool({
      name: 'update_task',
      description: 'Update one or more fields of a task. Supports title, description, priority, due_date, and acceptance_criteria. All fields are optional — only provide the ones you want to change. A reason is required to track why the update was made.',
      schema: z.object({
        task_id: z.string().describe('The task ID (UUID) or display_id (e.g. F-000001) to update'),
        reason: z.string().describe('Reason for the update (e.g. "Meeting update on 2026-05-16", "Priority raised per PM request")'),
        title: z.string().optional().describe('New title for the task'),
        description: z.string().optional().describe('New description for the task'),
        priority: z.enum(['high', 'medium', 'low']).optional().describe('New priority'),
        due_date: z.string().optional().describe('New due date in YYYY-MM-DD format. Set to empty string to clear.'),
        acceptance_criteria: z.array(z.string()).optional().describe('New acceptance criteria (replaces existing list)'),
      }),
      func: async ({ task_id, reason, title, description, priority, due_date, acceptance_criteria }) => {
        try {
          const { queryOne, update: dbUpdate } = await import('../utils/db.js');

          let resolvedTaskId = task_id;
          if (/^[FB]-\d{6}$/.test(task_id)) {
            const row = await queryOne<any>('SELECT id FROM tasks WHERE display_id = $1', [task_id]);
            if (!row) return `❌ 任务不存在: ${task_id}`;
            resolvedTaskId = row.id;
          }

          const sets: string[] = [];
          const params: unknown[] = [];
          let paramIdx = 1;

          if (title !== undefined) {
            sets.push(`title = $${paramIdx++}`);
            params.push(title);
          }
          if (description !== undefined) {
            const { TaskManager } = await import('../services/taskManager.js');
            const taskManager = new TaskManager({ feishuClient });
            await taskManager.updateTaskDescription(resolvedTaskId, description, reason);
          } else if (sets.length === 0 && !priority && due_date === undefined && !acceptance_criteria) {
            return '❌ 没有提供要更新的字段。';
          }
          if (priority !== undefined) {
            sets.push(`priority = $${paramIdx++}`);
            params.push(priority);
          }
          if (due_date !== undefined) {
            sets.push(`due_date = $${paramIdx++}`);
            params.push(due_date === '' ? null : due_date);
          }
          if (acceptance_criteria !== undefined) {
            sets.push(`acceptance_criteria = $${paramIdx++}`);
            params.push(JSON.stringify(acceptance_criteria));
          }

          if (sets.length > 0) {
            sets.push(`updated_at = NOW()`);
            params.push(resolvedTaskId);
            await dbUpdate(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $${paramIdx}`, params);
          }

          // Sync to Feishu
          const taskRow = await queryOne<any>(
            'SELECT feishu_task_id, display_id, description FROM tasks WHERE id = $1',
            [resolvedTaskId],
          );
          if (taskRow?.feishu_task_id) {
            const feishuUpdate: Record<string, unknown> = {};
            const updateFields: string[] = [];

            if (title !== undefined) {
              feishuUpdate.summary = `${taskRow.display_id}-${title}`;
              updateFields.push('summary');
            }
            if (due_date !== undefined) {
              if (due_date === '') {
                feishuUpdate.due = null;
              } else {
                const ts = new Date(due_date + 'T00:00:00Z').getTime();
                if (!isNaN(ts)) {
                  feishuUpdate.due = { timestamp: String(ts), is_all_day: true };
                }
              }
              updateFields.push('due');
            }

            const currentDesc = description ?? taskRow.description;
            feishuUpdate.description = currentDesc;
            updateFields.push('description');

            try {
              await feishuClient.task.v2.task.patch({
                path: { task_guid: taskRow.feishu_task_id },
                params: { user_id_type: 'open_id' },
                data: { task: feishuUpdate, update_fields: updateFields },
              });
            } catch (feishuErr) {
              const errMsg = feishuErr instanceof Error ? feishuErr.message : String(feishuErr);
              console.error(`[update_task] Feishu sync failed: ${errMsg}`);
            }
          }

          return `✅ 任务 ${task_id} 已更新\n原因: ${reason}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `❌ 更新任务失败: ${msg}`;
        }
      },
    }),

    // Tool 5: Assign task to a person
    new DynamicStructuredTool({
      name: 'assign_task',
      description: 'Assign a task to a developer. This updates the local DB, writes an assignment record, and syncs to Feishu (adds the person as task member). Use query_sql to look up the employee open_id from their name first.',
      schema: z.object({
        task_id: z.string().describe('The task ID (UUID) or display_id (e.g. F-000001) to assign'),
        assignee_open_id: z.string().describe('The Feishu open_id of the person (look up from employees table via query_sql)'),
        assignee_name: z.string().describe('The name of the person being assigned'),
        reason: z.string().optional().describe('Reason for the assignment or reassignment'),
      }),
      func: async ({ task_id, assignee_open_id, assignee_name, reason }) => {
        try {
          const { queryOne, update: dbUpdate } = await import('../utils/db.js');

          let resolvedTaskId = task_id;
          if (/^[FB]-\d{6}$/.test(task_id)) {
            const row = await queryOne<any>('SELECT id FROM tasks WHERE display_id = $1', [task_id]);
            if (!row) return `❌ 任务不存在: ${task_id}`;
            resolvedTaskId = row.id;
          }

          await dbUpdate(
            `UPDATE tasks SET assignee_id = $1, updated_at = NOW() WHERE id = $2`,
            [assignee_open_id, resolvedTaskId],
          );

          const { TaskAssignmentService } = await import('../services/taskAssignment.js');
          const assignmentService = new TaskAssignmentService();
          await assignmentService.assignTask({
            taskId: resolvedTaskId,
            assigneeId: assignee_open_id,
            assigneeName: assignee_name,
            assignedBy: 'agent',
          });

          // Auto-advance state to Assigned if currently Created
          const currentTask = await queryOne<any>('SELECT state FROM tasks WHERE id = $1', [resolvedTaskId]);
          if (currentTask?.state === 'Created') {
            try {
              const { TaskManager } = await import('../services/taskManager.js');
              const taskManager = new TaskManager({ feishuClient });
              await taskManager.updateTaskState(resolvedTaskId, 'Assigned', 'Task assigned');
            } catch {
              // Non-critical: assignment succeeded even if state advance fails
            }
          }

          // Track in description_history
          const taskRow = await queryOne<any>(
            'SELECT feishu_task_id, description_history FROM tasks WHERE id = $1',
            [resolvedTaskId],
          );
          const history = Array.isArray(taskRow?.description_history)
            ? taskRow.description_history
            : JSON.parse(taskRow?.description_history || '[]');
          history.push({
            previousDescription: '',
            newDescription: '',
            reason: reason || `分配给 ${assignee_name}`,
            updatedBy: 'agent',
            updatedAt: new Date().toISOString(),
          });
          await dbUpdate(
            `UPDATE tasks SET description_history = $1 WHERE id = $2`,
            [JSON.stringify(history), resolvedTaskId],
          );

          // Sync to Feishu
          if (taskRow?.feishu_task_id) {
            try {
              await feishuClient.task.v2.task.addMembers({
                path: { task_guid: taskRow.feishu_task_id },
                params: { user_id_type: 'open_id' },
                data: {
                  members: [{ type: 'user', id: assignee_open_id, role: 'assignee' }],
                },
              });
            } catch (feishuErr) {
              const errMsg = feishuErr instanceof Error ? feishuErr.message : String(feishuErr);
              console.error(`[assign_task] Feishu sync failed: ${errMsg}`);
            }
          }

          return `✅ 任务已分配给 ${assignee_name}\n任务: ${task_id}${reason ? `\n原因: ${reason}` : ''}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `❌ 分配任务失败: ${msg}`;
        }
      },
    }),

    // Tool 6: Advance task state (workflow state machine)
    new DynamicStructuredTool({
      name: 'advance_task',
      description: `Advance a task to its next state in the workflow. The state machine enforces valid transitions only.
Valid events and their transitions:
- "assigned": Created → Assigned (task has been assigned to someone)
- "confirmed": Assigned → InDevelopment (developer confirms they will work on it)
- "dev_complete": InDevelopment → VerificationPending (developer marks work as done)
- "verification_passed": VerificationPending → VerificationPassed (code verification passed)
- "qa_passed": QAPending → QAPassed (QA testing passed)
- "doc_updated": QAPassed → DocumentationUpdated (documentation updated)
- "completed": DocumentationUpdated → Completed (all done)
- "qa_failed_impl": QAPending → InDevelopment (QA failed due to implementation error)
- "qa_failed_req": QAPending → Created (QA failed due to requirement error)
- "verification_failed": VerificationPending → InDevelopment (verification failed, redo)
Invalid transitions will be rejected.`,
      schema: z.object({
        task_id: z.string().describe('The task ID (UUID) or display_id (e.g. F-000001)'),
        event: z.string().describe('The workflow event: confirmed, dev_complete, verification_passed, qa_passed, doc_updated, completed, qa_failed_impl, qa_failed_req, verification_failed'),
        reason: z.string().optional().describe('Reason for the state change'),
      }),
      func: async ({ task_id, event, reason }) => {
        try {
          const { queryOne } = await import('../utils/db.js');

          let resolvedTaskId = task_id;
          if (/^[FB]-\d{6}$/.test(task_id)) {
            const row = await queryOne<any>('SELECT id FROM tasks WHERE display_id = $1', [task_id]);
            if (!row) return `❌ 任务不存在: ${task_id}`;
            resolvedTaskId = row.id;
          }

          const eventToState: Record<string, string> = {
            assigned: 'Assigned',
            confirmed: 'InDevelopment',
            dev_complete: 'VerificationPending',
            verification_passed: 'VerificationPassed',
            qa_passed: 'QAPassed',
            doc_updated: 'DocumentationUpdated',
            completed: 'Completed',
            qa_failed_impl: 'InDevelopment',
            qa_failed_req: 'Created',
            verification_failed: 'InDevelopment',
          };

          const targetState = eventToState[event];
          if (!targetState) {
            return `❌ 未知事件: "${event}"。支持的事件: ${Object.keys(eventToState).join(', ')}`;
          }

          const { TaskManager } = await import('../services/taskManager.js');
          const taskManager = new TaskManager({ feishuClient });

          // Smart transition: if event requires intermediate steps, auto-advance
          const currentTaskRow = await queryOne<any>('SELECT state FROM tasks WHERE id = $1', [resolvedTaskId]);
          if (!currentTaskRow) return `❌ 任务不存在: ${task_id}`;
          const currentState = currentTaskRow.state;

          // Handle "confirmed" from Created: auto-advance through Assigned first
          if (event === 'confirmed' && currentState === 'Created') {
            await taskManager.updateTaskState(resolvedTaskId, 'Assigned', 'Auto-assigned before confirmation');
          }

          const task = await taskManager.updateTaskState(
            resolvedTaskId,
            targetState as any,
            reason || event,
          );

          return `✅ 任务状态已更新\n任务: ${task_id}\n新状态: ${task.state}${reason ? `\n原因: ${reason}` : ''}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `❌ 状态推进失败: ${msg}`;
        }
      },
    }),
  ];
}
