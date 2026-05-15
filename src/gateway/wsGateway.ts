/**
 * WebSocket (Long Connection) Gateway for receiving Feishu bot events.
 *
 * Uses the official @larksuiteoapi/node-sdk WSClient to establish a persistent
 * WebSocket connection to Feishu, receiving events without needing a public
 * webhook URL. This is the recommended approach for development environments.
 *
 * Requirements: 10.1, 10.4
 */

// @ts-ignore — node-sdk ships CJS, types are in /types
import { WSClient, EventDispatcher as LarkEventDispatcher } from '@larksuiteoapi/node-sdk';
import type { EventDispatcher } from './webhookGateway.js';
import { getConfig } from '../config/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw Feishu event payload received over WebSocket */
interface RawLarkEvent {
  header?: {
    event_id?: string;
    event_type?: string;
    create_time?: string;
    token?: string;
    app_id?: string;
  };
  event?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// WsGateway
// ---------------------------------------------------------------------------

/**
 * Manages a persistent WebSocket connection to Feishu and bridges incoming
 * events to the existing EventDispatcher used by the rest of the application.
 */
export class WsGateway {
  private wsClient: InstanceType<typeof WSClient> | null = null;
  private readonly dispatcher: EventDispatcher;

  constructor(dispatcher: EventDispatcher) {
    this.dispatcher = dispatcher;
  }

  /**
   * Start the WebSocket connection and begin receiving events.
   */
  async start(): Promise<void> {
    const config = getConfig();

    // Build the Lark SDK EventDispatcher — handles decryption and verification
    const larkDispatcher = new LarkEventDispatcher({
      encryptKey: config.feishu.encryptKey,
      verificationToken: config.feishu.verificationToken,
    });

    // Register a catch-all handler that bridges to our EventDispatcher
    // The SDK calls registered handlers with the decoded event data
    larkDispatcher.register({
      'im.message.receive_v1': async (data: RawLarkEvent) => {
        console.log('[WsGateway] RAW im.message.receive_v1 data:', JSON.stringify(data, null, 2));
        await this.bridgeEvent('im.message.receive_v1', data);
      },
      'card.action.trigger': async (data: RawLarkEvent) => {
        await this.bridgeEvent('card.action.trigger', data);
      },
    });

    // Create the WSClient with app credentials
    this.wsClient = new WSClient({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
    });

    console.log('[WsGateway] Starting WebSocket long connection to Feishu...');

    // Start the connection — this is non-blocking, reconnects automatically
    await this.wsClient.start({ eventDispatcher: larkDispatcher });

    console.log('[WsGateway] WebSocket connection established');
  }

  /**
   * Stop the WebSocket connection.
   */
  async stop(): Promise<void> {
    if (this.wsClient) {
      await this.wsClient.disconnect();
      this.wsClient = null;
      console.log('[WsGateway] WebSocket connection closed');
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Bridge a raw Lark SDK event into our internal EventDispatcher format.
   *
   * The Lark SDK flattens the event: it merges event.event fields directly
   * into the top-level data object passed to handlers. So data already IS
   * the event payload (message, sender, etc.) plus header fields.
   *
   * We reconstruct the FeishuEvent envelope our EventDispatcher expects:
   *   { header: { event_type, ... }, event: { message, sender, action, ... } }
   */
  private async bridgeEvent(eventType: string, data: RawLarkEvent): Promise<void> {
    try {
      // The SDK merges event.event into the top-level data, so data contains
      // both header fields and the actual event payload (message, sender, etc.)
      const { header, ...eventPayload } = data;

      const feishuEvent = {
        schema: '2.0',
        header: {
          event_id: (header as any)?.event_id ?? '',
          event_type: eventType,
          create_time: (header as any)?.create_time ?? new Date().toISOString(),
          token: (header as any)?.token ?? '',
          app_id: (header as any)?.app_id ?? '',
        },
        // eventPayload contains: message, sender, action, etc.
        event: eventPayload,
      };

      console.log(`[WsGateway] Received event: ${eventType}`, JSON.stringify(feishuEvent.event, null, 2));

      await this.dispatcher.dispatch(feishuEvent as any);
    } catch (err) {
      console.error(`[WsGateway] Error dispatching event ${eventType}:`, err);
    }
  }
}
