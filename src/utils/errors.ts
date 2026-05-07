/**
 * Unified error handling framework.
 *
 * Defines the AppError class and ErrorCategory enum used throughout the
 * application to classify, propagate, and handle errors consistently.
 *
 * Error categories and their handling strategies:
 *   - feishu_api      : Retryable (up to 3 times, exponential backoff)
 *   - llm_service     : Retryable (up to 2 times, exponential backoff)
 *   - state_transition: Not retryable — invalid transitions are rejected immediately
 *   - validation      : Not retryable — bad input must be corrected by the caller
 *   - business_logic  : Not retryable — business rule violations require user action
 *
 * Requirements: 1.4, 2.6, 10.5
 */

// ---------------------------------------------------------------------------
// Error Category
// ---------------------------------------------------------------------------

/**
 * High-level category that determines the retry strategy and escalation path
 * for an error.
 */
export type ErrorCategory =
  | 'feishu_api'
  | 'llm_service'
  | 'state_transition'
  | 'validation'
  | 'business_logic';

// ---------------------------------------------------------------------------
// AppError
// ---------------------------------------------------------------------------

/**
 * Structured application error with classification metadata.
 *
 * Use `AppError.from()` to wrap unknown caught values, and the static factory
 * methods (`feishuApi`, `llmService`, etc.) for convenient construction.
 */
export class AppError extends Error {
  /** Machine-readable error code, e.g. 'FEISHU_API_TIMEOUT'. */
  readonly code: string;
  /** High-level category used to select the retry policy. */
  readonly category: ErrorCategory;
  /** Human-readable description suitable for user-facing messages. */
  override readonly message: string;
  /** Technical details for logging (never shown to end users). */
  readonly details?: unknown;
  /** Whether the operation that caused this error can be retried. */
  readonly retryable: boolean;
  /** Optional guidance for the user on how to resolve the error. */
  readonly suggestedAction?: string;

  constructor(params: {
    code: string;
    category: ErrorCategory;
    message: string;
    details?: unknown;
    retryable: boolean;
    suggestedAction?: string;
  }) {
    super(params.message);
    this.name = 'AppError';
    this.code = params.code;
    this.category = params.category;
    this.message = params.message;
    this.details = params.details;
    this.retryable = params.retryable;
    this.suggestedAction = params.suggestedAction;

    // Maintain proper prototype chain in transpiled environments
    Object.setPrototypeOf(this, new.target.prototype);
  }

  // ---------------------------------------------------------------------------
  // Static factory methods
  // ---------------------------------------------------------------------------

  /**
   * Wrap an unknown caught value as an AppError.
   * If the value is already an AppError it is returned unchanged.
   */
  static from(err: unknown, fallbackCode = 'UNKNOWN_ERROR'): AppError {
    if (err instanceof AppError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new AppError({
      code: fallbackCode,
      category: 'business_logic',
      message,
      details: err,
      retryable: false,
    });
  }

  /** Create a Feishu API error (retryable). */
  static feishuApi(
    code: string,
    message: string,
    details?: unknown,
    suggestedAction?: string,
  ): AppError {
    return new AppError({
      code,
      category: 'feishu_api',
      message,
      details,
      retryable: true,
      suggestedAction,
    });
  }

  /** Create an LLM service error (retryable). */
  static llmService(
    code: string,
    message: string,
    details?: unknown,
    suggestedAction?: string,
  ): AppError {
    return new AppError({
      code,
      category: 'llm_service',
      message,
      details,
      retryable: true,
      suggestedAction,
    });
  }

  /** Create a state transition error (not retryable). */
  static stateTransition(
    code: string,
    message: string,
    details?: unknown,
    suggestedAction?: string,
  ): AppError {
    return new AppError({
      code,
      category: 'state_transition',
      message,
      details,
      retryable: false,
      suggestedAction,
    });
  }

  /** Create a validation error (not retryable). */
  static validation(
    code: string,
    message: string,
    details?: unknown,
    suggestedAction?: string,
  ): AppError {
    return new AppError({
      code,
      category: 'validation',
      message,
      details,
      retryable: false,
      suggestedAction,
    });
  }

  /** Create a business logic error (not retryable). */
  static businessLogic(
    code: string,
    message: string,
    details?: unknown,
    suggestedAction?: string,
  ): AppError {
    return new AppError({
      code,
      category: 'business_logic',
      message,
      details,
      retryable: false,
      suggestedAction,
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Return a plain object representation suitable for JSON logging. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      message: this.message,
      retryable: this.retryable,
      suggestedAction: this.suggestedAction,
      details: this.details,
    };
  }
}

// ---------------------------------------------------------------------------
// Well-known error codes
// ---------------------------------------------------------------------------

/** Commonly used Feishu API error codes. */
export const FeishuErrorCodes = {
  TIMEOUT: 'FEISHU_API_TIMEOUT',
  AUTH_FAILED: 'FEISHU_API_AUTH_FAILED',
  RATE_LIMITED: 'FEISHU_API_RATE_LIMITED',
  NOT_FOUND: 'FEISHU_API_NOT_FOUND',
  UNEXPECTED: 'FEISHU_API_UNEXPECTED',
} as const;

/** Commonly used LLM service error codes. */
export const LlmErrorCodes = {
  TOKEN_LIMIT: 'LLM_TOKEN_LIMIT_EXCEEDED',
  SERVICE_UNAVAILABLE: 'LLM_SERVICE_UNAVAILABLE',
  INVALID_RESPONSE: 'LLM_INVALID_RESPONSE',
} as const;

/** Commonly used state transition error codes. */
export const StateErrorCodes = {
  INVALID_TRANSITION: 'STATE_INVALID_TRANSITION',
  TASK_NOT_FOUND: 'STATE_TASK_NOT_FOUND',
  CONCURRENT_MODIFICATION: 'STATE_CONCURRENT_MODIFICATION',
} as const;

/** Commonly used validation error codes. */
export const ValidationErrorCodes = {
  EMPTY_CONTENT: 'VALIDATION_EMPTY_CONTENT',
  MISSING_FIELD: 'VALIDATION_MISSING_FIELD',
  INVALID_FORMAT: 'VALIDATION_INVALID_FORMAT',
} as const;

/** Commonly used business logic error codes. */
export const BusinessErrorCodes = {
  TASK_NOT_FOUND: 'BUSINESS_TASK_NOT_FOUND',
  DUPLICATE_ASSIGNMENT: 'BUSINESS_DUPLICATE_ASSIGNMENT',
  MEETING_NOT_FOUND: 'BUSINESS_MEETING_NOT_FOUND',
} as const;
