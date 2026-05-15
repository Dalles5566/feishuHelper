/**
 * Notification service for sending messages via Feishu REST API.
 *
 * Supports different notification types:
 *   - task_assigned: Notify a developer of a new task assignment
 *   - state_changed: Notify about task state transitions
 *   - requirement_updated: Notify about requirement changes from meetings
 *   - verification_result: Notify about code verification outcomes
 *
 * On failure, notifications are re-queued via the notification queue
 * for retry with exponential backoff.
 *
 * Requirements: 3.2, 9.6
 */

// @ts-ignore — node-sdk ships CJS
import { Client } from '@larksuiteoapi/node-sdk';
import { FeishuMcpService } from './feishuMcp.js';
import { AppError, FeishuErrorCodes } from '../utils/errors.js';
import { addNotificationJob, type NotificationJobData } from '../queue/index.js';
import { getConfig } from '../config/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported notification types. */
export type NotificationType =
  | 'task_assigned'
  | 'state_changed'
  | 'requirement_updated'
  | 'verification_result';

/** Parameters for sending a notification. */
export interface SendNotificationParams {
  /** The type of notification to send. */
  type: NotificationType;
  /** The recipient's user ID in Feishu. */
  recipientId: string;
  /** Optional chat ID to send the message to (defaults to user direct message). */
  chatId?: string;
  /** Pre-formatted content string, or leave empty to auto-format from metadata. */
  content?: string;
  /** Additional metadata used for message formatting. */
  metadata?: Record<string, unknown>;
}

/** Result of a notification send attempt. */
export interface NotificationResult {
  /** Whether the notification was sent successfully. */
  success: boolean;
  /** Message ID returned by Feishu (if successful). */
  messageId?: string;
  /** Error details (if failed). */
  error?: string;
  /** Whether the notification was re-queued for retry. */
  requeued?: boolean;
}

/** Options for creating a NotificationService instance. */
export interface NotificationServiceOptions {
  /** Override the FeishuMcpService instance (useful for testing). */
  mcpService?: FeishuMcpService;
  /** Override the addNotificationJob function (useful for testing). */
  addJobFn?: typeof addNotificationJob;
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

/**
 * Format a notification message based on its type and metadata.
 * Returns a human-readable message string.
 */
export function formatNotificationMessage(
  type: NotificationType,
  metadata?: Record<string, unknown>,
  content?: string,
): string {
  // If explicit content is provided, use it directly
  if (content) return content;

  const taskTitle = (metadata?.taskTitle as string) || 'Unknown Task';
  const taskId = (metadata?.taskId as string) || '';

  switch (type) {
    case 'task_assigned': {
      const assignedBy = (metadata?.assignedBy as string) || 'Someone';
      return `📋 New Task Assigned\n\nTask: ${taskTitle}${taskId ? ` (${taskId})` : ''}\nAssigned by: ${assignedBy}\n\nPlease review and confirm the assignment.`;
    }

    case 'state_changed': {
      const fromState = (metadata?.fromState as string) || 'Unknown';
      const toState = (metadata?.toState as string) || 'Unknown';
      const reason = (metadata?.reason as string) || '';
      return `🔄 Task State Changed\n\nTask: ${taskTitle}${taskId ? ` (${taskId})` : ''}\nTransition: ${fromState} → ${toState}${reason ? `\nReason: ${reason}` : ''}`;
    }

    case 'requirement_updated': {
      const meetingTitle = (metadata?.meetingTitle as string) || 'Recent meeting';
      const changes = (metadata?.changes as string) || 'Requirements have been updated.';
      return `📝 Requirement Updated\n\nTask: ${taskTitle}${taskId ? ` (${taskId})` : ''}\nSource: ${meetingTitle}\nChanges: ${changes}\n\nPlease review the updated task description.`;
    }

    case 'verification_result': {
      const status = (metadata?.status as string) || 'unknown';
      const score = metadata?.matchScore as number | undefined;
      const statusEmoji = status === 'passed' ? '✅' : status === 'failed' ? '❌' : '⚠️';
      return `${statusEmoji} Verification Result\n\nTask: ${taskTitle}${taskId ? ` (${taskId})` : ''}\nStatus: ${status}${score !== undefined ? `\nMatch Score: ${score}/100` : ''}\n\nPlease check the verification report for details.`;
    }

    default:
      return `Notification: ${type}`;
  }
}

// ---------------------------------------------------------------------------
// NotificationService
// ---------------------------------------------------------------------------

/**
 * Service for sending notifications via Feishu MCP.
 *
 * On send failure, the notification is re-queued to the notification queue
 * for retry with exponential backoff.
 */
export class NotificationService {
  private readonly mcpService: FeishuMcpService;
  private readonly addJobFn: typeof addNotificationJob;
  private readonly client: InstanceType<typeof Client>;

  constructor(options: NotificationServiceOptions = {}) {
    this.mcpService = options.mcpService ?? new FeishuMcpService();
    this.addJobFn = options.addJobFn ?? addNotificationJob;

    const config = getConfig();
    this.client = new Client({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
    });
  }

  /**
   * Send a notification to a Feishu user or chat.
   *
   * Formats the message based on type and metadata, then sends via
   * Feishu REST API (im.v1.message.create). On failure, re-queues the
   * notification for retry.
   */
  async sendNotification(params: SendNotificationParams): Promise<NotificationResult> {
    const { type, recipientId, chatId, content, metadata } = params;

    // Format the message content
    const messageContent = formatNotificationMessage(type, metadata, content);

    try {
      console.log(`[NotificationService] Sending message to ${chatId || recipientId}`);

      // Send via Feishu REST API directly
      const response = await this.client.im.v1.message.create({
        params: {
          receive_id_type: chatId ? 'chat_id' : 'open_id',
        },
        data: {
          receive_id: chatId || recipientId,
          msg_type: 'text',
          content: JSON.stringify({ text: messageContent }),
        },
      });

      console.log(`[NotificationService] API response:`, JSON.stringify(response, null, 2));

      const messageId = (response as any)?.data?.message_id;

      return {
        success: true,
        messageId,
      };
    } catch (error) {
      const errorMessage =
        error instanceof AppError ? error.message : String(error);

      console.error(`[NotificationService] Send failed:`, errorMessage);

      // Re-queue the notification for retry
      const requeued = await this.requeueNotification(params, messageContent);

      return {
        success: false,
        error: errorMessage,
        requeued,
      };
    }
  }

  /**
   * Re-queue a failed notification for retry via the notification queue.
   * Returns true if successfully re-queued, false otherwise.
   */
  private async requeueNotification(
    params: SendNotificationParams,
    formattedContent: string,
  ): Promise<boolean> {
    try {
      const jobData: NotificationJobData = {
        type: params.type,
        recipientId: params.recipientId,
        chatId: params.chatId,
        content: formattedContent,
        metadata: params.metadata,
      };

      await this.addJobFn(jobData);
      return true;
    } catch {
      // If re-queuing also fails, we cannot do much more
      return false;
    }
  }
}
