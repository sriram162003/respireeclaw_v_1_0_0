import http from 'http';
import type { ChannelAdapter, ChannelConfig, OutboundMessage } from './interface.js';
import type { GatewayEvent } from './types.js';

type BotAdapter = {
  processActivity: (
    req: http.IncomingMessage,
    res: ExpressLikeResponse,
    handler: (ctx: Record<string, unknown>) => Promise<void>
  ) => Promise<void>;
  continueConversation: (ref: unknown, handler: (ctx: Record<string, unknown>) => Promise<void>) => Promise<void>;
};

// BotFrameworkAdapter expects Express-style res.status(code).send(body)
// Wrap Node's http.ServerResponse to match that interface.
interface ExpressLikeResponse {
  status(code: number): this;
  send(body?: unknown): this;
  end(): this;
}

function toExpressRes(res: http.ServerResponse): ExpressLikeResponse {
  let statusCode = 200;
  const obj: ExpressLikeResponse = {
    status(code) { statusCode = code; return obj; },
    send(body?) {
      const payload = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(payload);
      return obj;
    },
    end() { res.writeHead(statusCode); res.end(); return obj; },
  };
  return obj;
}

export class TeamsAdapter implements ChannelAdapter {
  readonly channel_id = 'teams';
  private adapter: BotAdapter | null = null;
  private handlers: Array<(event: GatewayEvent) => void> = [];
  // Stores conversation references keyed by node_id so we can reply
  private convRefs = new Map<string, unknown>();

  async init(config: ChannelConfig): Promise<void> {
    const appId     = config['app_id']     as string | undefined ?? process.env['TEAMS_APP_ID'];
    const appSecret = config['app_secret'] as string | undefined ?? process.env['TEAMS_APP_SECRET'];

    if (!appId || !appSecret) throw new Error('Teams app_id and app_secret required');

    const { BotFrameworkAdapter } = await import('botbuilder');
    this.adapter = new BotFrameworkAdapter({ appId, appPassword: appSecret }) as unknown as BotAdapter;

    console.log('[Teams] Bot Framework adapter ready — webhook at POST /microsoft-teams on port 3002');
  }

  /** Called by the REST API server for POST /microsoft-teams requests. */
  processRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.adapter) { res.writeHead(503).end(); return; }

    this.adapter.processActivity(req, toExpressRes(res), async (ctx) => {
      const activity = ctx['activity'] as Record<string, unknown> | undefined;
      if (!activity || activity['type'] !== 'message') return;

      const convId = String(
        (activity['conversation'] as Record<string, unknown> | undefined)?.['id'] ?? ''
      );
      const text = String(activity['text'] ?? '').trim();
      if (!convId || !text) return;

      const node_id = `teams_${convId}`;

      // Store conversation reference so send() can reply
      const { TurnContext } = await import('botbuilder');
      this.convRefs.set(node_id, TurnContext.getConversationReference(activity));

      const event: GatewayEvent = {
        type: 'event', event: 'utterance',
        node_id, session_id: node_id,
        ts: Date.now(),
        payload: { text, routing_hint: 'complex' },
      };
      for (const h of this.handlers) h(event);
    }).catch((err: unknown) => console.error('[Teams] processActivity error:', err));
  }

  onMessage(handler: (event: GatewayEvent) => void): void {
    this.handlers.push(handler);
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.adapter) return;
    const ref = this.convRefs.get(message.node_id);
    if (!ref) {
      console.warn(`[Teams] No conversation reference for ${message.node_id} — cannot reply`);
      return;
    }
    const { MessageFactory } = await import('botbuilder');
    await this.adapter.continueConversation(ref, async (ctx) => {
      await (ctx['sendActivity'] as (a: unknown) => Promise<void>)(
        MessageFactory.text(message.text ?? '')
      );
    });
  }

  async isHealthy(): Promise<boolean> {
    return this.adapter !== null;
  }

  async destroy(): Promise<void> {
    this.convRefs.clear();
    this.adapter = null;
  }
}
