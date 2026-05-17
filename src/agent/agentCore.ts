/**
 * AI Agent Core module.
 *
 * Implements the central Agent using LangChain.js with tool-calling capabilities.
 * Supports multiple LLM providers (OpenAI GPT-4, Anthropic Claude) based on config.
 * Registers Feishu MCP tools and manages conversation context per session.
 *
 * Requirements: 1.2, 2.1
 */

import { initChatModel } from 'langchain/chat_models/universal';
import { DynamicStructuredTool } from '@langchain/core/tools';
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  BaseMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { getConfig } from '../config/index.js';
import { AppError, LlmErrorCodes } from '../utils/errors.js';
import { withRetry } from '../utils/retry.js';
import { registerTools } from './agentCoreToolBoxRegister.js';
import type { TaskState } from '../models/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input to the Agent for processing. */
export interface AgentInput {
  sessionId: string;
  userId: string;
  messageType: 'text' | 'file' | 'command' | 'callback';
  content: string;
  metadata?: Record<string, unknown>;
}

/** Output produced by the Agent after processing input. */
export interface AgentOutput {
  actions: AgentAction[];
  response?: string;
  nextState?: TaskState;
}

/** A single action the Agent decides to take. */
export type AgentAction =
  | { type: 'send_message'; chatId: string; content: string }
  | { type: 'create_task'; task: Record<string, unknown> }
  | { type: 'update_task'; taskId: string; updates: Record<string, unknown> }
  | { type: 'generate_document'; docType: string; context: Record<string, unknown> }
  | { type: 'verify_code'; taskId: string; codeRef: string }
  | { type: 'tool_call'; toolName: string; params: Record<string, unknown>; result: string };

/** Conversation context for a session. */
export interface ConversationContext {
  sessionId: string;
  messages: BaseMessage[];
  createdAt: string;
  lastActiveAt: string;
}

/** Options for creating an AgentCore instance. */
export interface AgentCoreOptions {
  /** Override the LLM instance (useful for testing). */
  llm?: BaseChatModel;
  /** Override the system prompt. */
  systemPrompt?: string;
  /** Maximum number of messages to keep in context per session. */
  maxContextMessages?: number;
  /** Override retry sleep function (useful for testing). */
  retrySleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SYSTEM_PROMPT = `You are Feishu Helper, an AI assistant that automates development workflows via Feishu.

Your core capabilities:
1. **Analyze meeting minutes**: When a user sends meeting content or conversation records, you MUST first call the analyze_meeting tool to get structured analysis results.
2. **Query any data**: Use query_sql to run SELECT queries against the database. You can look up tasks, employees, meetings, assignments — anything.
3. **Create tasks**: After analyzing meeting content, create a task for each action item using create_feishu_task. Also use this tool when the user directly asks to create a task.
4. **Update tasks**: Use update_task to modify task fields. IMPORTANT: Only update fields that the user explicitly asks to change. Do NOT rewrite or "improve" existing content unless specifically requested. Preserve existing data.
   - When updating description, follow this format:
     ## 总概括
     [One-sentence summary reflecting the LATEST state]
     ## 要点
     - [Key point 1 - latest state]
     - [Key point 2 - latest state]
     ## 变更历史
     - [Latest date]: [What changed and why]
     - [Earlier date]: [What changed and why]
   - 总概括 and 要点 always reflect the current/latest state
   - 变更历史 is append-only (newest first), never remove old entries
   - Use query_sql to read the current description first, then modify it preserving the format
5. **Assign tasks**: Use assign_task to assign a task to a developer (requires open_id — look it up via query_sql first). This also syncs to Feishu and auto-advances state to Assigned.
6. **Advance task state**: Use advance_task to push a task through the workflow. Valid events: assigned, confirmed, dev_complete, verification_passed, qa_passed, doc_updated, completed, qa_failed_impl, qa_failed_req, verification_failed.
   - IMPORTANT: If someone says "I'll do it" or "I can work on this", you must FIRST call assign_task (to assign them and sync to Feishu), THEN call advance_task with event "confirmed" to move to InDevelopment.
7. **Verify code & generate test doc**: When a developer says "done" or "finished":
   - Call advance_task("dev_complete") to move to VerificationPending
   - Call verify_code(task_id, code_changes?) to run AI verification
   - Call generate_test_doc(task_id) to create QA test document
   - These three calls should happen in sequence automatically.
7. **Reply in Chinese** unless the user writes in English.

DATABASE CONTEXT:
- The "employees" table maps names to Feishu open_ids. Columns: open_id, name, status (active/on_leave/inactive).
- The "tasks" table stores assignee_id as a Feishu open_id (not a name).
- When the user mentions a person by name, FIRST call lookup_employee to get their open_id, THEN use that open_id in list_tasks or assign_task.
- You have a query_sql tool for any read-only query. Here is the full database schema:
  - employees(id UUID, open_id, name, status, created_at, updated_at)
  - tasks(id UUID, display_id, task_type, title, description, acceptance_criteria JSONB, dependencies JSONB, priority, state, assignee_id, parent_task_id, source_action_item_id, feishu_task_id, retry_count, failure_context, description_history JSONB, created_at, updated_at)
  - meetings(id UUID, title, meeting_date, feishu_doc_id, raw_content, analysis JSONB, created_at)
  - task_meetings(id UUID, task_id, meeting_id, created_at)
  - workflow_logs(id UUID, task_id, from_state, to_state, trigger, actor, reason, metadata JSONB, timestamp)
  - task_assignments(id UUID, task_id, assignee_id, assignee_name, assigned_by, assigned_at, status)
  - verification_reports(id UUID, task_id, report JSONB, code_context JSONB, created_at)
  - qa_feedbacks(id UUID, task_id, result, failure_type, details, test_case_results JSONB, reported_by, reported_at)
  - documents(id UUID, title, doc_type, content, sections JSONB, version, related_task_id, feishu_doc_id, created_at, updated_at)

WORKFLOW for meeting content:
1. Call analyze_meeting with the meeting content — this saves the meeting to DB and returns a meetingId
2. Review the structured results (action items, decisions, summary)
3. For each action item from the analysis, create exactly ONE task using create_feishu_task. Do NOT split action items into sub-tasks. Only create tasks that are explicitly mentioned as action items. Pass the meetingId from step 1 to link the task to the meeting.
4. Reply to the user with a summary of what was created, including all task URLs

When creating tasks, always include:
- A clear, concise title
- A description with context from the meeting
- The due date if mentioned (in YYYY-MM-DD format)
- **IMPORTANT: Always include the task URL link in your reply exactly as returned by the tool. Never omit or paraphrase the URL.**

If the user just chats casually or directly asks to create a single task (not meeting content), skip analyze_meeting and use create_feishu_task directly.

When the user asks about task status, use list_tasks or get_task to look up real data. Never make up task information.`;

const DEFAULT_MAX_CONTEXT_MESSAGES = 50;
const MAX_TOOL_ITERATIONS = 10;

// ---------------------------------------------------------------------------
// AgentCore
// ---------------------------------------------------------------------------

/**
 * Core AI Agent that orchestrates LLM calls and tool usage.
 *
 * Uses LangChain.js to create a tool-calling agent that can:
 * - Process user input and decide on actions
 * - Call Feishu MCP tools to interact with the Feishu platform
 * - Maintain conversation context per session
 * - Support both OpenAI and Anthropic as LLM providers
 */
export class AgentCore {
  private readonly systemPrompt: string;
  private readonly maxContextMessages: number;
  private readonly retrySleep?: (ms: number) => Promise<void>;

  // Session context store (in-memory; can be replaced with Redis for production)
  private readonly sessions: Map<string, ConversationContext> = new Map();

  // LLM instance (lazily initialized)
  private llm: BaseChatModel | null = null;
  private llmInitPromise: Promise<BaseChatModel> | null = null;

  // Registered tools for the agent
  private tools: DynamicStructuredTool[] = [];

  constructor(options: AgentCoreOptions = {}) {
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.maxContextMessages = options.maxContextMessages ?? DEFAULT_MAX_CONTEXT_MESSAGES;
    this.retrySleep = options.retrySleep;

    if (options.llm) {
      this.llm = options.llm;
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Initialize the Agent: set up LLM and register tools.
   * Must be called before processInput.
   */
  async initialize(): Promise<void> {
    await this.initializeLlm();
    // Dynamic import for CJS compatibility
    const { Client } = await import('@larksuiteoapi/node-sdk');
    const config = getConfig();
    const feishuClient = new Client({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
    });
    this.registerFeishuTools(feishuClient);
    console.log(`[AgentCore] Initialized with ${this.tools.length} tools: ${this.tools.map(t => t.name).join(', ')}`);
  }

  /**
   * Process user input and produce agent output with actions.
   *
   * Implements a tool-calling loop: the LLM may request tool calls,
   * which are executed and fed back until the LLM produces a final response.
   */
  async processInput(input: AgentInput): Promise<AgentOutput> {
    console.log(`[AgentCore] processInput called — session: ${input.sessionId}, content: "${input.content.slice(0, 50)}"`);
    const llm = await this.getLlm();
    const context = this.getContext(input.sessionId);

    // Add the user message to context
    const userMessage = new HumanMessage(this.formatInputContent(input));
    context.messages.push(userMessage);

    // Build the messages array for the LLM
    const messages = this.buildMessages(context);

    // Bind tools to the LLM for this invocation
    const llmWithTools = this.tools.length > 0
      ? (llm as any).bindTools(this.tools)
      : llm;

    const actions: AgentAction[] = [];
    let finalResponse: string | undefined;
    let iterations = 0;

    // Tool-calling loop
    let currentMessages = [...messages];

    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;

      console.log(`[AgentCore] Calling LLM (iteration ${iterations})...`);
      const aiMessage = await this.invokeLlm(llmWithTools, currentMessages);
      console.log(`[AgentCore] LLM responded, tool_calls: ${aiMessage.tool_calls?.length ?? 0}`);
      currentMessages.push(aiMessage);

      // Check if the AI wants to call tools
      const toolCalls = aiMessage.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        // No tool calls - this is the final response
        finalResponse = typeof aiMessage.content === 'string'
          ? aiMessage.content
          : Array.isArray(aiMessage.content)
            ? aiMessage.content
                .filter((block: any) => block.type === 'text')
                .map((block: any) => block.text)
                .join('')
            : String(aiMessage.content);
        break;
      }

      // Execute each tool call
      for (const toolCall of toolCalls) {
        console.log(`[AgentCore] Tool call: ${toolCall.name}(${JSON.stringify(toolCall.args ?? {}).slice(0, 200)})`);
        const toolResult = await this.executeTool(toolCall.name, toolCall.args ?? {});
        console.log(`[AgentCore] Tool result: ${toolResult.slice(0, 300)}`);
        actions.push({
          type: 'tool_call',
          toolName: toolCall.name,
          params: toolCall.args ?? {},
          result: toolResult,
        });

        // Add tool result message
        const toolMessage = new ToolMessage({
          content: toolResult,
          tool_call_id: toolCall.id ?? toolCall.name,
        });
        currentMessages.push(toolMessage);
      }
    }

    // Store the AI response in context
    if (finalResponse) {
      context.messages.push(new AIMessage(finalResponse));
    }
    context.lastActiveAt = new Date().toISOString();

    // Trim context if it exceeds the limit
    this.trimContext(context);

    console.log(`[AgentCore] Done — actions: ${actions.length}, response: "${finalResponse?.slice(0, 80) ?? 'none'}"`);

    return {
      actions,
      response: finalResponse,
    };
  }

  /**
   * Execute an MCP tool call directly (bypasses the LLM loop).
   */
  async callTool(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<string> {
    return this.executeTool(toolName, params);
  }

  /**
   * Get or create conversation context for a session.
   */
  getContext(sessionId: string): ConversationContext {
    let context = this.sessions.get(sessionId);
    if (!context) {
      const now = new Date().toISOString();
      context = {
        sessionId,
        messages: [],
        createdAt: now,
        lastActiveAt: now,
      };
      this.sessions.set(sessionId, context);
    }
    return context;
  }

  /**
   * Clear conversation context for a session.
   */
  clearContext(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Get all active session IDs.
   */
  getActiveSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Get the registered tools.
   */
  getRegisteredTools(): DynamicStructuredTool[] {
    return [...this.tools];
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  /**
   * Initialize the LLM based on config (supports OpenAI and Anthropic).
   */
  private async initializeLlm(): Promise<BaseChatModel> {
    if (this.llm) return this.llm;

    // Prevent concurrent initialization
    if (this.llmInitPromise) return this.llmInitPromise;

    this.llmInitPromise = this.createLlm();
    try {
      this.llm = await this.llmInitPromise;
      return this.llm;
    } finally {
      this.llmInitPromise = null;
    }
  }

  /**
   * Create the LLM instance using LangChain's universal initChatModel.
   */
  private async createLlm(): Promise<BaseChatModel> {
    const config = getConfig();
    const { provider, apiKey, model, maxTokens, timeoutMs } = config.llm;

    // Map our config provider names to LangChain provider names
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
        { provider, supportedProviders: Object.keys(providerMap) },
        'Set LLM_PROVIDER to "openai" or "anthropic" in your environment',
      );
    }

    try {
      const llm = await initChatModel(model, {
        modelProvider: langchainProvider,
        apiKey,
        maxTokens,
        timeout: timeoutMs,
      });
      return llm as unknown as BaseChatModel;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw AppError.llmService(
        LlmErrorCodes.SERVICE_UNAVAILABLE,
        `Failed to initialize LLM (${provider}/${model}): ${message}`,
        { provider, model, error: err },
        'Check your LLM_API_KEY and network connectivity',
      );
    }
  }

  /**
   * Get the LLM instance, initializing if needed.
   */
  private async getLlm(): Promise<BaseChatModel> {
    if (this.llm) return this.llm;
    return this.initializeLlm();
  }

  /**
   * Register tools for the Agent from the toolbox.
   */
  private registerFeishuTools(feishuClient: any): void {
    this.tools = registerTools(feishuClient);
  }

  /**
   * Invoke the LLM with retry logic for transient failures.
   */
  private async invokeLlm(
    llm: any,
    messages: BaseMessage[],
  ): Promise<AIMessage> {
    const result = await withRetry(
      async () => {
        try {
          const response = await (llm as any).invoke(messages);
          return response as AIMessage;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);

          // Classify LLM errors
          if (message.includes('token') || message.includes('context length')) {
            throw AppError.llmService(
              LlmErrorCodes.TOKEN_LIMIT,
              `LLM token limit exceeded: ${message}`,
              err,
              'Try reducing the conversation context or input size',
            );
          }

          throw AppError.llmService(
            LlmErrorCodes.SERVICE_UNAVAILABLE,
            `LLM invocation failed: ${message}`,
            err,
            'Check LLM service availability and API key',
          );
        }
      },
      { sleep: this.retrySleep },
    );

    return result;
  }

  /**
   * Execute a tool by name with the given parameters.
   */
  private async executeTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    try {
      const tool = this.tools.find((t) => t.name === toolName);
      if (!tool) {
        return `Error: tool "${toolName}" is not registered`;
      }

      const result = await tool.invoke(args);
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (err) {
      const error = AppError.from(err);
      return `Error executing tool "${toolName}": ${error.message}`;
    }
  }

  /**
   * Build the full messages array for the LLM, including system prompt.
   */
  private buildMessages(context: ConversationContext): BaseMessage[] {
    const messages: BaseMessage[] = [
      new SystemMessage(this.systemPrompt),
      ...context.messages,
    ];
    return messages;
  }

  /**
   * Format the input content based on message type.
   */
  private formatInputContent(input: AgentInput): string {
    switch (input.messageType) {
      case 'command':
        return `[Command] ${input.content}`;
      case 'file':
        return `[File Content]\n${input.content}`;
      case 'callback':
        return `[Callback] ${input.content}`;
      case 'text':
      default:
        return input.content;
    }
  }

  /**
   * Trim context messages to stay within the configured limit.
   * Keeps the most recent messages.
   */
  private trimContext(context: ConversationContext): void {
    if (context.messages.length > this.maxContextMessages) {
      const excess = context.messages.length - this.maxContextMessages;
      context.messages.splice(0, excess);
    }
  }
}
