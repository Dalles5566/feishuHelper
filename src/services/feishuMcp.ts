/**
 * Feishu MCP integration service.
 *
 * Initializes the @larksuiteoapi/lark-mcp client and provides a unified
 * interface for calling MCP tools with error handling and rate limiting
 * via exponential backoff retry.
 *
 * Requirements: 10.1, 10.2, 10.5
 */

import { LarkMcpTool } from '@larksuiteoapi/lark-mcp/dist/mcp-tool/index.js';
import type { McpTool, LarkMcpToolOptions } from '@larksuiteoapi/lark-mcp';
import { getConfig } from '../config/index.js';
import { AppError, FeishuErrorCodes } from '../utils/errors.js';
import { withRetry, type RetryOptions } from '../utils/retry.js';
import { FeishuAuthService } from './feishuAuth.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of an MCP tool call. */
export interface McpToolCallResult {
  /** Whether the call resulted in an error. */
  isError: boolean;
  /** Content items returned by the tool. */
  content: Array<{ type: string; text: string }>;
}

/** Options for creating a FeishuMcpService instance. */
export interface FeishuMcpServiceOptions {
  /** Override the FeishuAuthService instance (useful for testing). */
  authService?: FeishuAuthService;
  /** Override the LarkMcpTool instance (useful for testing). */
  mcpTool?: LarkMcpTool;
  /** Override retry options for tool calls. */
  retryOptions?: RetryOptions;
  /** Override LarkMcpTool options (useful for testing). */
  larkMcpToolOptions?: LarkMcpToolOptions;
}

// ---------------------------------------------------------------------------
// FeishuMcpService
// ---------------------------------------------------------------------------

/**
 * Wraps the Feishu MCP client with unified error handling and retry logic.
 *
 * All tool calls go through `callTool()` which:
 * 1. Retrieves a valid token from FeishuAuthService
 * 2. Executes the MCP tool call
 * 3. Handles rate limiting with exponential backoff (via withRetry)
 * 4. Classifies and wraps errors as AppError
 */
export class FeishuMcpService {
  private readonly authService: FeishuAuthService;
  private readonly mcpTool: LarkMcpTool;
  private readonly retryOptions: RetryOptions;

  constructor(options: FeishuMcpServiceOptions = {}) {
    const config = getConfig();

    this.authService = options.authService ?? new FeishuAuthService();

    const larkOptions: LarkMcpToolOptions = options.larkMcpToolOptions ?? {
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
    };

    this.mcpTool = options.mcpTool ?? new LarkMcpTool(larkOptions);

    this.retryOptions = options.retryOptions ?? {};
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Get the list of available MCP tools.
   */
  getAvailableTools(): McpTool[] {
    return this.mcpTool.getTools();
  }

  /**
   * Call an MCP tool by name with the given parameters.
   *
   * Handles authentication, error classification, and retry with exponential
   * backoff for rate-limited or transient failures.
   *
   * @param toolName - The name of the MCP tool to invoke.
   * @param params   - Parameters to pass to the tool.
   * @returns        The tool call result.
   * @throws         AppError with category 'feishu_api' on failure.
   */
  async callTool(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<McpToolCallResult> {
    return withRetry(
      async () => {
        // Get a fresh token for each attempt (handles token refresh on 401)
        const token = await this.getAuthToken();

        // Update the MCP client with the current token
        this.mcpTool.updateUserAccessToken(token);

        // Find the tool definition
        const tool = this.findTool(toolName);
        if (!tool) {
          throw AppError.feishuApi(
            FeishuErrorCodes.NOT_FOUND,
            `MCP tool not found: ${toolName}`,
            { toolName, availableTools: this.mcpTool.getTools().map((t) => t.name) },
            'Verify the tool name is correct and the tool is available',
          );
        }

        // Execute the tool via its custom handler or throw if not callable
        const result = await this.executeTool(tool, params);

        // Check if the result indicates an error from the Feishu API
        if (result.isError) {
          const errorText = result.content.map((c) => c.text).join('\n');
          const classifiedError = this.classifyApiError(errorText, toolName);
          throw classifiedError;
        }

        return result;
      },
      this.retryOptions,
    );
  }

  /**
   * Call an MCP tool with a pre-fetched token (skips internal token fetch).
   * Useful when the caller already has a valid token.
   */
  async callToolWithToken(
    toolName: string,
    params: Record<string, unknown>,
    token: string,
  ): Promise<McpToolCallResult> {
    return withRetry(
      async () => {
        this.mcpTool.updateUserAccessToken(token);

        const tool = this.findTool(toolName);
        if (!tool) {
          throw AppError.feishuApi(
            FeishuErrorCodes.NOT_FOUND,
            `MCP tool not found: ${toolName}`,
            { toolName },
            'Verify the tool name is correct and the tool is available',
          );
        }

        const result = await this.executeTool(tool, params);

        if (result.isError) {
          const errorText = result.content.map((c) => c.text).join('\n');
          throw this.classifyApiError(errorText, toolName);
        }

        return result;
      },
      this.retryOptions,
    );
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  /**
   * Get an authentication token from the auth service.
   */
  private async getAuthToken(): Promise<string> {
    try {
      return await this.authService.getToken();
    } catch (err) {
      throw AppError.feishuApi(
        FeishuErrorCodes.AUTH_FAILED,
        'Failed to obtain Feishu authentication token',
        err,
        'Check Feishu app credentials and network connectivity',
      );
    }
  }

  /**
   * Find a tool by name from the available tools list.
   */
  private findTool(toolName: string): McpTool | undefined {
    const tools = this.mcpTool.getTools();
    return tools.find((t) => t.name === toolName);
  }

  /**
   * Execute an MCP tool and return the result.
   */
  private async executeTool(
    tool: McpTool,
    params: Record<string, unknown>,
  ): Promise<McpToolCallResult> {
    try {
      if (tool.customHandler) {
        const result = await tool.customHandler(
          // The client is managed internally by LarkMcpTool, pass null-ish
          // since the handler uses the client from the LarkMcpTool instance
          undefined as any,
          params,
          { tool },
        );
        return {
          isError: result.isError ?? false,
          content: (result.content ?? []) as Array<{ type: string; text: string }>,
        };
      }

      // For tools without a custom handler, we cannot execute them directly
      // outside of the MCP server context. Throw a descriptive error.
      throw AppError.feishuApi(
        FeishuErrorCodes.UNEXPECTED,
        `Tool "${tool.name}" does not have a callable handler`,
        { toolName: tool.name, project: tool.project },
        'This tool may only be available through the MCP server transport',
      );
    } catch (err) {
      if (err instanceof AppError) {
        throw err;
      }
      // Wrap unexpected errors
      const message = err instanceof Error ? err.message : String(err);
      throw AppError.feishuApi(
        FeishuErrorCodes.UNEXPECTED,
        `MCP tool call failed: ${message}`,
        { toolName: tool.name, error: err },
        'Check the tool parameters and Feishu API status',
      );
    }
  }

  /**
   * Classify an API error response into the appropriate AppError.
   *
   * Detects rate limiting (HTTP 429), auth failures, and other common errors.
   */
  private classifyApiError(errorText: string, toolName: string): AppError {
    const lowerText = errorText.toLowerCase();

    // Rate limiting detection
    if (
      lowerText.includes('rate limit') ||
      lowerText.includes('too many requests') ||
      lowerText.includes('429')
    ) {
      return AppError.feishuApi(
        FeishuErrorCodes.RATE_LIMITED,
        `Feishu API rate limited during tool call: ${toolName}`,
        { toolName, errorText },
        'The request will be retried automatically with exponential backoff',
      );
    }

    // Authentication failures
    if (
      lowerText.includes('unauthorized') ||
      lowerText.includes('token') ||
      lowerText.includes('401') ||
      lowerText.includes('auth')
    ) {
      return AppError.feishuApi(
        FeishuErrorCodes.AUTH_FAILED,
        `Feishu API authentication failed during tool call: ${toolName}`,
        { toolName, errorText },
        'Token may have expired; it will be refreshed on retry',
      );
    }

    // Not found
    if (lowerText.includes('not found') || lowerText.includes('404')) {
      return AppError.feishuApi(
        FeishuErrorCodes.NOT_FOUND,
        `Resource not found during tool call: ${toolName}`,
        { toolName, errorText },
        'Verify the resource ID and permissions',
      );
    }

    // Timeout
    if (
      lowerText.includes('timeout') ||
      lowerText.includes('timed out') ||
      lowerText.includes('ETIMEDOUT')
    ) {
      return AppError.feishuApi(
        FeishuErrorCodes.TIMEOUT,
        `Feishu API timeout during tool call: ${toolName}`,
        { toolName, errorText },
        'The request will be retried automatically',
      );
    }

    // Generic API error
    return AppError.feishuApi(
      FeishuErrorCodes.UNEXPECTED,
      `Feishu API error during tool call: ${toolName}`,
      { toolName, errorText },
      'Check the Feishu API status and tool parameters',
    );
  }
}
