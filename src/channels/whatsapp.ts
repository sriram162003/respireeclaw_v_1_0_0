import type { ChannelAdapter, ChannelConfig, OutboundMessage } from './interface.js';
import type { GatewayEvent, IncomingAttachment, UtterancePayload } from './types.js';
import os from 'os';
import path from 'path';
import fs from 'fs';

const WORKSPACE_DIR = path.join(os.homedir(), '.aura', 'workspace');

export class WhatsAppAdapter implements ChannelAdapter {
  readonly channel_id = 'whatsapp';
  private client: unknown = null;
  private handlers: Array<(event: GatewayEvent) => void> = [];

  async init(_config: ChannelConfig): Promise<void> {
    const { Client, LocalAuth } = await import('whatsapp-web.js');
    const client = new Client({
      authStrategy: new LocalAuth({ dataPath: path.join(os.homedir(), '.aura', 'tokens', 'whatsapp') }),
      puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] },
    });
    this.client = client;

    client.on('qr', (qr: string) => {
      console.log('[WhatsApp] QR Code (scan to authenticate):');
      console.log(qr);
    });

    client.on('ready', () => console.log('[WhatsApp] Client ready'));

    client.on('message', async (msg: Record<string, unknown>) => {
      if (msg['fromMe']) return;
      const from = String(msg['from'] ?? '').replace('@c.us', '');
      if (!from) return;

      const node_id = `whatsapp_${from}`;

      try {
        const payload = await this.handleIncomingMessage(msg);
        const event: GatewayEvent = {
          type: 'event', event: 'utterance',
          node_id, session_id: node_id,
          ts: Date.now(),
          payload,
        };
        for (const h of this.handlers) h(event);
      } catch (err) {
        console.error('[WhatsApp] Error handling message:', err);
      }
    });

    await client.initialize();
  }

  private async handleIncomingMessage(msg: Record<string, unknown>): Promise<UtterancePayload> {
    const hasMedia = msg['hasMedia'] as boolean;

    if (!hasMedia) {
      const body = String(msg['body'] ?? '');
      return { text: body, routing_hint: 'simple' };
    }

    const mimeType = msg['mimetype'] as string || '';
    const isImage = mimeType.startsWith('image/');
    const isAudio = mimeType.startsWith('audio/');
    const isVideo = mimeType.startsWith('video/');

    let attachment: IncomingAttachment | undefined;
    let savedPath: string | undefined;
    let imageB64: string | undefined;

    try {
      const downloadMedia = msg['downloadMedia'] as () => Promise<Record<string, unknown>>;
      const media = await downloadMedia.call(msg);
      const data = media['data'] as string;
      const filename = media['filename'] as string | undefined;

      if (!fs.existsSync(WORKSPACE_DIR)) {
        fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
      }

      const ext = this.getExtensionFromMime(mimeType);
      const baseName = filename ? path.parse(filename).name : `whatsapp_${Date.now()}`;
      savedPath = path.join(WORKSPACE_DIR, `${baseName}${ext}`);

      if (!data) {
        console.error('[WhatsApp] No media data received');
      } else {
        const buffer = Buffer.from(data, 'base64');
        fs.writeFileSync(savedPath, buffer);
        console.log(`[WhatsApp] Saved media → ${savedPath}`);
      }

      if (isImage) {
        imageB64 = data;
        attachment = {
          type: 'document',
          filename: filename || `${baseName}${ext}`,
          mime_type: mimeType,
        };
      } else {
        attachment = {
          type: this.getAttachmentType(mimeType),
          filename: filename || `${baseName}${ext}`,
          mime_type: mimeType,
        };
      }
    } catch (err) {
      console.error('[WhatsApp] Failed to download media:', err);
    }

    const body = String(msg['body'] ?? '');
    const locationHint = savedPath
      ? `\nThe file has been saved to your workspace at: ${savedPath}`
      : '';

    return {
      text: (body || `User sent a ${isImage ? 'image' : isAudio ? 'audio' : isVideo ? 'video' : 'file'}`) + locationHint,
      image_b64: imageB64 ?? null,
      attachments: attachment ? [attachment] : undefined,
      routing_hint: isImage ? 'vision' : 'complex',
    };
  }

  private getExtensionFromMime(mimeType: string): string {
    const map: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'audio/ogg': '.ogg',
      'audio/mpeg': '.mp3',
      'audio/wav': '.wav',
      'video/mp4': '.mp4',
      'video/webm': '.webm',
      'application/pdf': '.pdf',
    };
    return map[mimeType] || '';
  }

  private getAttachmentType(mimeType: string): IncomingAttachment['type'] {
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
    return 'document';
  }

  onMessage(handler: (event: GatewayEvent) => void): void {
    this.handlers.push(handler);
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.client) return;
    const phone = message.node_id.replace('whatsapp_', '');
    const chatId = `${phone}@c.us`;

    const { MessageMedia } = await import('whatsapp-web.js');
    const waClient = this.client as {
      sendMessage: (to: string, content: string | unknown, options?: unknown) => Promise<unknown>;
    };

    for (const att of message.attachments ?? []) {
      try {
        let media: InstanceType<typeof MessageMedia>;

        if (att.url.startsWith('data:') || att.url.startsWith('http://') || att.url.startsWith('https://')) {
          let url = att.url;
          let mimeType = att.filename ? this.getMimeFromFilename(att.filename) : 'application/octet-stream';

          if (att.url.startsWith('data:')) {
            const matches = att.url.match(/^data:([^;]+);base64,(.+)$/);
            if (matches) {
              mimeType = matches[1];
              url = matches[2];
            }
          }

          media = new MessageMedia(mimeType, url, att.filename);
        } else {
          if (!fs.existsSync(att.url)) {
            console.error(`[WhatsApp] File not found: ${att.url}`);
            continue;
          }
          const fileData = fs.readFileSync(att.url);
          const base64 = fileData.toString('base64');
          const mimeType = att.filename ? this.getMimeFromFilename(att.filename) : 'application/octet-stream';
          media = new MessageMedia(mimeType, base64, att.filename);
        }

        const options: { caption?: string } = {};
        if (att.caption) {
          options.caption = att.caption;
        }

        await waClient.sendMessage(chatId, media, options);
        console.log(`[WhatsApp] Sent ${att.type}: ${att.filename || att.caption}`);
      } catch (err) {
        console.error('[WhatsApp] Failed to send attachment:', err);
      }
    }

    const text = message.text?.trim();
    if (text) {
      await waClient.sendMessage(chatId, text);
    }
  }

  private getMimeFromFilename(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const map: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.mp3': 'audio/mpeg',
      '.ogg': 'audio/ogg',
      '.wav': 'audio/wav',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.pdf': 'application/pdf',
    };
    return map[ext] || 'application/octet-stream';
  }

  async isHealthy(): Promise<boolean> { return this.client !== null; }
  async destroy(): Promise<void> {
    const client = this.client as { destroy?: () => Promise<void> };
    await client?.destroy?.();
    this.client = null;
  }
}
