import { WebSocketServer, WebSocket } from 'ws';
import type { GatewayConfig } from '../config/loader.js';
import type { CanvasEvent } from './types.js';
import { CanvasRenderer } from './renderer.js';
import { validateApiKey } from '../security/auth.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('canvas');

/**
 * WebSocket server for live Canvas updates on port 3001.
 * Protocol: ws://127.0.0.1:3001/canvas
 *
 * On connect: sends full current state as {event:'state', blocks:[...]}
 * On agent action: broadcasts incremental events (append/update/delete/clear)
 */
export class CanvasServer {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private renderer: CanvasRenderer;
  private config: GatewayConfig;

  constructor(renderer: CanvasRenderer, config: GatewayConfig) {
    this.renderer = renderer;
    this.config = config;

    // Broadcast on every renderer change
    renderer.onChange(() => {
      // The actual event is broadcast explicitly by callers via broadcast()
    });
  }

  async start(): Promise<void> {
    const { bind_address } = this.config.security;
    const port = this.config.canvas.port;

    this.wss = new WebSocketServer({ host: bind_address, port, path: '/canvas' });

    this.wss.on('connection', (ws, req) => {
      // Check for API key in query parameter
      const url = new URL(req.url ?? '/', 'http://localhost');
      const token = url.searchParams.get('token');
      
      if (!token) {
        ws.close(4001, 'Missing API key. Use: ws://host:3001/canvas?token=sk-aura-xxxxx');
        return;
      }

      const validated = validateApiKey(token);
      if (!validated) {
        ws.close(4001, 'Invalid API key');
        return;
      }

      this.clients.add(ws);

      // Send full state on connect
      const stateEvent: CanvasEvent = { event: 'state', blocks: this.renderer.getBlocks() };
      ws.send(JSON.stringify(stateEvent));

      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
    });

    this.wss.on('error', (err) => log.error({ err }, 'Server error'));
    log.info({ bindAddress: bind_address, port }, 'Server listening');
  }

  broadcast(event: CanvasEvent): void {
    const msg = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  async stop(): Promise<void> {
    for (const ws of this.clients) ws.close();
    this.clients.clear();
    await new Promise<void>((resolve) => this.wss?.close(() => resolve()));
    log.info('Server stopped');
  }
}
