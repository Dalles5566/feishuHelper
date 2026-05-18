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
 * 7. verify_code - AI code verification (report only, no state change)
 * 8. generate_test_doc - Generate QA test document
 * 9. submit_qa_feedback - Submit QA result and auto-advance state
 * 10. sync_task - Pull latest task state from Feishu into local DB
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod/v3';

// ---------------------------------------------------------------------------
// Helper: Sync task description to Feishu with history
// ---------------------------------------------------------------------------

/**
 * Append an event to the task's description_history in DB,
 * then sync the full description (content + history) to Feishu.
 *
 * Called internally by tools that modify task state/content.
 */
async function syncDescriptionToFeishu(
  taskId: string,
  event: string,
  feishuClient: any,
): Promise<void> {
  try {
    const { queryOne, update: dbUpdate } = await import('../utils/db.js');

    // Append event to description_history
    const taskRow = await queryOne<any>(
      'SELECT feishu_task_id, display_id, description, description_history FROM tasks WHERE id = $1',
      [taskId],
    );
    if (!taskRow?.feishu_task_id) return;

    const history = Array.isArray(taskRow.description_history)
      ? taskRow.description_history
      : JSON.parse(taskRow.description_history || '[]');

    // Only append a history entry if event is non-empty
    if (event && event.trim()) {
      history.push({
        previousDescription: '',
        newDescription: '',
        reason: event,
        updatedBy: 'system',
        updatedAt: new Date().toISOString(),
      });

      await dbUpdate(
        `UPDATE tasks SET description_history = $1, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(history), taskId],
      );
    }

    // Build Feishu description: re-read description from DB in case it was just updated
    // (e.g. when called after updateTaskDescription with empty event)
    const freshDesc = event && event.trim()
      ? (taskRow.description || '')
      : await (async () => {
          const fresh = await queryOne<any>('SELECT description, description_history FROM tasks WHERE id = $1', [taskId]);
          // Use fresh history too if we didn't push a new entry
          if (fresh) {
            const freshHistory = Array.isArray(fresh.description_history)
              ? fresh.description_history
              : JSON.parse(fresh.description_history || '[]');
            history.length = 0;
            history.push(...freshHistory);
          }
          return fresh?.description || taskRow.description || '';
        })();

    const historyText = history
      .slice()
      .reverse()
      .filter((h: any) => h.reason && String(h.reason).trim())
      .map((h: any) => `[${h.updatedAt?.split('T')[0] || ''}] ${h.reason}`)
      .join('\n');

    const feishuDesc = `${freshDesc}\n\n--- 变更历史 ---\n${historyText}`;

    // Sync to Feishu
    await feishuClient.task.v2.task.patch({
      path: { task_guid: taskRow.feishu_task_id },
      params: { user_id_type: 'open_id' },
      data: {
        task: { description: feishuDesc },
        update_fields: ['description'],
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[syncDescriptionToFeishu] Failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Tool Registration
// ---------------------------------------------------------------------------

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
        dependencies: z.array(z.string()).optional().describe('List of task dependencies (other task display_ids or descriptions). Extract from meeting analysis.'),
      }),
      func: async ({ summary, description, due_date, meeting_id, task_type, priority, assignee_open_id, dependencies }) => {
        try {
          const { TaskManager } = await import('../services/taskManager.js');
          const taskManager = new TaskManager({ feishuClient });

          const task = await taskManager.createTask({
            title: summary,
            description: description || '',
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

          // Sync description with history to Feishu
          await syncDescriptionToFeishu(task.id, `任务创建: ${summary}`, feishuClient);

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
      description: 'Update one or more fields of a task. Supports title, description, priority, and due_date. All fields are optional — only provide the ones you want to change. A reason is required to track why the update was made.',
      schema: z.object({
        task_id: z.string().describe('The task ID (UUID) or display_id (e.g. F-000001) to update'),
        reason: z.string().describe('Reason for the update (e.g. "Meeting update on 2026-05-16", "Priority raised per PM request")'),
        title: z.string().optional().describe('New title for the task'),
        description: z.string().optional().describe('New description for the task'),
        priority: z.enum(['high', 'medium', 'low']).optional().describe('New priority'),
        due_date: z.string().optional().describe('New due date in YYYY-MM-DD format. Set to empty string to clear.'),
      }),
      func: async ({ task_id, reason, title, description, priority, due_date }) => {
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
          } else if (sets.length === 0 && !priority && due_date === undefined) {
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

          if (sets.length > 0) {
            sets.push(`updated_at = NOW()`);
            params.push(resolvedTaskId);
            await dbUpdate(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $${paramIdx}`, params);
          }

          // Sync title/due to Feishu if changed
          const taskRow = await queryOne<any>(
            'SELECT feishu_task_id, display_id FROM tasks WHERE id = $1',
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

            if (updateFields.length > 0) {
              try {
                await feishuClient.task.v2.task.patch({
                  path: { task_guid: taskRow.feishu_task_id },
                  params: { user_id_type: 'open_id' },
                  data: { task: feishuUpdate, update_fields: updateFields },
                });
              } catch (feishuErr) {
                const errMsg = feishuErr instanceof Error ? feishuErr.message : String(feishuErr);
                console.error(`[update_task] Feishu title/due sync failed: ${errMsg}`);
              }
            }
          }

          // Sync description with history (skip if description was updated via TaskManager — it already records history)
          if (description === undefined) {
            await syncDescriptionToFeishu(resolvedTaskId, `更新: ${reason}`, feishuClient);
          } else {
            // TaskManager.updateTaskDescription already wrote to description_history,
            // just sync the current state to Feishu without adding another history entry
            const { queryOne: qo2 } = await import('../utils/db.js');
            const freshRow = await qo2<any>(
              'SELECT feishu_task_id, description, description_history FROM tasks WHERE id = $1',
              [resolvedTaskId],
            );
            if (freshRow?.feishu_task_id) {
              const hist = Array.isArray(freshRow.description_history)
                ? freshRow.description_history
                : JSON.parse(freshRow.description_history || '[]');
              const histText = hist.slice().reverse().map((h: any) => `[${h.updatedAt?.split('T')[0] || ''}] ${h.reason}`).join('\n');
              const desc = `${freshRow.description || ''}\n\n--- 变更历史 ---\n${histText}`;
              try {
                await feishuClient.task.v2.task.patch({
                  path: { task_guid: freshRow.feishu_task_id },
                  params: { user_id_type: 'open_id' },
                  data: { task: { description: desc }, update_fields: ['description'] },
                });
              } catch { }
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

          // Sync to Feishu: add member
          const taskRow = await queryOne<any>(
            'SELECT feishu_task_id FROM tasks WHERE id = $1',
            [resolvedTaskId],
          );
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
              console.error(`[assign_task] Feishu addMembers failed: ${errMsg}`);
            }
          }

          // Sync description with history
          await syncDescriptionToFeishu(resolvedTaskId, reason || `分配给 ${assignee_name}`, feishuClient);

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
- "dev_complete": InDevelopment → QAPending (developer marks work as done, goes directly to QA)
- "qa_passed": QAPending → QAPassed → Completed (QA testing passed, task is done)
- "qa_failed_impl": QAPending → QAFailed → InDevelopment (QA failed due to implementation error)
- "qa_failed_req": QAPending → QAFailed → Created (QA failed due to requirement error)
Invalid transitions will be rejected.`,
      schema: z.object({
        task_id: z.string().describe('The task ID (UUID) or display_id (e.g. F-000001)'),
        event: z.string().describe('The workflow event: assigned, confirmed, dev_complete, qa_passed, qa_failed_impl, qa_failed_req'),
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
            dev_complete: 'QAPending',
            qa_passed: 'QAPassed',
            qa_failed_impl: 'InDevelopment',
            qa_failed_req: 'Created',
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

          // Handle QA failures from QAPending: auto-advance through QAFailed first
          if ((event === 'qa_failed_impl' || event === 'qa_failed_req') && currentState === 'QAPending') {
            await taskManager.updateTaskState(resolvedTaskId, 'QAFailed', reason || 'QA failed');
          }

          const task = await taskManager.updateTaskState(
            resolvedTaskId,
            targetState as any,
            reason || event,
          );

          // Handle QA passed: auto-advance QAPassed → Completed
          if (event === 'qa_passed' && task.state === 'QAPassed') {
            try {
              await taskManager.updateTaskState(resolvedTaskId, 'Completed', 'QA passed — task completed');
            } catch {
              // Non-critical
            }
          }

          return `✅ 任务状态已更新\n任务: ${task_id}\n新状态: ${task.state}${reason ? `\n原因: ${reason}` : ''}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `❌ 状态推进失败: ${msg}`;
        }
      },
    }),

    // Tool 7: Verify code (AI code review — generates report only, no state change)
    new DynamicStructuredTool({
      name: 'verify_code',
      description: `Verify code changes against task requirements. Generates a verification report as reference for QA.
- If code_changes is provided (git diff), AI will analyze the code against the task description.
- If no code_changes, AI generates a reference report based on task description only.
- This tool does NOT change task state. Use advance_task("dev_complete") to move to QAPending.`,
      schema: z.object({
        task_id: z.string().describe('The task ID (UUID) or display_id (e.g. F-000001)'),
        code_changes: z.string().optional().describe('Git diff or code snippet to verify. If not provided, generates a reference report based on requirements only.'),
      }),
      func: async ({ task_id, code_changes }) => {
        try {
          const { queryOne } = await import('../utils/db.js');

          let resolvedTaskId = task_id;
          if (/^[FB]-\d{6}$/.test(task_id)) {
            const row = await queryOne<any>('SELECT id FROM tasks WHERE display_id = $1', [task_id]);
            if (!row) return `❌ 任务不存在: ${task_id}`;
            resolvedTaskId = row.id;
          }

          const taskRow = await queryOne<any>(
            'SELECT title, description FROM tasks WHERE id = $1',
            [resolvedTaskId],
          );
          if (!taskRow) return `❌ 任务不存在: ${task_id}`;

          const { CodeVerifier } = await import('../services/codeVerifier.js');
          const verifier = new CodeVerifier();

          const report = await verifier.verify(resolvedTaskId, {
            taskDescription: taskRow.description,
            codeChanges: code_changes || '(No code provided — reference report based on requirements)',
          });

          const statusEmoji = report.status === 'passed' ? '✅' : report.status === 'failed' ? '⚠️' : '📋';
          return `${statusEmoji} 代码验证报告\n任务: ${task_id}\n状态: ${report.status}\n匹配度: ${report.matchScore}/100\n已匹配标准: ${report.analysis.matchedCriteria.length}\n未匹配标准: ${report.analysis.unmatchedCriteria.length}\n建议: ${report.analysis.recommendations.join('; ') || '无'}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `❌ 代码验证失败: ${msg}`;
        }
      },
    }),

    // Tool 8: Generate test document for QA
    new DynamicStructuredTool({
      name: 'generate_test_doc',
      description: `Generate a test document for QA based on task acceptance criteria. Call this when a developer says they're done.
Generates positive, negative, and boundary test cases. Auto-advances state: InDevelopment → QAPending.`,
      schema: z.object({
        task_id: z.string().describe('The task ID (UUID) or display_id (e.g. F-000001)'),
      }),
      func: async ({ task_id }) => {
        try {
          const { queryOne, insert } = await import('../utils/db.js');

          let resolvedTaskId = task_id;
          if (/^[FB]-\d{6}$/.test(task_id)) {
            const row = await queryOne<any>('SELECT id FROM tasks WHERE display_id = $1', [task_id]);
            if (!row) return `❌ 任务不存在: ${task_id}`;
            resolvedTaskId = row.id;
          }

          // Get task details
          const taskRow = await queryOne<any>(
            'SELECT title, description, state FROM tasks WHERE id = $1',
            [resolvedTaskId],
          );
          if (!taskRow) return `❌ 任务不存在: ${task_id}`;

          // Generate test document
          const { DocGenerator } = await import('../services/docGenerator.js');
          const generator = new DocGenerator();

          const testDoc = await generator.generateTestDocument({
            id: resolvedTaskId,
            title: taskRow.title,
            description: taskRow.description || '',
            dependencies: [],
            priority: 'medium',
            state: 'InDevelopment',
            sourceActionItemId: '',
            retryCount: 0,
            descriptionHistory: [],
            displayId: '',
            taskType: 'feature',
            createdAt: '',
            updatedAt: '',
          } as any);

          // Save test document to documents table
          await insert(
            `INSERT INTO documents (title, doc_type, content, related_task_id)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [
              `Test Document: ${taskRow.title}`,
              'test_doc',
              JSON.stringify(testDoc, null, 2),
              resolvedTaskId,
            ],
          );

          // Post test document as attachment on Feishu task
          const feishuTaskRow = await queryOne<any>(
            'SELECT feishu_task_id FROM tasks WHERE id = $1',
            [resolvedTaskId],
          );
          if (feishuTaskRow?.feishu_task_id && testDoc.testCases) {
            // Format test doc as markdown
            const mdContent = testDoc.testCases.map((tc: any, i: number) => {
              const steps = tc.steps?.map((s: any) => `  ${s.order}. ${s.action}`).join('\n') || '';
              return `## 测试用例 ${i + 1}: ${tc.title}\n- 类型: ${tc.type}\n- 前置条件: ${tc.preconditions?.join(', ') || '无'}\n- 步骤:\n${steps}\n- 预期结果: ${tc.expectedResult}`;
            }).join('\n\n');

            const fullContent = `# 测试文档: ${taskRow.title}\n\n生成时间: ${new Date().toISOString()}\n\n${mdContent}`;

            try {
              const { Readable } = await import('stream');
              const buffer = Buffer.from(fullContent, 'utf-8');
              const stream = Readable.from(buffer);
              (stream as any).name = `test_doc_${task_id}.md`;

              await feishuClient.task.v2.attachment.upload({
                data: {
                  resource_type: 'task',
                  resource_id: feishuTaskRow.feishu_task_id,
                  file: stream,
                },
              });
            } catch (feishuErr) {
              const errMsg = feishuErr instanceof Error ? feishuErr.message : String(feishuErr);
              console.error(`[generate_test_doc] Feishu attachment upload failed: ${errMsg}`);
            }
          }

          // Advance to QAPending
          const { TaskManager } = await import('../services/taskManager.js');
          const taskManager = new TaskManager({ feishuClient });
          try {
            await taskManager.updateTaskState(resolvedTaskId, 'QAPending', 'Test document generated');
          } catch {
            // May already be in QAPending
          }

          const testCaseCount = testDoc.testCases?.length || 0;
          return `📄 测试文档已生成\n任务: ${task_id}\n测试用例数: ${testCaseCount}\n状态已推进到: QAPending\n\nQA 可以开始测试了。`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `❌ 生成测试文档失败: ${msg}`;
        }
      },
    }),

    // Tool 9: Submit QA feedback (one-stop: save feedback + advance state)
    new DynamicStructuredTool({
      name: 'submit_qa_feedback',
      description: `Submit QA test results for a task. This saves the feedback to qa_feedbacks table AND automatically advances the task state. Do NOT call advance_task separately after this.
- result "passed": advances QAPending → QAPassed → Completed
- result "failed": advances QAPending → QAFailed → InDevelopment
- If the user provides updated requirements or a new description when reporting failure, pass it as "updated_description" — it will be saved and synced to Feishu automatically.`,
      schema: z.object({
        task_id: z.string().describe('The task ID (UUID) or display_id (e.g. F-000001)'),
        result: z.enum(['passed', 'failed']).describe('QA test result'),
        failure_type: z.enum(['implementation_error', 'requirement_error']).optional().describe('Type of failure (required if result is "failed")'),
        details: z.string().optional().describe('Detailed feedback: what failed, why, which test cases'),
        updated_description: z.string().optional().describe('Updated task description reflecting the corrected requirements. Provide this when the user explains what needs to change after QA failure.'),
      }),
      func: async ({ task_id, result, failure_type, details, updated_description }) => {
        try {
          const { queryOne, insert } = await import('../utils/db.js');

          let resolvedTaskId = task_id;
          if (/^[FB]-\d{6}$/.test(task_id)) {
            const row = await queryOne<any>('SELECT id FROM tasks WHERE display_id = $1', [task_id]);
            if (!row) return `❌ 任务不存在: ${task_id}`;
            resolvedTaskId = row.id;
          }

          // Check task is in QAPending state
          const stateRow = await queryOne<any>('SELECT state FROM tasks WHERE id = $1', [resolvedTaskId]);
          if (stateRow?.state !== 'QAPending') {
            return `❌ 任务当前不在 QA 阶段（当前状态: ${stateRow?.state}）。只有 QAPending 状态的任务才能提交 QA 反馈。如果要修改任务内容，请使用 update_task。`;
          }

          // Save QA feedback to database
          await insert(
            `INSERT INTO qa_feedbacks (task_id, result, failure_type, details, reported_by, reported_at)
             VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id`,
            [
              resolvedTaskId,
              result,
              failure_type || null,
              details || null,
              'agent',
            ],
          );

          // Advance state based on result
          const { TaskManager } = await import('../services/taskManager.js');
          const taskManager = new TaskManager({ feishuClient });

          if (result === 'passed') {
            await taskManager.updateTaskState(resolvedTaskId, 'QAPassed', 'QA passed');
            await taskManager.updateTaskState(resolvedTaskId, 'Completed', 'QA passed — task completed');
            await syncDescriptionToFeishu(resolvedTaskId, `QA 通过，任务完成`, feishuClient);
            return `✅ QA 通过！任务已完成\n任务: ${task_id}\n状态: Completed`;
          } else {
            // Failed: go through QAFailed, always back to InDevelopment
            await taskManager.updateTaskState(resolvedTaskId, 'QAFailed', details || 'QA failed');
            await taskManager.updateTaskState(resolvedTaskId, 'InDevelopment', 'QA failed — back to development');

            // If updated description provided, save it and use it as the history reason
            const failureReason = `QA 失败（${failure_type === 'requirement_error' ? '需求问题' : '实现问题'}）: ${details || '未说明'}`;
            if (updated_description) {
              await taskManager.updateTaskDescription(resolvedTaskId, updated_description, failureReason);
              // syncDescriptionToFeishu will pick up the new description + history
              await syncDescriptionToFeishu(resolvedTaskId, '', feishuClient);
            } else {
              await syncDescriptionToFeishu(resolvedTaskId, failureReason, feishuClient);
            }

            return `❌ QA 失败\n任务: ${task_id}\n状态: InDevelopment（需要继续开发）\n类型: ${failure_type || 'implementation_error'}\n原因: ${details || '未说明'}${updated_description ? '\n✏️ 描述已更新' : ''}`;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `❌ 提交 QA 反馈失败: ${msg}`;
        }
      },
    }),
    // Tool 10: Diff task against Feishu and let LLM apply changes via proper tools
    new DynamicStructuredTool({
      name: 'sync_task',
      description: `Compare a task's current state in Feishu with the local database and return the differences.
Call this when the user says they manually changed something in Feishu (e.g. "I updated the due date in Feishu, sync it").

This tool is READ-ONLY — it only reports what changed. After calling this tool, YOU must apply the changes using the appropriate tools:
- title or description changed → call update_task
- due_date changed → call update_task
- assignee changed → call assign_task

This ensures history, Feishu sync, and state machine all work correctly.`,
      schema: z.object({
        task_id: z.string().describe('The task ID (UUID) or display_id (e.g. F-000001) to check'),
      }),
      func: async ({ task_id }) => {
        try {
          const { FeishuSyncService } = await import('../services/feishuSync.js');
          const syncService = new FeishuSyncService({ feishuClient });

          const result = await syncService.diff(task_id);

          if (!result) {
            return `⚠️ 任务 ${task_id} 不存在或没有关联飞书任务，无法对比。`;
          }

          if (result.diffs.length === 0) {
            return `✅ 任务 ${task_id} 飞书与本地数据一致，无变更。`;
          }

          const fieldLabels: Record<string, string> = {
            title: '标题',
            description: '描述',
            due_date: '截止日期',
            assignee_id: '负责人',
          };

          const diffLines = result.diffs.map((d) => {
            const label = fieldLabels[d.field] || d.field;
            return `- ${label}: 本地="${d.localValue ?? '空'}" → 飞书="${d.feishuValue ?? '空'}"`;
          }).join('\n');

          return `检测到以下变更（任务 ${task_id}）：\n${diffLines}\n\n请根据以上变更调用对应工具更新本地数据。`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `❌ 同步对比失败: ${msg}`;
        }
      },
    }),
  ];
}
