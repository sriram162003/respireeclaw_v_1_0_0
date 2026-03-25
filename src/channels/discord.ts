import type { ChannelAdapter, ChannelConfig, OutboundMessage } from './interface.js';
import type { GatewayEvent, IncomingAttachment, UtterancePayload } from './types.js';
import os from 'os';
import path from 'path';
import fs from 'fs';

const WORKSPACE_DIR = path.join(os.homedir(), '.aura', 'workspace');

export class DiscordAdapter implements ChannelAdapter {
  readonly channel_id = 'discord';
  private client: unknown = null;
  private handlers: Array<(event: GatewayEvent) => void> = [];

  async init(config: ChannelConfig): Promise<void> {
    const token = config['token'] as string | undefined;
    if (!token) throw new Error('Discord token required');

    const { Client, GatewayIntentBits } = await import('discord.js');
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessages],
    });
    this.client = client;

    (client as unknown as { on(e: string, h: (m: unknown) => void): void }).on('messageCreate', async (rawMsg: unknown) => {
      const message = rawMsg as Record<string, unknown>;
      if ((message['author'] as Record<string, unknown>)?.['bot']) return;
      const author = message['author'] as Record<string, unknown>;
      const userId = String(author['id'] ?? '');
      const content = String(message['content'] ?? '');
      if (!userId || (!content && !(message['attachments'] as unknown[])?.length)) return;

      const node_id = `discord_${userId}`;

      try {
        const payload = await this.handleIncomingMessage(message);
        const event: GatewayEvent = {
          type: 'event', event: 'utterance',
          node_id, session_id: node_id,
          ts: Date.now(),
          payload,
        };
        for (const h of this.handlers) h(event);
      } catch (err) {
        console.error('[Discord] Error handling message:', err);
      }
    });

    await client.login(token);
    console.log('[Discord] Bot logged in');
  }

  private async handleIncomingMessage(message: Record<string, unknown>): Promise<UtterancePayload> {
    const content = String(message['content'] ?? '');
    const attachments = message['attachments'] as Array<Record<string, unknown>> | undefined;

    if (!attachments || attachments.length === 0) {
      return { text: content, routing_hint: 'complex' };
    }

    const incomingAttachments: IncomingAttachment[] = [];
    let imageB64: string | undefined;

    for (const att of attachments) {
      const url = att['url'] as string;
      const filename = att['filename'] as string;
      const contentType = att['content_type'] as string | undefined;
      const isImage = contentType?.startsWith('image/') ?? false;

      if (isImage && !imageB64) {
        try {
          const res = await fetch(url);
          if (!res.ok) {
            console.error(`[Discord] Failed to download image: HTTP ${res.status} ${res.statusText}`);
          } else {
            const buf = await res.arrayBuffer();
            imageB64 = Buffer.from(buf).toString('base64');
          }
        } catch (err) {
          console.error('[Discord] Failed to download image:', err);
        }
      } else {
        let savedPath: string | undefined;
        if (url) {
          try {
            if (!fs.existsSync(WORKSPACE_DIR)) {
              fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
            }
            const res = await fetch(url);
            if (!res.ok) {
              console.error(`[Discord] Failed to download attachment: HTTP ${res.status} ${res.statusText}`);
            } else {
              const buf = await res.arrayBuffer();
              savedPath = path.join(WORKSPACE_DIR, filename);
              fs.writeFileSync(savedPath, Buffer.from(buf));
              console.log(`[Discord] Saved attachment → ${savedPath}`);
            }
          } catch (err) {
            console.error('[Discord] Failed to download attachment:', err);
          }
        }

        incomingAttachments.push({
          type: 'document',
          filename,
          mime_type: contentType,
        });
      }
    }

    const locationHint = incomingAttachments.length > 0
      ? `\nAttachments saved to workspace.`
      : '';

    return {
      text: (content || 'User sent an image/file') + locationHint,
      image_b64: imageB64 ?? null,
      attachments: incomingAttachments.length > 0 ? incomingAttachments : undefined,
      routing_hint: imageB64 ? 'vision' : 'complex',
    };
  }

  onMessage(handler: (event: GatewayEvent) => void): void {
    this.handlers.push(handler);
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.client) return;
    const userId = message.node_id.replace('discord_', '');
    const dcClient = this.client as {
      users: {
        fetch: (id: string) => Promise<{
          send: (options: string | unknown) => Promise<unknown>;
        }>;
      };
    };

    const user = await dcClient.users.fetch(userId);

    for (const att of message.attachments ?? []) {
      try {
        let url = att.url;
        let buffer: Buffer;

        if (url.startsWith('data:')) {
          const matches = url.match(/^data:[^;]+;base64,(.+)$/);
          if (matches) {
            buffer = Buffer.from(matches[1], 'base64');
          } else {
            continue;
          }
        } else if (url.startsWith('http://') || url.startsWith('https://')) {
          const res = await fetch(url);
          const arr = await res.arrayBuffer();
          buffer = Buffer.from(arr);
        } else {
          if (!fs.existsSync(url)) {
            console.error(`[Discord] File not found: ${url}`);
            continue;
          }
          buffer = fs.readFileSync(url);
        }

        const { AttachmentBuilder } = await import('discord.js');
        const attachment = new AttachmentBuilder(buffer, { name: att.filename });
        await user.send({ content: message.text || att.caption, files: [attachment] });
        console.log(`[Discord] Sent ${att.type}: ${att.filename}`);
      } catch (err) {
        console.error('[Discord] Failed to send attachment:', err);
      }
    }

    if (message.text && (!message.attachments || message.attachments.length === 0)) {
      await user.send(message.text);
    }
  }

  async isHealthy(): Promise<boolean> { return this.client !== null; }
  async destroy(): Promise<void> {
    await (this.client as { destroy?: () => Promise<void> })?.destroy?.();
    this.client = null;
  }
}
