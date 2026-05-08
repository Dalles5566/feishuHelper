/**
 * Webhook Gateway for receiving and dispatching Feishu bot event callbacks.
 *
 * Responsibilities:
 * - Verify request signatures from Feishu platform
 * - Handle URL Challenge verification (required during webhook registration)
 * - Dispatch events to appropriate handlers based on event_type
 * - Process message events (im.message.receive_v1) and card callback events
 *
 * Requirements: 10.1, 10.4
 */

import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AppError, ValidationErrorCodes } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Feishu event envelope structure */
export interface FeishuEvent {
  schema: string;
  header: {
    event_id: string;
    event_type: string;
    create_time: string;
    token: string;
    app_id: string;
  };
  event: {
    message?: MessageEvent;
    action?: CardActionEvent;
    [key: string]: unknown;
  };
}

/** Message event payload */
export interface MessageEvent {
  message_id: string;
  chat_id: string;
  chat_type: string;
  content: string;
  sender: {
    sender_id: {
      user_id: string;
      open_id?: string;
      union_id?: string;
    };
  };
}

/** Card action callback event payload */
export interface CardActionEvent {
  tag: string;
  value: Record<string, unknown>;
  open_id: string;
  token: string;
}

/** URL Challenge request body from Feishu during webhook registration */
export interface ChallengeRequest {
  challenge: string;
  token: string;
  type: 'url_verification';
}

/** Event handler function signature */
export type EventHandler = (event: FeishuEvent) => Promise<void>;

/** Configuration required by the webhook gateway */
export interface WebhookGatewayConfig {
  verificationToken: string;
  encryptKey: string;
}

// ---------------------------------------------------------------------------
// Signature Verification
// ---------------------------------------------------------------------------

/**
 * Verify the signature of a Feishu webhook request.
 *
 * Feishu signs requests using HMAC-SHA256 with the timestamp + nonce + encrypt key
 * concatenated as the signing content.
 *
 * @param timestamp - The X-Lark-Request-Timestamp header value
 * @param nonce - The X-Lark-Request-Nonce header value
 * @param encryptKey - The app's encrypt key from configuration
 * @param body - The raw request body string
 * @param signature - The X-Lark-Signature header value to verify against
 * @returns true if the signature is valid, false otherwise
 */
export function verifySignature(
  timestamp: string,
  nonce: string,
  encryptKey: string,
  body: string,
  signature: string,
): boolean {
  if (!timestamp || !nonce || !signature) {
    return false;
  }

  const content = timestamp + nonce + encryptKey + body;
  const computedSignature = crypto.createHash('sha256').update(content).digest('hex');

  // Use timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(computedSignature, 'hex'),
      Buffer.from(signature, 'hex'),
    );
  } catch {
    // If buffers have different lengths, the signature is invalid
    return false;
  }
}

/**
 * Handle URL Challenge verification request from Feishu.
 *
 * When registering a webhook URL, Feishu sends a challenge request that must
 * be echoed back to confirm ownership of the endpoint.
 *
 * @param challenge - The challenge string from Feishu
 * @returns An object containing the challenge string to echo back
 */
export function handleChallenge(challenge: string): { challenge: string } {
  return { challenge };
}

// ---------------------------------------------------------------------------
// Event Dispatcher
// ---------------------------------------------------------------------------

/**
 * Registry of event handlers keyed by event_type.
 */
export class EventDispatcher {
  private handlers: Map<string, EventHandler[]> = new Map();

  /**
   * Register a handler for a specific event type.
   *
   * @param eventType - The Feishu event type (e.g. 'im.message.receive_v1')
   * @param handler - The async handler function to invoke
   */
  register(eventType: string, handler: EventHandler): void {
    const existing = this.handlers.get(eventType) ?? [];
    existing.push(handler);
    this.handlers.set(eventType, existing);
  }

  /**
   * Dispatch an event to all registered handlers for its event_type.
   *
   * @param event - The parsed Feishu event
   * @throws AppError if no handlers are registered for the event type
   */
  async dispatch(event: FeishuEvent): Promise<void> {
    const eventType = event.header.event_type;
    const handlers = this.handlers.get(eventType);

    if (!handlers || handlers.length === 0) {
      // Log unhandled event types but don't throw — Feishu may send events
      // we haven't implemented handlers for yet
      console.warn(`[WebhookGateway] No handler registered for event type: ${eventType}`);
      return;
    }

    // Execute all handlers for this event type
    for (const handler of handlers) {
      await handler(event);
    }
  }

  /**
   * Check if a handler is registered for a given event type.
   */
  hasHandler(eventType: string): boolean {
    const handlers = this.handlers.get(eventType);
    return handlers !== undefined && handlers.length > 0;
  }

  /**
   * Get all registered event types.
   */
  getRegisteredEventTypes(): string[] {
    return Array.from(this.handlers.keys());
  }
}

// ---------------------------------------------------------------------------
// Webhook Gateway Plugin
// ---------------------------------------------------------------------------

/** Options for the webhook gateway Fastify plugin */
export interface WebhookGatewayOptions {
  config: WebhookGatewayConfig;
  dispatcher: EventDispatcher;
  /** Base path for webhook routes (default: '/webhook') */
  basePath?: string;
}

/**
 * Determine if a request body is a URL Challenge verification request.
 */
function isChallengeRequest(body: unknown): body is ChallengeRequest {
  if (typeof body !== 'object' || body === null) return false;
  const obj = body as Record<string, unknown>;
  return obj['type'] === 'url_verification' && typeof obj['challenge'] === 'string';
}

/**
 * Determine if a request body is a standard Feishu event.
 */
function isFeishuEvent(body: unknown): body is FeishuEvent {
  if (typeof body !== 'object' || body === null) return false;
  const obj = body as Record<string, unknown>;
  return (
    typeof obj['header'] === 'object' &&
    obj['header'] !== null &&
    typeof (obj['header'] as Record<string, unknown>)['event_type'] === 'string'
  );
}

/**
 * Register webhook gateway routes on a Fastify instance.
 *
 * This function registers a POST route that handles:
 * 1. URL Challenge verification (during webhook registration)
 * 2. Event signature verification
 * 3. Event dispatching to registered handlers
 *
 * @param app - The Fastify instance to register routes on
 * @param options - Gateway configuration and dispatcher
 */
export async function registerWebhookGateway(
  app: FastifyInstance,
  options: WebhookGatewayOptions,
): Promise<void> {
  const { config, dispatcher, basePath = '/webhook' } = options;

  // Register raw body content type parser for signature verification
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        const parsed = JSON.parse(body as string);
        done(null, parsed);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.post(
    `${basePath}/event`,
    {
      config: {
        rawBody: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body;

      // Step 1: Handle URL Challenge verification
      if (isChallengeRequest(body)) {
        // Verify the token matches our verification token
        if (body.token !== config.verificationToken) {
          return reply.status(403).send({
            error: 'Invalid verification token',
          });
        }
        const response = handleChallenge(body.challenge);
        return reply.status(200).send(response);
      }

      // Step 2: Verify request signature (if encrypt key is configured)
      if (config.encryptKey) {
        const timestamp = request.headers['x-lark-request-timestamp'] as string | undefined;
        const nonce = request.headers['x-lark-request-nonce'] as string | undefined;
        const signature = request.headers['x-lark-signature'] as string | undefined;

        if (!timestamp || !nonce || !signature) {
          return reply.status(401).send({
            error: 'Missing signature headers',
          });
        }

        // We need the raw body string for signature verification
        const rawBody = JSON.stringify(body);
        const isValid = verifySignature(timestamp, nonce, config.encryptKey, rawBody, signature);

        if (!isValid) {
          return reply.status(401).send({
            error: 'Invalid signature',
          });
        }
      }

      // Step 3: Validate event structure
      if (!isFeishuEvent(body)) {
        throw AppError.validation(
          ValidationErrorCodes.INVALID_FORMAT,
          'Invalid event payload: missing header or event_type',
          { body },
        );
      }

      // Step 4: Verify the event token matches our verification token
      if (body.header.token !== config.verificationToken) {
        return reply.status(403).send({
          error: 'Invalid event token',
        });
      }

      // Step 5: Dispatch event to registered handlers
      await dispatcher.dispatch(body);

      // Feishu expects a 200 response to acknowledge receipt
      return reply.status(200).send({ code: 0, msg: 'ok' });
    },
  );
}
