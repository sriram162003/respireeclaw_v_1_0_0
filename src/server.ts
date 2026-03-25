import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createChildLogger } from './logger.js';
import {
  loadConfig, loadAgents, AURA_DIR, WORKSPACE_DIR,
} from './config/loader.js';
import { LLMRouter } from './llm/router.js';
import { ContextBuilder, lookupSender } from './llm/context.js';
import { AgentRegistry, watchAgents } from './agents/registry.js';
import { MemoryManager } from './memory/manager.js';
import { MemoryExtractor } from './memory/extractor.js';
import { SkillsEngine } from './skills/engine.js';
import { createSelfWriteTool } from './skills/self_write.js';
import { AgentOrchestrator } from './agents/orchestrator.js';
import { ChannelManager } from './channels/manager.js';
import { CanvasRenderer } from './canvas/renderer.js';
import { CanvasServer } from './canvas/server.js';
import { RestAPI, type HeartbeatLogEntry, type TokenStats, type TokenCallEntry } from './api/rest.js';
import { SchedulerEngine } from './scheduler/engine.js';
import { HeartbeatRunner } from './scheduler/heartbeat.js';
import { ProactiveTools } from './scheduler/proactive.js';
import { RateLimiter } from './security/rate_limiter.js';
import { audit } from './security/audit.js';
import { scanSecrets } from './security/secret_scanner.js';
import { initDefaultKey } from './security/auth.js';

import { TelegramAdapter } from './channels/telegram.js';
import { WhatsAppAdapter } from './channels/whatsapp.js';
import { SignalAdapter }   from './channels/signal.js';
import { SlackAdapter }    from './channels/slack.js';
import { DiscordAdapter }  from './channels/discord.js';
import { GoogleChatAdapter } from './channels/google_chat.js';
import { TeamsAdapter }    from './channels/teams.js';
import { WebChatAdapter }  from './channels/webchat.js';

import type { GatewayEvent, UtterancePayload } from './channels/types.js';
import type { LLMMessage, ToolCall } from './llm/types.js';
import type { SkillContext } from './skills/types.js';
import type { CanvasBlock } from './canvas/types.js';
import type { SelfWriteArgs } from './skills/self_write.js';

const MAX_TOOL_ITERATIONS = 25;
const START_TIME = Date.now();

const log = createChildLogger('server');

const tokenStats: TokenStats = { total_input: 0, total_output: 0, calls: [] };

// ── Skills node_modules symlink ───────────────────────────────────────────────
// Skills live in ~/.aura/skills/ which has no node_modules.
// We symlink the gateway's node_modules there so skills can `import 'better-sqlite3'` etc.
function ensureSkillsNodeModules(): void {
  const gatewayDir  = path.dirname(fileURLToPath(import.meta.url));
  const gatewayRoot = path.resolve(gatewayDir, '..'); // src/../ = gateway/
  const gwModules   = path.join(gatewayRoot, 'node_modules');
  const skillsDir   = path.join(os.homedir(), '.aura', 'skills');
  const skillsMods  = path.join(skillsDir, 'node_modules');

  if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true });

  // Already a correct symlink → nothing to do
  if (fs.existsSync(skillsMods)) {
    try {
      if (fs.lstatSync(skillsMods).isSymbolicLink() && fs.realpathSync(skillsMods) === fs.realpathSync(gwModules)) return;
      // Wrong target or not a symlink — remove and recreate
      fs.rmSync(skillsMods, { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  try {
    fs.symlinkSync(gwModules, skillsMods, 'dir');
    log.info('Linked gateway node_modules');
  } catch (err) {
    log.warn({ err }, 'Could not symlink node_modules');
  }
}

async function main(): Promise<void> {
  initDefaultKey();
  const config = loadConfig();
  const agents = loadAgents();

  // ── Registries & core services ──────────────────────────────────────────
  const agentRegistry = new AgentRegistry();
  agentRegistry.load(agents);

  const memory = new MemoryManager(config);
  await memory.init();

  const llm = new LLMRouter(config);

  // ── Live config reload (no restart needed) ────────────────────────────────
  // Watch ~/.aura/config.yaml — any save reloads LLM routing/model immediately.
  const configPath = path.join(os.homedir(), '.aura', 'config.yaml');
  let reloadDebounce: ReturnType<typeof setTimeout> | null = null;
  fs.watch(configPath, () => {
    // Debounce: editors write files in multiple events; wait 300ms for them to settle
    if (reloadDebounce) clearTimeout(reloadDebounce);
    reloadDebounce = setTimeout(() => {
      try {
        const newConfig = loadConfig();
        llm.reload(newConfig);
      } catch (err) {
        log.error({ err }, 'Config reload failed');
      }
    }, 300);
  });
  log.info({ path: configPath }, 'Watching for live LLM changes');

  const rateLimiter = new RateLimiter(20, 60_000);
  // Cleanup stale rate limit buckets and sessions every 10 minutes
  setInterval(() => { rateLimiter.cleanup(); memory.cleanupSessions(); }, 600_000);
  const extractor = new MemoryExtractor(llm, memory);
  const contextBuilder = new ContextBuilder();
  // Ensure the agent's sandboxed workspace exists
  if (!fs.existsSync(WORKSPACE_DIR)) fs.mkdirSync(WORKSPACE_DIR, { recursive: true, mode: 0o755 });

  ensureSkillsNodeModules();
  const skills = new SkillsEngine();
  await skills.load();
  skills.watchSkillsDir();

  const defaultAgent  = agentRegistry.getAll()[0];
  const orchestrator  = new AgentOrchestrator(llm, skills, {
    memory:       { search: (ns, q) => memory.search(ns, q) },
    readProfile:  (ns) => memory.readProfile(ns),
    readSelf:     (ns) => memory.readSelf(ns),
    userLookup:   (nodeId) => lookupSender(nodeId),
    channel:      { send: (nodeId, text) => channels.send(nodeId, text) },
    agentName:    defaultAgent?.name ?? 'the gateway',
    defaultMemNs: defaultAgent?.memory_ns ?? 'default',
  });

  // ── Canvas ────────────────────────────────────────────────────────────────
  const canvasRenderer = new CanvasRenderer();
  const canvasServer = new CanvasServer(canvasRenderer, config);
  if (config.canvas.enabled) await canvasServer.start();

  // ── Channel Manager ───────────────────────────────────────────────────────
  const webchatAdapter = new WebChatAdapter();
  webchatAdapter.setMeta(
    config.canvas.port            ?? 3001,
    config.security.rest_port     ?? 3002,
    agents[0]?.name              ?? config.agent.name ?? 'RespireeClaw',
    config.security.bind_address  ?? '0.0.0.0',
  );

  const channels = new ChannelManager();
  await channels.init(config, {
    telegram:    new TelegramAdapter(),
    whatsapp:    new WhatsAppAdapter(),
    signal:      new SignalAdapter(),
    slack:       new SlackAdapter(),
    discord:     new DiscordAdapter(),
    google_chat: new GoogleChatAdapter(),
    teams:       new TeamsAdapter(),
    webchat:     webchatAdapter,
  });

  // ── Proactive / cross-channel send tools ─────────────────────────────────
  const proactiveTools = new ProactiveTools(channels, agentRegistry);

  // ── Self-write tool ───────────────────────────────────────────────────────
  const selfWriteTool = createSelfWriteTool((params) => llm.complete('complex', params));

  // Canvas tool definitions
  const canvasToolDefs = [
    {
      name: 'canvas_clear',
      description: 'Clear all blocks from the live canvas.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'canvas_append',
      description: 'Append a block to the live canvas.',
      parameters: {
        type: 'object',
        properties: {
          type:    { type: 'string', description: 'Block type: text|code|table|image|chart|embed' },
          content: { type: 'string', description: 'Text or code content (for text/code blocks)' },
          language: { type: 'string', description: 'Language for code blocks' },
        },
        required: ['type'],
      },
    },
    {
      name: 'canvas_update',
      description: 'Update an existing canvas block by id.',
      parameters: {
        type: 'object',
        properties: {
          id:      { type: 'string', description: 'Block id to update' },
          content: { type: 'string', description: 'New content' },
        },
        required: ['id'],
      },
    },
    {
      name: 'canvas_delete',
      description: 'Delete a canvas block by id.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Block id to delete' },
        },
        required: ['id'],
      },
    },
  ];

  // Send-file tool — lets the agent send workspace files back to the user as attachments
  const sendFileToolDef = {
    name: 'send_file',
    description: 'Send a file from the workspace back to the user as a media attachment (image, audio, video, or document). Use after workspace_write to share a generated or processed file. The file must be at the workspace root level (not in a subdirectory).',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Filename at the workspace root (e.g. "report.pdf", "photo.png")' },
        caption:  { type: 'string', description: 'Optional caption or description to show with the file' },
      },
      required: ['filename'],
    },
  };

  // Memory tool definitions — allow the agent to explicitly save facts
  const memoryToolDefs = [
    {
      name: 'remember_about_user',
      description: 'Save a specific fact or note about the user to long-term memory. Use this when the user tells you something worth remembering permanently.',
      parameters: {
        type: 'object',
        properties: {
          fact: { type: 'string', description: 'The fact to remember about the user' },
        },
        required: ['fact'],
      },
    },
    {
      name: 'remember_about_self',
      description: 'Save something you learned about yourself — a correction, a preference the user expressed, or a lesson from this conversation.',
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'The self-knowledge note to save' },
        },
        required: ['note'],
      },
    },
    {
      name: 'consolidate_memory',
      description: 'Deduplicate and reorganise the long-term memory profiles, merging redundant facts.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  ];

  // ── Agent config hot-reload ───────────────────────────────────────────────
  const agentsPath = path.join(AURA_DIR, 'agents.yaml');
  watchAgents(agentRegistry, agentsPath, loadAgents);

  // ── Core event loop ───────────────────────────────────────────────────────
  async function processEvent(event: GatewayEvent): Promise<void> {
    const waitSecs = rateLimiter.consume(event.node_id);
    if (waitSecs > 0) {
      audit.rateLimited(event.node_id, waitSecs);
      await sendReply(event.node_id, `⏳ Rate limit reached — please wait ${waitSecs}s before sending another message.`, null);
      return;
    }

    // Show "typing…" indicator while we work; refresh every 4 s (Telegram expires after ~5 s).
    channels.sendTyping(event.node_id).catch(() => {});
    const typingInterval = setInterval(() => {
      channels.sendTyping(event.node_id).catch(() => {});
    }, 4_000);

    try {
      await processEventInner(event);
    } finally {
      clearInterval(typingInterval);
    }
  }

  async function processEventInner(event: GatewayEvent): Promise<void> {
    const payload = event.payload as UtterancePayload;
    if (!payload?.text) return;

    // If non-image attachments are present, prepend a brief description so the LLM is aware.
    if (payload.attachments && payload.attachments.length > 0) {
      const desc = payload.attachments
        .map(a => `[${a.type}${a.filename ? ': ' + a.filename : ''}${a.mime_type ? ' (' + a.mime_type + ')' : ''}]`)
        .join(', ');
      payload.text = `${desc}\n${payload.text}`;
    }

    const agent   = agentRegistry.resolve(event.node_id);
    const tier    = payload.image_b64 ? 'vision' : agent.llm_tier;

    const shortTerm    = memory.getShortTerm(event.session_id);
    const semanticHits = await memory.search(agent.memory_ns, payload.text).catch(() => []);
    const userProfile  = memory.readProfile(agent.memory_ns);
    const selfKnowledge = memory.readSelf(agent.memory_ns);

    // Get tools from ALL enabled skills (not just agent-assigned)
    const skillToolDefs    = skills.getToolDefs([]);
    const rawTools         = [
      ...skillToolDefs,
      selfWriteTool.toolDef,
      orchestrator.getToolDef(),
      ...canvasToolDefs,
      ...memoryToolDefs,
      ...proactiveTools.getToolDefs(),
      sendFileToolDef,
    ];
    // Deduplicate by name — first definition wins (Claude rejects duplicate tool names)
    const seen = new Set<string>();
    const allTools = rawTools.filter(t => {
      if (seen.has(t.name)) { log.warn({ toolName: t.name }, 'Duplicate tool name skipped'); return false; }
      seen.add(t.name); return true;
    });

    const ctx = buildSkillContext(event, agent.memory_ns);

    // All enabled skills are available — no per-agent filtering needed
    const installedSkills = skills.listSkills()
      .filter(s => s.enabled)
      .map(s => ({ name: s.name, description: s.description }));

    const params = await contextBuilder.build({
      event, agent, shortTerm, semanticHits,
      toolDefs: allTools, config,
      userProfile, selfKnowledge,
      installedSkills,
    });

    let messages: LLMMessage[] = params.messages;
    let iterations = 0;

    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;

      audit.llmCall(event.node_id, agent.memory_ns, tier, tier);
      let response;
      try {
        response = await llm.complete(tier, {
          system:     params.system,
          messages,
          tools:      params.tools,
          max_tokens: params.max_tokens,
        });
      } catch (err) {
        log.error({ err }, 'LLM error');
        await sendReply(event.node_id, `Sorry, I encountered an error. Please try again.`, agent.voice_id);
        return;
      }

      // Accumulate token usage
      tokenStats.total_input  += response.usage.input_tokens;
      tokenStats.total_output += response.usage.output_tokens;
      tokenStats.calls.unshift({
        ts:           Date.now(),
        node_id:      event.node_id,
        tier,
        model:        response.model,
        input_tokens: response.usage.input_tokens,
        output_tokens:response.usage.output_tokens,
      } satisfies TokenCallEntry);
      if (tokenStats.calls.length > 200) tokenStats.calls.length = 200;

      if (!response.tool_calls || response.tool_calls.length === 0) {
        // Final text response
        memory.addTurn(event.session_id, agent.memory_ns, 'user', payload.text);
        memory.addTurn(event.session_id, agent.memory_ns, 'assistant', response.text);
        const { text: safeText, count } = scanSecrets(response.text);
        if (count > 0) audit.secretRedacted(event.node_id, count);
        await sendReply(event.node_id, safeText, agent.voice_id);
        // Fire-and-forget: learn from this exchange in the background
        extractor.extractAndStore(agent.memory_ns, payload.text, response.text).catch(() => {});
        return;
      }

      // Append assistant message including tool_calls so Ollama has proper context
      messages = [...messages, {
        role:       'assistant' as const,
        content:    response.text || '',
        tool_calls: response.tool_calls,
      }];

      // Execute tool calls concurrently — canvas tools run sequentially to avoid race conditions
      const SEQUENTIAL_TOOLS = new Set(['canvas_clear', 'canvas_append', 'canvas_update', 'canvas_delete']);
      const validCalls = response.tool_calls.filter(call => call.name);
      const hasSequential = validCalls.some(call => SEQUENTIAL_TOOLS.has(call.name));

      const execOne = async (call: ToolCall) => {
        audit.toolCall(event.node_id, agent.memory_ns, call.name, JSON.stringify(call.args).slice(0, 200));
        const t0 = Date.now();
        let result: unknown;
        try {
          result = await executeToolCall(call, ctx, event.session_id);
          audit.toolResult(event.node_id, call.name, true, Date.now() - t0);
          log.debug({ toolName: call.name, durationMs: Date.now() - t0 }, 'Tool executed');
        } catch (err) {
          audit.toolResult(event.node_id, call.name, false, Date.now() - t0);
          const errMsg = err instanceof Error ? err.message : String(err);
          log.error({ err: errMsg, toolName: call.name }, 'Tool call failed');
          result = `Error: ${errMsg}`;
        }
        return { role: 'tool' as const, content: JSON.stringify(result), tool_call_id: call.id };
      };

      let toolResults: { role: 'tool'; content: string; tool_call_id: string }[];
      if (hasSequential) {
        // Sequential fallback when any canvas tool is present
        toolResults = [];
        for (const call of validCalls) toolResults.push(await execOne(call));
      } else {
        // All other tools run concurrently
        toolResults = await Promise.all(validCalls.map(execOne));
      }
      messages = [...messages, ...toolResults];
    }

  log.warn({ nodeId: event.node_id, maxIterations: MAX_TOOL_ITERATIONS }, 'Max iterations reached');
    await sendReply(event.node_id, 'I\'m having trouble completing this request. Please try rephrasing.', null);
  }

  function buildSkillContext(event: GatewayEvent, memory_ns: string): SkillContext {
    return {
      node_id:    event.node_id,
      session_id: event.session_id,
      agent_id:   memory_ns,
      memory:     { search: (q) => memory.search(memory_ns, q) },
      channel:    { send: (nid, txt, attachments) => channels.send(nid, txt, attachments) },
      canvas:     {
        append: (block) => {
          const b = canvasRenderer.append(block as Omit<CanvasBlock, 'id'>);
          canvasServer.broadcast({ event: 'append', block: b });
        },
        clear: () => {
          canvasRenderer.clear();
          canvasServer.broadcast({ event: 'clear' });
        },
      },
      llm: {
        complete: async (tier: string, prompt: string, system?: string) => {
          const res = await llm.complete(tier, {
            system: system ?? '',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 1024,
          });
          return { text: res.text };
        },
      },
    };
  }

  async function executeToolCall(
    call: ToolCall,
    ctx: SkillContext,
    _session_id: string,
  ): Promise<unknown> {
    log.debug({ toolName: call.name, args: call.args }, 'Executing tool call');
    const args = call.args as Record<string, unknown>;

    // Self-write tool
    if (call.name === 'create_skill') {
      return selfWriteTool.execute(args as unknown as SelfWriteArgs, ctx);
    }

    // Spawn team tool
    if (call.name === 'spawn_team') {
      return orchestrator.spawnTeam(args, ctx.node_id, ctx);
    }

    // Memory tools
    if (call.name === 'remember_about_user') {
      memory.appendToProfile(ctx.agent_id, `- ${String(args['fact'] ?? '')}`);
      return 'Saved to user profile.';
    }
    if (call.name === 'remember_about_self') {
      memory.appendToSelf(ctx.agent_id, `- ${String(args['note'] ?? '')}`);
      return 'Saved to self-knowledge.';
    }
    if (call.name === 'consolidate_memory') {
      await extractor.consolidate(ctx.agent_id);
      return 'Memory profiles consolidated and deduplicated.';
    }

    // Canvas tools
    if (call.name === 'canvas_clear') {
      canvasRenderer.clear();
      canvasServer.broadcast({ event: 'clear' });
      return 'Canvas cleared';
    }
    if (call.name === 'canvas_append') {
      const block = canvasRenderer.append(args as Omit<CanvasBlock, 'id'>);
      canvasServer.broadcast({ event: 'append', block });
      return { id: block.id };
    }
    if (call.name === 'canvas_update') {
      const id = String(args['id'] ?? '');
      canvasRenderer.update(id, args as Partial<CanvasBlock>);
      const updated = canvasRenderer.getBlocks().find(b => b.id === id);
      if (updated) canvasServer.broadcast({ event: 'update', id, block: updated });
      return 'Updated';
    }
    if (call.name === 'canvas_delete') {
      const id = String(args['id'] ?? '');
      canvasRenderer.delete(id);
      canvasServer.broadcast({ event: 'delete', id });
      return 'Deleted';
    }

    // Send workspace file as attachment to the current user
    if (call.name === 'send_file') {
      const filename = String(args['filename'] ?? '');
      const caption  = args['caption'] ? String(args['caption']) : undefined;
      if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return { error: 'Invalid filename. Must be a top-level workspace file with no path separators.' };
      }
      const filepath = path.join(WORKSPACE_DIR, filename);
      if (!fs.existsSync(filepath)) {
        return { error: `File not found in workspace: "${filename}". Use workspace_write to create it first.` };
      }
      const ext = path.extname(filename).toLowerCase();
      const photoExts  = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']);
      const audioExts  = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']);
      const videoExts  = new Set(['.mp4', '.webm', '.mov', '.avi', '.mkv']);
      let mediaType: import('./channels/interface.js').MediaAttachment['type'] = 'document';
      if (photoExts.has(ext)) mediaType = 'photo';
      else if (audioExts.has(ext)) mediaType = 'audio';
      else if (videoExts.has(ext)) mediaType = 'video';
      await sendReply(ctx.node_id, caption, undefined, [{
        type:     mediaType,
        url:      `/uploads/${filename}`,
        caption,
        filename,
      }]);
      return { sent: true, filename, type: mediaType };
    }

    // Cross-channel / proactive send tools
    if (call.name === 'send_message') {
      return proactiveTools.send_message(args as { node_id: string; text: string });
    }
    if (call.name === 'send_to_agent_channels') {
      return proactiveTools.send_to_agent_channels(args as { agent_id: string; text: string });
    }

    // Skill tools
    return skills.execute(call.name, args, ctx);
  }

  async function sendReply(
    node_id: string,
    text: string | undefined,
    _voice_id?: string | null,
    attachments?: import('./channels/interface.js').MediaAttachment[],
  ): Promise<void> {
    await channels.send(node_id, text, attachments);
  }

  // Wire channel utterance events
  channels.onMessage((event: GatewayEvent) => {
    processEvent(event).catch(err => log.error({ err, nodeId: event.node_id }, 'Channel event error'));
  });

  // ── Heartbeat ─────────────────────────────────────────────────────────────
  const heartbeatRunner = new HeartbeatRunner(llm, agentRegistry, memory, skills, channels);
  const heartbeatLog: HeartbeatLogEntry[] = [];

  async function triggerHeartbeat(): Promise<void> {
    const start = Date.now();
    const entry = await heartbeatRunner.run();
    heartbeatLog.unshift({
      ts: entry.ts,
      result: entry.result,
      duration_ms: Date.now() - start,
    });
    if (heartbeatLog.length > 50) heartbeatLog.length = 50;
  }

  // ── Scheduler ─────────────────────────────────────────────────────────────
  const wfSkillCtx = {
    node_id: 'scheduler', session_id: 'scheduler', agent_id: 'scheduler',
    memory: { search: async () => [] },
    channel:{ send: async () => {} },
    canvas: { append: () => {}, clear: () => {} },
    llm: {
      complete: async (tier: string, prompt: string, system?: string) => {
        const res = await llm.complete(tier, {
          system: system ?? '',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1024,
        });
        return { text: res.text };
      },
    },
  };
  const workflowFireFn = async (name: string): Promise<void> => {
    await skills.execute('workflow_run', { name, payload: {}, async: true }, wfSkillCtx);
  };
  const scheduler = new SchedulerEngine(config, memory, channels, triggerHeartbeat, workflowFireFn);
  scheduler.start();

  // ── REST API ───────────────────────────────────────────────────────────────
  const restApi = new RestAPI({
    config, agentRegistry,
    skillsEngine: skills, memoryManager: memory,
    canvasRenderer, triggerHeartbeat,
    heartbeatLog, startTime: START_TIME,
    orchestrator, tokenStats,
    webchatAdapter,
  });
  await restApi.start();

  log.info('AURA Gateway started');
  log.info({ restPort: config.security.rest_port, bindAddress: config.security.bind_address }, 'REST API listening');
  if (config.canvas.enabled)
    log.info({ canvasPort: config.canvas.port }, 'Canvas WS listening');
  log.info({ agentCount: agents.length, skillCount: skills.listSkills().length }, 'Loaded agents and skills');

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'Shutting down');
    scheduler.stop();
    await restApi.stop();
    await canvasServer.stop();
    await channels.destroy();
    memory.close();
    log.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT',  () => { shutdown('SIGINT').catch(err => log.error({ err }, 'Shutdown error')); });
  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(err => log.error({ err }, 'Shutdown error')); });
}

main().catch((err) => {
  log.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
