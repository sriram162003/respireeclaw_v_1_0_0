import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';
import type { ChannelAdapter, ChannelConfig, OutboundMessage } from './interface.js';
import type { GatewayEvent, UtterancePayload, IncomingAttachment } from './types.js';
import { validateApiKey, loadKeysFile, getMasterKey } from '../security/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIR = path.join(os.homedir(), '.aura', 'workspace');

export class WebChatAdapter implements ChannelAdapter {
  readonly channel_id = 'browser';

  private server:   http.Server      | null = null;
  private wss:      WebSocketServer  | null = null;
  private sessions  = new Map<string, WebSocket>();
  private handlers: Array<(event: GatewayEvent) => void> = [];

  private canvasPort  = 3001;
  private restPort    = 3002;
  private agentName   = 'RespireeClaw';
  private bindAddress = '0.0.0.0';

  /** Inject gateway metadata before init(). */
  setMeta(canvasPort: number, restPort: number, agentName: string, bindAddress: string): void {
    // Allow external port overrides for reverse-proxy / remapped Docker ports
    this.canvasPort  = parseInt(process.env.CANVAS_EXTERNAL_PORT ?? '') || canvasPort;
    this.restPort    = parseInt(process.env.REST_EXTERNAL_PORT   ?? '') || restPort;
    this.agentName   = agentName;
    this.bindAddress = bindAddress;
  }

  async init(config: ChannelConfig): Promise<void> {
    const port = (config['port'] as number | undefined) ?? 3000;
    const host = this.bindAddress;

    // Read the HTML template and inject config values
    const htmlPath = path.join(__dirname, 'webchat.html');
    const raw = fs.readFileSync(htmlPath, 'utf8');
    const html = raw
      .replace(/__CANVAS_PORT__/g, String(this.canvasPort))
      .replace(/__REST_PORT__/g,   String(this.restPort))
      .replace(/__AGENT_NAME_JSON__/g, JSON.stringify(this.agentName))
      .replace(/__AGENT_NAME__/g, this.agentName);   // <title> tag

    // HTTP server: serve the UI at GET /
    this.server = http.createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, {
          'Content-Type':  'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.end(html);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    // WebSocket server (noServer mode so it can be shared with port 3002 via handleChatUpgrade)
    this.wss = new WebSocketServer({ noServer: true });

    // Handle upgrades on port 3000 itself (path /ws or / for backward compat)
    this.server!.on('upgrade', (req, socket, head) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (pathname === '/ws' || pathname === '/') {
        this.wss!.handleUpgrade(req, socket, head, (ws) => {
          this.wss!.emit('connection', ws, req);
        });
      } else {
        socket.destroy();
      }
    });

    this.wss.on('connection', (ws, req) => {
      // Check for API key in query parameter or header
      // Auth is optional - only required if keys exist in keys.yaml
      const url = new URL(req.url ?? '/', 'http://localhost');
      const token = url.searchParams.get('token');

      const isValidToken = (t: string): boolean => {
        return !!(validateApiKey(t) || (getMasterKey() && t === getMasterKey()));
      };

      if (token) {
        if (!isValidToken(token)) {
          ws.close(4001, 'Invalid API key');
          return;
        }
      } else {
        // Also check Authorization header
        const authHeader = req.headers.authorization;
        if (authHeader) {
          const parts = authHeader.split(' ');
          if (parts.length === 2 && parts[0]?.toLowerCase() === 'bearer') {
            if (!isValidToken(parts[1] ?? '')) {
              ws.close(4001, 'Invalid API key');
              return;
            }
          }
        }
        // No token provided - check if auth is required (keys.yaml has keys OR master key is set)
        const keys = loadKeysFile();
        if (keys.keys.length > 0 || getMasterKey()) {
          ws.close(4001, 'API key required');
          return;
        }
      }

      const node_id = `browser_${crypto.randomUUID()}`;
      const session_id = node_id; // Use node_id as session_id for persistent conversation
      this.sessions.set(node_id, ws);

      // Greet the browser with identity info
      ws.send(JSON.stringify({
        type:       'connected',
        node_id,
        session_id,
        agent_name: this.agentName,
      }));

      ws.on('message', async (data: Buffer) => {
        try {
          const msg  = JSON.parse(data.toString()) as Record<string, unknown>;
          const text = msg['text'] as string | undefined;
          const files = msg['files'] as Array<{ name: string; type: string; data: string }> | undefined;
          
          const imageFiles = files ? files.filter(f => f.type.startsWith('image/')) : [];
          const docFiles   = files ? files.filter(f => !f.type.startsWith('image/') && !f.type.startsWith('audio/') && !f.type.startsWith('video/')) : [];
          const hasImage = imageFiles.length > 0;
          const hasDoc   = docFiles.length > 0;
          if (!text && !hasImage && !hasDoc) return;

          // Build fallback text label — include doc content for text-based files
          const TEXT_MIME = new Set(['text/plain','text/markdown','text/csv','text/html','text/xml','application/json','application/xml']);
          const isTextFile = (f: { type: string; name: string }) =>
            TEXT_MIME.has(f.type) || f.name.endsWith('.md') || f.name.endsWith('.txt') || f.name.endsWith('.csv') || f.name.endsWith('.json');

          let fallbackText = text || '';
          if (!text && hasImage) fallbackText = imageFiles.length === 1 ? '[Image attached]' : `[${imageFiles.length} images attached]`;
          if (!text && hasDoc)   fallbackText = docFiles.length === 1 ? `[File attached: ${docFiles[0]!.name}]` : `[${docFiles.length} files attached]`;

          // Inject readable text-file contents so the LLM can actually see them
          for (const f of docFiles) {
            if (isTextFile(f)) {
              const content = Buffer.from(f.data, 'base64').toString('utf8');
              fallbackText += `\n\n--- ${f.name} ---\n${content}`;
            } else if (f.name.endsWith('.docx') || f.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
              try {
                const mammoth = await import('mammoth');
                const buffer = Buffer.from(f.data, 'base64');
                const result = await mammoth.extractRawText({ buffer });
                fallbackText += `\n\n--- ${f.name} ---\n${result.value}`;
              } catch (err) {
                fallbackText += `\n\n--- ${f.name} ---\n[Could not extract text: ${String(err)}]`;
              }
            }
          }

          const payload: UtterancePayload = {
            text: fallbackText,
            routing_hint: hasImage ? 'vision' : 'simple'
          };

          if (hasImage) {
            // Send all images — first one goes in image_b64 for backward compat, all in images_b64
            payload.image_b64  = imageFiles[0]!.data;
            payload.images_b64 = imageFiles.map(f => f.data);
          }
          
          if (files && files.length > 0) {
            if (!fs.existsSync(WORKSPACE_DIR)) {
              fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
            }
            
            payload.attachments = files.map(f => {
              let attType: 'document' | 'audio' | 'video' | 'voice' | 'sticker' = 'document';
              if (f.type.startsWith('image/')) attType = 'document';
              else if (f.type.startsWith('audio/')) attType = 'audio';
              else if (f.type.startsWith('video/')) attType = 'video';
              
              const ext = path.extname(f.name) || '.bin';
              const baseName = path.basename(f.name, ext);
              const safeName = `${baseName}_${Date.now()}${ext}`;
              const filePath = path.join(WORKSPACE_DIR, safeName);
              
              const buffer = Buffer.from(f.data, 'base64');
              fs.writeFileSync(filePath, buffer);
              
              return {
                type: attType,
                filename: f.name,
                mime_type: f.type,
                file_path: filePath,
              } as IncomingAttachment & { file_path: string };
            });
          }

          const event: GatewayEvent = {
            type:      'event',
            event:     'utterance',
            node_id,
            session_id,
            ts:        Date.now(),
            payload,
          };
          for (const h of this.handlers) h(event);
        } catch (err) {
          console.error('[WebChat] Malformed message received:', err);
        }
      });

      ws.on('close', () => this.sessions.delete(node_id));
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, host, () => resolve());
      this.server!.once('error', reject);
    });

    console.log(`[WebChat] UI ready → http://${host}:${port}`);
  }

  /** Forward a WebSocket upgrade from another HTTP server (e.g. port 3002) to this chat WSS. */
  handleChatUpgrade(req: http.IncomingMessage, socket: import('stream').Duplex, head: Buffer): void {
    this.wss?.handleUpgrade(req, socket, head, (ws) => {
      this.wss?.emit('connection', ws, req);
    });
  }

  onMessage(handler: (event: GatewayEvent) => void): void {
    this.handlers.push(handler);
  }

  async send(message: OutboundMessage): Promise<void> {
    const ws = this.sessions.get(message.node_id);
    if (ws?.readyState === WebSocket.OPEN) {
      const payload: Record<string, unknown> = { type: 'message', text: message.text };
      
      if (message.attachments && message.attachments.length > 0) {
        payload.attachments = message.attachments.map(att => ({
          type: att.type,
          url: att.url,
          caption: att.caption,
          filename: att.filename,
        }));
      }
      
      ws.send(JSON.stringify(payload));
    }
  }

  async isHealthy(): Promise<boolean> {
    return this.server !== null;
  }

  async destroy(): Promise<void> {
    for (const ws of this.sessions.values()) ws.close();
    this.sessions.clear();
    this.wss?.close();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
