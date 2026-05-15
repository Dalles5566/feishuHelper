/**
 * Message handler integration module.
 *
 * Connects the Webhook Gateway (EventDispatcher) to the AI Agent Core
 * and Notification Service, completing the end-to-end message processing flow:
 *   Message received → AgentCore processes → Notification sent to user
 *
 * Also handles card action callbacks (button clicks from interactive messages).
 *
 * Requirements: 1.1-1.5, 2.1-2.6, 10.1
 */

import type { EventDispatcher, FeishuEvent } from '../gateway/webhookGateway.js';
import type { AgentCore, AgentInput } from '../agent/agentCore.js';
import type { NotificationService } from '../services/notification.js';

// ---------------------------------------------------------------------------
// Message deduplication
// ---------------------------------------------------------------------------

/** Set of recently processed message IDs to prevent duplicate processing. */
const processedMessageIds = new Set<string>();
const MAX_DEDUP_SIZE = 500;

function markProcessed(messageId: string): boolean {
  if (processedMessageIds.has(messageId)) {
    return false; // already processed
  }
  processedMessageIds.add(messageId);
  // Prevent unbounded growth
  if (processedMessageIds.size > MAX_DEDUP_SIZE) {
    const first = processedMessageIds.values().next().value;
    if (first) processedMessageIds.delete(first);
  }
  return true; // first time seeing this message
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for registerMessageHandler. */
export interface RegisterMessageHandlerOptions {
  /** The EventDispatcher to register handlers on. */
  dispatcher: EventDispatcher;
  /** The AgentCore instance for processing messages. */
  agentCore: AgentCore;
  /** The NotificationService for sending responses back to users. */
  notificationService: NotificationService;
}

// ---------------------------------------------------------------------------
// Handler Registration
// ---------------------------------------------------------------------------

/**
 * Register event handlers on the EventDispatcher that wire incoming Feishu
 * events through AgentCore and send responses via NotificationService.
 *
 * Registers handlers for:
 * - 'im.message.receive_v1': User messages → AgentCore → Notification response
 * - 'card.action.trigger': Card button callbacks → AgentCore → Notification response
 */
export function registerMessageHandler(
  dispatcher: EventDispatcher,
  agentCore: AgentCore,
  notificationService: NotificationService,
): void {
  // Handle incoming user messages
  dispatcher.register('im.message.receive_v1', async (event: FeishuEvent) => {
    await handleMessageEvent(event, agentCore, notificationService);
  });

  // Handle card action callbacks (button clicks)
  dispatcher.register('card.action.trigger', async (event: FeishuEvent) => {
    await handleCardActionEvent(event, agentCore, notificationService);
  });
}

// ---------------------------------------------------------------------------
// Event Handlers
// ---------------------------------------------------------------------------

/**
 * Handle an incoming message event from Feishu.
 *
 * Extracts message content and sender info, passes to AgentCore for processing,
 * then sends the agent's response back to the user via NotificationService.
 */
async function handleMessageEvent(
  event: FeishuEvent,
  agentCore: AgentCore,
  notificationService: NotificationService,
): Promise<void> {
  const message = event.event.message;
  if (!message) {
    console.warn('[MessageHandler] Received message event without message payload');
    return;
  }

  // Ignore messages sent by the bot itself to prevent infinite loops
  const sender = (event.event as any).sender;
  if (sender?.sender_type === 'app') {
    return;
  }

  // Ignore stale messages (older than 30 seconds) — Feishu retries from when server was offline
  const messageCreateTime = parseInt(message.create_time || '0', 10);
  const now = Date.now();
  if (messageCreateTime > 0 && (now - messageCreateTime) > 300000) {
    return;
  }

  // Deduplicate: ignore messages we've already processed
  if (!markProcessed(message.message_id)) {
    return;
  }

  const userId = sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? 'unknown';
  const chatId = message.chat_id;

  // Parse message content (Feishu sends JSON-encoded content)
  let textContent: string;
  try {
    const parsed = JSON.parse(message.content);
    textContent = parsed.text ?? message.content;
  } catch {
    textContent = message.content;
  }

  // Build agent input — use message_id as session to avoid stale context from previous failures
  const agentInput: AgentInput = {
    sessionId: message.message_id,
    userId,
    messageType: 'text',
    content: textContent,
    metadata: {
      messageId: message.message_id,
      chatId,
      chatType: message.chat_type,
    },
  };

  // Process through AgentCore
  const output = await agentCore.processInput(agentInput);

  // Send response back to user
  if (output.response) {
    await notificationService.sendNotification({
      type: 'task_assigned', // Generic notification type for agent responses
      recipientId: userId,
      chatId,
      content: output.response,
    });
  }
}

/**
 * Handle a card action callback event from Feishu.
 *
 * Card actions are triggered when users click buttons in interactive messages.
 * The action value is passed to AgentCore as a callback-type message.
 */
async function handleCardActionEvent(
  event: FeishuEvent,
  agentCore: AgentCore,
  notificationService: NotificationService,
): Promise<void> {
  const action = event.event.action;
  if (!action) {
    console.warn('[MessageHandler] Received card action event without action payload');
    return;
  }

  const userId = action.open_id;
  const actionValue = JSON.stringify(action.value);

  // Build agent input for callback
  const agentInput: AgentInput = {
    sessionId: `card-${userId}`,
    userId,
    messageType: 'callback',
    content: actionValue,
    metadata: {
      actionTag: action.tag,
      actionValue: action.value,
    },
  };

  // Process through AgentCore
  const output = await agentCore.processInput(agentInput);

  // Send response back to user
  if (output.response) {
    await notificationService.sendNotification({
      type: 'task_assigned',
      recipientId: userId,
      content: output.response,
    });
  }
}
