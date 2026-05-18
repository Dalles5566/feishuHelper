/**
 * Meeting Analyzer service.
 *
 * Analyzes meeting minutes content using LLM to produce structured output
 * including summaries, action items, decisions, and discussion points.
 * Handles long content via chunking and merging to avoid token limits.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5
 */

import { initChatModel } from 'langchain/chat_models/universal';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { z } from 'zod/v3';
import { getConfig } from '../config/index.js';
import { AppError, LlmErrorCodes, ValidationErrorCodes } from '../utils/errors.js';
import { withRetry } from '../utils/retry.js';
import type {
  MeetingAnalysis,
  ActionItem,
  MeetingSummary,
} from '../models/meeting.js';

// ---------------------------------------------------------------------------
// Zod schemas for structured output parsing
// ---------------------------------------------------------------------------

const meetingSummarySchema = z.object({
  title: z.string().describe('Title of the meeting'),
  date: z.string().describe('Date of the meeting in ISO format or as mentioned'),
  participants: z.array(z.string()).describe('List of meeting participants'),
  keyPoints: z.array(z.string()).describe('Key points discussed in the meeting'),
  overallSummary: z.string().describe('A concise overall summary of the meeting'),
});

const actionItemSchema = z.object({
  id: z.string().describe('Unique identifier for the action item (e.g. AI-1, AI-2)'),
  description: z.string().describe('Clear description of what needs to be done'),
  context: z.string().describe('Additional context from the meeting discussion'),
  priority: z.enum(['high', 'medium', 'low']).describe('Priority level of the action item'),
  suggestedAssignee: z
    .string()
    .optional()
    .describe('Suggested person to handle this item based on meeting discussion'),
  dependencies: z
    .array(z.string())
    .describe('IDs of other action items this one depends on'),
});

const decisionSchema = z.object({
  id: z.string().describe('Unique identifier for the decision (e.g. D-1, D-2)'),
  description: z.string().describe('What was decided'),
  rationale: z.string().optional().describe('Why this decision was made'),
  madeBy: z.string().optional().describe('Who made or proposed the decision'),
});

const discussionPointSchema = z.object({
  id: z.string().describe('Unique identifier for the discussion point (e.g. DP-1, DP-2)'),
  topic: z.string().describe('Topic of discussion'),
  summary: z.string().describe('Summary of what was discussed'),
  outcome: z.string().optional().describe('Outcome or conclusion of the discussion'),
});

const meetingAnalysisSchema = z.object({
  summary: meetingSummarySchema,
  actionItems: z.array(actionItemSchema),
  decisions: z.array(decisionSchema),
  discussionPoints: z.array(discussionPointSchema),
});

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const ANALYSIS_SYSTEM_PROMPT = `You are an expert meeting minutes analyzer. Your job is to analyze meeting content and extract structured information.

You MUST produce a complete, structured analysis including:
1. A summary with title, date, participants, key points, and overall summary
2. Action items with clear descriptions, priorities, suggested assignees, dependencies, and acceptance criteria
3. Decisions made during the meeting with rationale
4. Discussion points with topics, summaries, and outcomes

Rules:
- Extract ALL action items mentioned, even implicit ones
- Assign priorities based on urgency and importance discussed
- Identify dependencies between action items
- Write clear acceptance criteria for each action item
- If information is not explicitly stated, infer from context or mark as unknown
- Use the language of the meeting content for descriptions
- Generate unique IDs for each item (AI-1, AI-2 for action items; D-1, D-2 for decisions; DP-1, DP-2 for discussion points)`;

const CHUNK_ANALYSIS_SYSTEM_PROMPT = `You are an expert meeting minutes analyzer. You are analyzing a SEGMENT of a longer meeting. Extract all relevant information from this segment.

Extract:
1. Any action items mentioned (with descriptions, priorities, suggested assignees, dependencies, acceptance criteria)
2. Any decisions made
3. Any discussion points

Rules:
- Extract ALL items from this segment
- Use the language of the content for descriptions
- Generate unique IDs with a segment prefix (e.g. S1-AI-1, S1-D-1)
- If this segment references items from other parts of the meeting, note the reference in the context field`;

const MERGE_SYSTEM_PROMPT = `You are an expert meeting minutes analyzer. You have received partial analyses from different segments of a long meeting. Your job is to merge them into a single coherent analysis.

Rules:
- Combine all action items, removing exact duplicates
- Merge related discussion points that span segments
- Consolidate decisions, keeping the most complete version
- Re-assign sequential IDs (AI-1, AI-2, D-1, D-2, DP-1, DP-2)
- Resolve any cross-segment dependencies
- Create a unified summary that covers the entire meeting
- Preserve all substantive content without truncation`;

const SUMMARY_SYSTEM_PROMPT = `You are an expert meeting minutes analyzer. Generate a concise but comprehensive summary of the meeting content.

Include:
- Meeting title (infer from content if not explicit)
- Date (infer from content if not explicit, use "unknown" if not determinable)
- List of participants mentioned
- Key points discussed
- An overall summary paragraph

Use the language of the meeting content for the summary.`;

const ACTION_ITEMS_SYSTEM_PROMPT = `You are an expert meeting minutes analyzer. Extract ALL action items from the meeting content.

For each action item, provide:
- A clear description of what needs to be done
- Context from the meeting discussion
- Priority (high/medium/low) based on urgency and importance
- Suggested assignee (if mentioned or inferable)
- Dependencies on other action items
- Acceptance criteria (what must be true for this to be considered done)

Rules:
- Extract both explicit and implicit action items
- Assign priorities based on discussion tone and urgency
- Identify dependencies between items
- Write actionable acceptance criteria
- Use the language of the meeting content`;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Default chunk size in characters for splitting long content.
 * Approximately 3000 tokens assuming ~4 chars per token.
 */
const DEFAULT_CHUNK_SIZE = 12000;

/**
 * Overlap between chunks to preserve context at boundaries.
 */
const DEFAULT_CHUNK_OVERLAP = 1000;

// ---------------------------------------------------------------------------
// MeetingAnalyzer Options
// ---------------------------------------------------------------------------

/** Options for creating a MeetingAnalyzer instance. */
export interface MeetingAnalyzerOptions {
  /** Override the LLM instance (useful for testing). */
  llm?: BaseChatModel;
  /** Override chunk size for long content splitting. */
  chunkSize?: number;
  /** Override chunk overlap size. */
  chunkOverlap?: number;
  /** Override retry sleep function (useful for testing). */
  retrySleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// MeetingAnalyzer
// ---------------------------------------------------------------------------

/**
 * Analyzes meeting minutes content using LLM to produce structured output.
 *
 * Supports:
 * - Full meeting analysis (summary + action items + decisions + discussion points)
 * - Action item extraction only
 * - Summary generation only
 * - Long content handling via chunking and merging
 */
export class MeetingAnalyzer {
  private llm: BaseChatModel | null = null;
  private readonly chunkSize: number;
  private readonly chunkOverlap: number;
  private readonly retrySleep?: (ms: number) => Promise<void>;

  constructor(options: MeetingAnalyzerOptions = {}) {
    if (options.llm) {
      this.llm = options.llm;
    }
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.chunkOverlap = options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
    this.retrySleep = options.retrySleep;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Analyze meeting minutes content and produce a full structured analysis.
   *
   * Handles long content by splitting into chunks, analyzing each chunk,
   * and merging the results into a coherent whole.
   *
   * @param content - The meeting minutes text content.
   * @returns Full structured meeting analysis.
   * @throws AppError with code VALIDATION_EMPTY_CONTENT if content is empty.
   * @throws AppError with LLM error codes if LLM call fails.
   */
  async analyze(content: string): Promise<MeetingAnalysis> {
    this.validateContent(content);

    const llm = await this.getLlm();

    if (this.isLongContent(content)) {
      return this.analyzeChunked(content, llm);
    }

    return this.analyzeSingle(content, llm);
  }

  /**
   * Extract action items from meeting minutes content.
   *
   * @param content - The meeting minutes text content.
   * @returns Array of extracted action items.
   * @throws AppError with code VALIDATION_EMPTY_CONTENT if content is empty.
   * @throws AppError with LLM error codes if LLM call fails.
   */
  async extractActionItems(content: string): Promise<ActionItem[]> {
    this.validateContent(content);

    const llm = await this.getLlm();

    if (this.isLongContent(content)) {
      const analysis = await this.analyzeChunked(content, llm);
      return analysis.actionItems;
    }

    const result = await this.invokeLlmWithSchema(
      llm,
      ACTION_ITEMS_SYSTEM_PROMPT,
      `Extract all action items from the following meeting content:\n\n${content}`,
      z.object({ actionItems: z.array(actionItemSchema) }),
    );

    return result.actionItems as ActionItem[];
  }

  /**
   * Generate a summary of meeting minutes content.
   *
   * @param content - The meeting minutes text content.
   * @returns Structured meeting summary.
   * @throws AppError with code VALIDATION_EMPTY_CONTENT if content is empty.
   * @throws AppError with LLM error codes if LLM call fails.
   */
  async generateSummary(content: string): Promise<MeetingSummary> {
    this.validateContent(content);

    const llm = await this.getLlm();

    if (this.isLongContent(content)) {
      const analysis = await this.analyzeChunked(content, llm);
      return analysis.summary;
    }

    const result = await this.invokeLlmWithSchema(
      llm,
      SUMMARY_SYSTEM_PROMPT,
      `Generate a summary of the following meeting content:\n\n${content}`,
      meetingSummarySchema,
    );

    return result as MeetingSummary;
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  /**
   * Validate that content is non-empty.
   */
  private validateContent(content: string): void {
    if (!content || content.trim().length === 0) {
      throw AppError.validation(
        ValidationErrorCodes.EMPTY_CONTENT,
        'Meeting minutes content is empty. No content is available for analysis.',
        { contentLength: content?.length ?? 0 },
        'Please provide meeting minutes content for analysis.',
      );
    }
  }

  /**
   * Determine if content exceeds the chunk size threshold.
   */
  private isLongContent(content: string): boolean {
    return content.length > this.chunkSize;
  }

  /**
   * Analyze a single (short) piece of content in one LLM call.
   */
  private async analyzeSingle(content: string, llm: BaseChatModel): Promise<MeetingAnalysis> {
    const result = await this.invokeLlmWithSchema(
      llm,
      ANALYSIS_SYSTEM_PROMPT,
      `Analyze the following meeting minutes and extract structured information:\n\n${content}`,
      meetingAnalysisSchema,
    );

    return result as MeetingAnalysis;
  }

  /**
   * Analyze long content by splitting into chunks, analyzing each, and merging.
   */
  private async analyzeChunked(content: string, llm: BaseChatModel): Promise<MeetingAnalysis> {
    const chunks = this.splitContent(content);

    // Analyze each chunk
    const chunkResults: MeetingAnalysis[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkPrompt = `This is segment ${i + 1} of ${chunks.length} from a meeting.\n\nAnalyze this segment:\n\n${chunks[i]}`;

      const result = await this.invokeLlmWithSchema(
        llm,
        CHUNK_ANALYSIS_SYSTEM_PROMPT,
        chunkPrompt,
        meetingAnalysisSchema,
      );

      chunkResults.push(result as MeetingAnalysis);
    }

    // If only one chunk, return directly
    if (chunkResults.length === 1) {
      return chunkResults[0];
    }

    // Merge chunk results
    return this.mergeChunkResults(chunkResults, llm);
  }

  /**
   * Merge multiple chunk analysis results into a single coherent analysis.
   */
  private async mergeChunkResults(
    chunkResults: MeetingAnalysis[],
    llm: BaseChatModel,
  ): Promise<MeetingAnalysis> {
    const mergeInput = JSON.stringify(chunkResults, null, 2);

    const result = await this.invokeLlmWithSchema(
      llm,
      MERGE_SYSTEM_PROMPT,
      `Merge the following partial meeting analyses into a single coherent analysis:\n\n${mergeInput}`,
      meetingAnalysisSchema,
    );

    return result as MeetingAnalysis;
  }

  /**
   * Split content into overlapping chunks for processing.
   */
  private splitContent(content: string): string[] {
    const chunks: string[] = [];
    let start = 0;

    while (start < content.length) {
      const end = Math.min(start + this.chunkSize, content.length);
      chunks.push(content.slice(start, end));

      // Move start forward, accounting for overlap
      start = end - this.chunkOverlap;

      // Prevent infinite loop if overlap >= chunkSize
      if (start >= content.length || end === content.length) {
        break;
      }
    }

    return chunks;
  }

  /**
   * Invoke the LLM with structured output parsing using withStructuredOutput.
   */
  private async invokeLlmWithSchema<T extends z.ZodType>(
    llm: BaseChatModel,
    systemPrompt: string,
    userMessage: string,
    schema: T,
  ): Promise<z.infer<T>> {
    const result = await withRetry(
      async () => {
        try {
          const structuredLlm = (llm as any).withStructuredOutput(schema);
          const response = await structuredLlm.invoke([
            new SystemMessage(systemPrompt),
            new HumanMessage(userMessage),
          ]);
          return response as z.infer<T>;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);

          if (message.includes('token') || message.includes('context length')) {
            throw AppError.llmService(
              LlmErrorCodes.TOKEN_LIMIT,
              `LLM token limit exceeded during meeting analysis: ${message}`,
              err,
              'Try providing shorter meeting content or the system will chunk it automatically.',
            );
          }

          throw AppError.llmService(
            LlmErrorCodes.SERVICE_UNAVAILABLE,
            `LLM service failed during meeting analysis: ${message}`,
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
        `Failed to initialize LLM for meeting analysis: ${message}`,
        { provider, model, error: err },
        'Check your LLM_API_KEY and network connectivity.',
      );
    }
  }
}
