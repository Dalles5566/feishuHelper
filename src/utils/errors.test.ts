/**
 * Unit tests for the AppError class and error utilities.
 *
 * Requirements: 1.4, 2.6, 10.5
 */

import { describe, it, expect } from 'vitest';
import {
  AppError,
  FeishuErrorCodes,
  LlmErrorCodes,
  StateErrorCodes,
  ValidationErrorCodes,
  BusinessErrorCodes,
} from './errors.js';

// ---------------------------------------------------------------------------
// Constructor & basic properties
// ---------------------------------------------------------------------------

describe('AppError constructor', () => {
  it('sets all fields correctly', () => {
    const err = new AppError({
      code: 'TEST_CODE',
      category: 'feishu_api',
      message: 'Something went wrong',
      details: { raw: 'data' },
      retryable: true,
      suggestedAction: 'Try again later',
    });

    expect(err.code).toBe('TEST_CODE');
    expect(err.category).toBe('feishu_api');
    expect(err.message).toBe('Something went wrong');
    expect(err.details).toEqual({ raw: 'data' });
    expect(err.retryable).toBe(true);
    expect(err.suggestedAction).toBe('Try again later');
    expect(err.name).toBe('AppError');
  });

  it('is an instance of Error', () => {
    const err = new AppError({
      code: 'X',
      category: 'validation',
      message: 'bad input',
      retryable: false,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
  });

  it('works without optional fields', () => {
    const err = new AppError({
      code: 'MINIMAL',
      category: 'business_logic',
      message: 'minimal error',
      retryable: false,
    });
    expect(err.details).toBeUndefined();
    expect(err.suggestedAction).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Static factory methods
// ---------------------------------------------------------------------------

describe('AppError.from()', () => {
  it('returns the same AppError if already an AppError', () => {
    const original = AppError.validation('V', 'bad');
    const wrapped = AppError.from(original);
    expect(wrapped).toBe(original);
  });

  it('wraps a plain Error', () => {
    const plain = new Error('plain error');
    const wrapped = AppError.from(plain);
    expect(wrapped).toBeInstanceOf(AppError);
    expect(wrapped.message).toBe('plain error');
    expect(wrapped.category).toBe('business_logic');
    expect(wrapped.retryable).toBe(false);
  });

  it('wraps a string', () => {
    const wrapped = AppError.from('oops');
    expect(wrapped.message).toBe('oops');
  });

  it('uses the provided fallback code', () => {
    const wrapped = AppError.from(new Error('x'), 'MY_CODE');
    expect(wrapped.code).toBe('MY_CODE');
  });
});

describe('AppError.feishuApi()', () => {
  it('creates a retryable feishu_api error', () => {
    const err = AppError.feishuApi('FEISHU_API_TIMEOUT', 'Request timed out');
    expect(err.category).toBe('feishu_api');
    expect(err.retryable).toBe(true);
    expect(err.code).toBe('FEISHU_API_TIMEOUT');
  });
});

describe('AppError.llmService()', () => {
  it('creates a retryable llm_service error', () => {
    const err = AppError.llmService('LLM_SERVICE_UNAVAILABLE', 'LLM down');
    expect(err.category).toBe('llm_service');
    expect(err.retryable).toBe(true);
  });
});

describe('AppError.stateTransition()', () => {
  it('creates a non-retryable state_transition error', () => {
    const err = AppError.stateTransition('STATE_INVALID_TRANSITION', 'Cannot go from A to B');
    expect(err.category).toBe('state_transition');
    expect(err.retryable).toBe(false);
  });
});

describe('AppError.validation()', () => {
  it('creates a non-retryable validation error', () => {
    const err = AppError.validation('VALIDATION_EMPTY_CONTENT', 'Content is empty');
    expect(err.category).toBe('validation');
    expect(err.retryable).toBe(false);
  });
});

describe('AppError.businessLogic()', () => {
  it('creates a non-retryable business_logic error', () => {
    const err = AppError.businessLogic('BUSINESS_TASK_NOT_FOUND', 'Task not found');
    expect(err.category).toBe('business_logic');
    expect(err.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toJSON
// ---------------------------------------------------------------------------

describe('AppError.toJSON()', () => {
  it('returns a plain object with all fields', () => {
    const err = AppError.feishuApi('CODE', 'msg', { x: 1 }, 'retry later');
    const json = err.toJSON();
    expect(json['name']).toBe('AppError');
    expect(json['code']).toBe('CODE');
    expect(json['category']).toBe('feishu_api');
    expect(json['message']).toBe('msg');
    expect(json['retryable']).toBe(true);
    expect(json['suggestedAction']).toBe('retry later');
    expect(json['details']).toEqual({ x: 1 });
  });
});

// ---------------------------------------------------------------------------
// Well-known error code constants
// ---------------------------------------------------------------------------

describe('Error code constants', () => {
  it('FeishuErrorCodes are defined', () => {
    expect(FeishuErrorCodes.TIMEOUT).toBe('FEISHU_API_TIMEOUT');
    expect(FeishuErrorCodes.AUTH_FAILED).toBe('FEISHU_API_AUTH_FAILED');
    expect(FeishuErrorCodes.RATE_LIMITED).toBe('FEISHU_API_RATE_LIMITED');
  });

  it('LlmErrorCodes are defined', () => {
    expect(LlmErrorCodes.TOKEN_LIMIT).toBe('LLM_TOKEN_LIMIT_EXCEEDED');
    expect(LlmErrorCodes.SERVICE_UNAVAILABLE).toBe('LLM_SERVICE_UNAVAILABLE');
  });

  it('StateErrorCodes are defined', () => {
    expect(StateErrorCodes.INVALID_TRANSITION).toBe('STATE_INVALID_TRANSITION');
  });

  it('ValidationErrorCodes are defined', () => {
    expect(ValidationErrorCodes.EMPTY_CONTENT).toBe('VALIDATION_EMPTY_CONTENT');
  });

  it('BusinessErrorCodes are defined', () => {
    expect(BusinessErrorCodes.TASK_NOT_FOUND).toBe('BUSINESS_TASK_NOT_FOUND');
  });
});
