/**
 * Code Verifier service.
 *
 * Verifies code changes against a task's description and acceptance criteria
 * using LLM structured output. Produces a VerificationReport with a match
 * score, matched/unmatched criteria, discrepancies, and recommendations.
 *
 * After verification the service advances the task workflow:
 *   - passed    → VerificationPassed
 *   - failed    → VerificationFailed
 *   - ambiguous → VerificationFailed (with a recommendation to clarify requirements)
 *
 * The report is persisted to the `verification_reports` table.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 */

import { initChatModel } from 'langchain/chat_models/universal';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { z } from 'zod/v3';
import { getConfig } from '../config/index.js';
import { AppError, LlmErrorCodes, ValidationErrorCodes, BusinessErrorCodes } from '../utils/errors.js';
import { withRetry } from '../utils/retry.js';
import { insert, queryOne } from '../utils/db.js';
import { advanceWorkflow } from '../workflow/workflowEngine.js';
import type { VerificationReport, CodeContext, StoredVerificationReport } from '../models/verification.js';
import type { WorkflowEvent } from '../models/workflow.js';

// ---------------------------------------------------------------------------
// Zod schemas for structured LLM output
// ---------------------------------------------------------------------------

const discrepancySchema = z.object({
  criterion: z.string().describe('The acceptance criterion that was not met'),
  expected: z.string().describe('What the criterion required'),
  actual: z.string().describe('What the code actually does or omits'),
  severity: z.enum(['critical', 'major', 'minor']).describe('Severity of the discrepancy'),
});

const verificationResultSchema = z.object({
  status: z
    .enum(['passed', 'failed', 'ambiguous'])
    .describe(
      'Overall verification status: passed if implementation matches all criteria, ' +
      'failed if it does not, ambiguous if requirements are unclear',
    ),
  matchScore: z
    .number()
    .min(0)
    .max(100)
    .describe('Overall match score from 0 (no match) to 100 (perfect match)'),
  matchedCriteria: z
    .array(z.string())
    .describe('List of acceptance criteria that are satisfied by the code changes'),
  unmatchedCriteria: z
    .array(z.string())
    .describe('List of acceptance criteria that are NOT satisfied by the code changes'),
  discrepancies: z
    .array(discrepancySchema)
    .describe('Detailed list of discrepancies between code and criteria'),
  recommendations: z
    .array(z.string())
    .describe('Actionable recommendations to address discrepancies or clarify requirements'),
});

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const VERIFICATION_SYSTEM_PROMPT = `You are an expert code reviewer. Your job is to verify whether a set of code changes correctly implements a task's requirements.

You will be given:
1. A task description explaining what needs to be implemented
2. A list of acceptance criteria that must be satisfied
3. The code changes (as a diff or code snippet)
4. An optional commit message

Your job is to:
- Evaluate each acceptance criterion against the code changes
- Assign a match score from 0 to 100
- List which criteria are met and which are not
- Identify specific discrepancies with severity levels
- Provide actionable recommendations

Status rules:
- "passed": All acceptance criteria are met (matchScore >= 80)
- "failed": One or more acceptance criteria are not met
- "ambiguous": The requirements are unclear or contradictory, making it impossible to determine if the implementation is correct

Be thorough but fair. If the code partially satisfies a criterion, note it in discrepancies with "minor" severity.
If requirements are vague or contradictory, set status to "ambiguous" and explain in recommendations.`;

// ---------------------------------------------------------------------------
// Database row types
// ---------------------------------------------------------------------------

interface VerificationReportRow extends Record<string, unknown> {
  id: string;
  task_id: string;
  report: VerificationReport;
  code_context: CodeContext;
  created_at: Date;
}

interface TaskRow extends Record<string, unknown> {
  id: string;
  state: string;
}

// ---------------------------------------------------------------------------
// CodeVerifier Options
// ---------------------------------------------------------------------------

/** Options for creating a CodeVerifier instance. */
export interface CodeVerifierOptions {
  /** Override the LLM instance (useful for testing). */
  llm?: BaseChatModel;
  /** Override retry sleep function (useful for testing). */
  retrySleep?: (ms: number) => Promise<void>;
  /** Skip workflow advancement after verification (useful for testing). */
  skipWorkflowAdvance?: boolean;
}

// ---------------------------------------------------------------------------
// CodeVerifier
// ---------------------------------------------------------------------------

/**
 * Verifies code changes against task acceptance criteria using LLM.
 *
 * Produces a VerificationReport, persists it to the database, and
 * advances the task workflow based on the verification outcome.
 */
export class CodeVerifier {
  private llm: BaseChatModel | null = null;
  private readonly retrySleep?: (ms: number) => Promise<void>;
  private readonly skipWorkflowAdvance: boolean;

  constructor(options: CodeVerifierOptions = {}) {
    if (options.llm) {
      this.llm = options.llm;
    }
    this.retrySleep = options.retrySleep;
    this.skipWorkflowAdvance = options.skipWorkflowAdvance ?? false;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Verify code changes against a task's description and acceptance criteria.
   *
   * Steps:
   * 1. Validate inputs
   * 2. Fetch the task from the database to confirm it exists
   * 3. Call LLM with structured output to produce verification analysis
   * 4. Build and persist the VerificationReport
   * 5. Advance the task workflow based on the result
   *
   * @param taskId      - The ID of the task being verified.
   * @param codeContext - The code context including changes and criteria.
   * @returns The generated VerificationReport.
   * @throws AppError on validation failure, task not found, or LLM error.
   */
  async verify(taskId: string, codeContext: CodeContext): Promise<VerificationReport> {
    this.validateInputs(taskId, codeContext);

    // Confirm the task exists in the database
    await this.ensureTaskExists(taskId);

    // Call LLM to perform the verification analysis
    const llm = await this.getLlm();
    let llmResult: z.infer<typeof verificationResultSchema>;

    try {
      llmResult = await this.invokeLlmVerification(llm, codeContext);
    } catch (err) {
      // If token limit exceeded, generate an ambiguous report and proceed to QA
      const appError = AppError.from(err);
      if (appError.code === LlmErrorCodes.TOKEN_LIMIT) {
        llmResult = {
          status: 'ambiguous',
          matchScore: 0,
          matchedCriteria: [],
          unmatchedCriteria: codeContext.acceptanceCriteria,
          discrepancies: [],
          recommendations: [
            'Code diff is too large for AI analysis. Please have QA review the changes manually.',
            'Consider breaking the PR into smaller, focused changes for future AI verification.',
          ],
        };
      } else {
        throw err;
      }
    }

    // Build the VerificationReport
    const report: VerificationReport = {
      taskId,
      status: llmResult.status,
      matchScore: llmResult.matchScore,
      analysis: {
        matchedCriteria: llmResult.matchedCriteria,
        unmatchedCriteria: llmResult.unmatchedCriteria,
        discrepancies: llmResult.discrepancies,
        recommendations: llmResult.recommendations,
      },
      generatedAt: new Date().toISOString(),
    };

    // Persist the report to the database
    await this.persistReport(taskId, report, codeContext);

    // Workflow advancement removed — state machine no longer has Verification states.
    // The verify_code tool is now report-only; state advancement is handled by advance_task.

    return report;
  }

  /**
   * Retrieve the most recent verification report for a task.
   *
   * @param taskId - The task ID.
   * @returns The stored report, or null if none exists.
   */
  async getLatestReport(taskId: string): Promise<StoredVerificationReport | null> {
    const row = await queryOne<VerificationReportRow>(
      `SELECT id, task_id, report, code_context, created_at
         FROM verification_reports
        WHERE task_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [taskId],
    );

    if (!row) return null;

    return {
      id: row.id,
      taskId: row.task_id,
      report: row.report,
      codeContext: row.code_context,
      createdAt: row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
    };
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  /**
   * Validate that taskId and codeContext are non-empty and well-formed.
   */
  private validateInputs(taskId: string, codeContext: CodeContext): void {
    if (!taskId || taskId.trim() === '') {
      throw AppError.validation(
        ValidationErrorCodes.MISSING_FIELD,
        'Task ID is required for code verification',
        { taskId },
        'Provide a valid task ID.',
      );
    }

    if (!codeContext.taskDescription || codeContext.taskDescription.trim() === '') {
      throw AppError.validation(
        ValidationErrorCodes.EMPTY_CONTENT,
        'Task description is required for code verification',
        { taskId },
        'Provide the task description in the code context.',
      );
    }

    if (!codeContext.codeChanges || codeContext.codeChanges.trim() === '') {
      throw AppError.validation(
        ValidationErrorCodes.EMPTY_CONTENT,
        'Code changes are required for code verification',
        { taskId },
        'Provide the code changes (diff or snippet) in the code context.',
      );
    }

    if (!codeContext.acceptanceCriteria || codeContext.acceptanceCriteria.length === 0) {
      throw AppError.validation(
        ValidationErrorCodes.MISSING_FIELD,
        'Acceptance criteria are required for code verification',
        { taskId },
        'Provide at least one acceptance criterion in the code context.',
      );
    }
  }

  /**
   * Confirm the task exists in the database.
   *
   * @throws AppError with BUSINESS_TASK_NOT_FOUND if the task does not exist.
   */
  private async ensureTaskExists(taskId: string): Promise<void> {
    const row = await queryOne<TaskRow>(
      'SELECT id, state FROM tasks WHERE id = $1',
      [taskId],
    );

    if (!row) {
      throw AppError.businessLogic(
        BusinessErrorCodes.TASK_NOT_FOUND,
        `Task ${taskId} not found`,
        { taskId },
        'Verify the task ID is correct.',
      );
    }
  }

  /**
   * Call the LLM with structured output to perform the verification analysis.
   */
  private async invokeLlmVerification(
    llm: BaseChatModel,
    codeContext: CodeContext,
  ): Promise<z.infer<typeof verificationResultSchema>> {
    const userMessage = this.buildVerificationPrompt(codeContext);

    const result = await withRetry(
      async () => {
        try {
          const structuredLlm = (llm as any).withStructuredOutput(verificationResultSchema);
          const response = await structuredLlm.invoke([
            new SystemMessage(VERIFICATION_SYSTEM_PROMPT),
            new HumanMessage(userMessage),
          ]);
          return response as z.infer<typeof verificationResultSchema>;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);

          if (message.includes('token') || message.includes('context length')) {
            throw AppError.llmService(
              LlmErrorCodes.TOKEN_LIMIT,
              `LLM token limit exceeded during code verification: ${message}`,
              err,
              'Try providing a shorter code diff or splitting the verification into smaller parts.',
            );
          }

          throw AppError.llmService(
            LlmErrorCodes.SERVICE_UNAVAILABLE,
            `LLM service failed during code verification: ${message}`,
            err,
            'Check LLM service availability and API key.',
          );
        }
      },
      { sleep: this.retrySleep },
    );

    return result;
  }

  /**
   * Build the user-facing verification prompt from the code context.
   */
  private buildVerificationPrompt(codeContext: CodeContext): string {
    const criteriaList = codeContext.acceptanceCriteria
      .map((c, i) => `${i + 1}. ${c}`)
      .join('\n');

    const commitSection = codeContext.commitMessage
      ? `\n## Commit Message\n${codeContext.commitMessage}\n`
      : '';

    return (
      `## Task Description\n${codeContext.taskDescription}\n\n` +
      `## Acceptance Criteria\n${criteriaList}\n` +
      commitSection +
      `\n## Code Changes\n\`\`\`\n${codeContext.codeChanges}\n\`\`\`\n\n` +
      `Please verify whether the code changes correctly implement all acceptance criteria.`
    );
  }

  /**
   * Persist the verification report to the `verification_reports` table.
   */
  private async persistReport(
    taskId: string,
    report: VerificationReport,
    codeContext: CodeContext,
  ): Promise<void> {
    await insert<VerificationReportRow>(
      `INSERT INTO verification_reports (task_id, report, code_context)
       VALUES ($1, $2, $3)
       RETURNING id, task_id, report, code_context, created_at`,
      [taskId, JSON.stringify(report), JSON.stringify(codeContext)],
    );
  }

  /**
   * Advance the task workflow based on the verification outcome.
   *
   * Regardless of the AI verification result, the task always advances to
   * VerificationPassed so it can proceed to QA. The matchScore, aiStatus,
   * and any discrepancies are included in the event payload so QA has
   * full context from the AI review. Humans make the final call.
   */
  private async advanceTaskWorkflow(
    taskId: string,
    report: VerificationReport,
  ): Promise<void> {
    // Always pass to QA — let humans make the final call.
    // The AI score and discrepancies are surfaced in the payload for QA reference.
    const reason =
      report.status === 'ambiguous'
        ? `AI verification inconclusive (score ${report.matchScore}/100). Requirements may need clarification. Proceeding to QA for human review.`
        : report.status === 'failed'
          ? `AI verification flagged issues (score ${report.matchScore}/100). Proceeding to QA for human review.`
          : `AI verification passed (score ${report.matchScore}/100).`;

    const event: WorkflowEvent = {
      type: 'verification_result',
      payload: {
        passed: true, // always advance to QA
        reason,
        matchScore: report.matchScore,
        aiStatus: report.status, // 'passed' | 'failed' | 'ambiguous'
        discrepancies: report.analysis.discrepancies,
        recommendations: report.analysis.recommendations,
      },
      actor: 'code_verifier',
      timestamp: new Date().toISOString(),
    };

    await advanceWorkflow(taskId, event);
  }

  /**
   * Get or initialize the LLM instance.
   */
  private async getLlm(): Promise<BaseChatModel> {
    if (this.llm) return this.llm;

    const config = getConfig();
    const { provider, apiKey, model, maxTokens, timeoutMs } = config.llm;

    const providerMap: Record<string, string> = {
      openai: 'openai',
      anthropic: 'anthropic',
      claude: 'anthropic',
    };

    const langchainProvider = providerMap[provider.toLowerCase()];
    if (!langchainProvider) {
      throw AppError.validation(
        'INVALID_LLM_PROVIDER',
        `Unsupported LLM provider: "${provider}". Supported providers: openai, anthropic`,
        { provider },
        'Set LLM_PROVIDER to "openai" or "anthropic" in your environment.',
      );
    }

    try {
      const llm = await initChatModel(model, {
        modelProvider: langchainProvider,
        apiKey,
        maxTokens,
        timeout: timeoutMs,
      });
      this.llm = llm as unknown as BaseChatModel;
      return this.llm;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw AppError.llmService(
        LlmErrorCodes.SERVICE_UNAVAILABLE,
        `Failed to initialize LLM for code verification: ${message}`,
        { provider, model, error: err },
        'Check your LLM_API_KEY and network connectivity.',
      );
    }
  }
}
