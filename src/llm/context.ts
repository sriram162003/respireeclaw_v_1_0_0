import fs from 'fs';
import path from 'path';
import os from 'os';
import type { GatewayEvent } from '../channels/types.js';
import type { AgentConfig } from '../agents/types.js';
import type { LLMMessage, LLMParams, ToolDefinition } from './types.js';
import type { GatewayConfig } from '../config/loader.js';
import { readTodos, formatTodosForPrompt } from '../skills/todo.js';

const CONTACTS_FILE = path.join(os.homedir(), '.aura', 'workspace', 'contacts.md');

/** Look up a sender name from contacts.md by node_id or chat_id. Returns null if not found. */
export function lookupSender(nodeId: string): { name: string; notes?: string } | null {
  try {
    if (!fs.existsSync(CONTACTS_FILE)) return null;
    const chatId = nodeId.replace(/^[a-z_]+_/, ''); // e.g. telegram_1012325503 → 1012325503
    for (const line of fs.readFileSync(CONTACTS_FILE, 'utf8').split('\n')) {
      // Match markdown table rows: | Name | chat_id | node_id | ... |
      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length < 3) continue;
      if (cols[2] === nodeId || cols[1] === chatId) {
        return { name: cols[0]!, notes: cols[4] ?? undefined };
      }
    }
  } catch { /* non-fatal */ }
  return null;
}

const MAX_MESSAGES = 120;

/** Estimate a reasonable max_tokens based on query length and content. */
function estimateMaxTokens(text: string): number {
  const lower = text.toLowerCase().trim();
  // Trivial greetings / ack → tiny budget
  if (/^(hi|hello|hey|thanks|thank you|ok|okay|sure|yes|no|bye|good morning|good night)\b/.test(lower) && text.length < 60) return 256;
  // Heavy tasks → full budget (check before length so short "write X" queries get full budget)
  if (/write|create|generate|explain|analyze|analyse|summarize|summarise|list all|code|script|report|implement|build/.test(lower)) return 8192;
  if (text.length < 200) return 1024;
  if (text.length < 500) return 2048;
  return 4096;
}

export interface ContextBuildParams {
  event:        GatewayEvent;
  agent:        AgentConfig;
  shortTerm:    LLMMessage[];
  semanticHits: string[];
  toolDefs:     ToolDefinition[];
  config:       GatewayConfig;
  userProfile:  string;
  selfKnowledge: string;
  /** Names of installed skills so the agent can refer to them by name. */
  installedSkills?: Array<{ name: string; description: string }>;
}

/**
 * Assembles the LLM system prompt, message history, and tool definitions
 * for a given Gateway event and agent configuration.
 */
export class ContextBuilder {
  async build(params: ContextBuildParams): Promise<LLMParams> {
    const { event, agent, shortTerm, semanticHits, toolDefs, config, userProfile, selfKnowledge, installedSkills } = params;

    const now = new Date().toISOString();

    // ── STATIC BLOCK (cacheable) ─────────────────────────────────────────────
    // Changes only when agent config or tool list changes.
    let staticPart = agent.persona.trim();

    // Hard identity rule — prevent the model from describing itself as the
    // underlying LLM when asked "what are you" or "what can you do".
    staticPart += `\n\nYour name is ${agent.name}. You are a personal AI assistant.`;

    // ── Capabilities summary ──────────────────────────────────────────────────
    // Build from the actual loaded tool definitions so this always stays in sync.
    // Canvas internals are excluded from the narrative; everything else is shown.
    const nonInternalTools = toolDefs.filter(
      t => !['canvas_clear','canvas_append','canvas_update','canvas_delete'].includes(t.name)
    );

    if (nonInternalTools.length > 0) {
      // List actual tools with descriptions so the agent knows what it can do
      const toolList = nonInternalTools.map(t => `  - ${t.name}: ${t.description}`).join('\n');
      staticPart += `\n\nAVAILABLE TOOLS:\n${toolList}`;
      staticPart += `\n\nWhen tool calls don't depend on each other, call all of them together in one response. Prefer direct parallel tool calls over spawn_agent_team — only use spawn_agent_team when a task genuinely requires coordinating many subtasks across multiple instances or regions simultaneously. For simple queries (e.g. list instances, check status, describe a single resource), call the appropriate tool directly instead of wrapping it in spawn_agent_team. Only call sequentially when a tool needs the result of a previous one.`;
    }

    // ── DYNAMIC BLOCK (not cached) ───────────────────────────────────────────
    // Changes on every call (time, memory hits, sender, todos).
    let dynamicPart = '';

    // ── Sender identity ───────────────────────────────────────────────────────
    // Look up who is messaging from contacts.md so Gary always knows the sender.
    const sender = lookupSender(event.node_id);
    if (sender) {
      dynamicPart += `\n\nYou are currently talking with: ${sender.name} (node_id: ${event.node_id})`;
      if (sender.notes) dynamicPart += ` — Notes: ${sender.notes}`;
    } else {
      dynamicPart += `\n\nYou are currently talking with: unknown contact (node_id: ${event.node_id})`;
      dynamicPart += `\nIf they introduce themselves, save them to contacts.md using the filesystem skill.`;
    }
    dynamicPart += `\nYou are ${agent.name}. Be friendly, helpful, and conversational.`;

    // ── Live channel connections ───────────────────────────────────────────────
    const enabledChannels = Object.entries(config.channels)
      .filter(([, cfg]) => (cfg as Record<string, unknown>)['enabled'] === true)
      .map(([name]) => name);

    if (enabledChannels.length > 0) {
      dynamicPart += `\n\nYou can send messages through: ${enabledChannels.join(', ')}.`;
    }

    // ── Installed skills ──────────────────────────────────────────────────────
    if (installedSkills && installedSkills.length > 0) {
      const skillNames = installedSkills.map(s => s.name).join(', ');
      dynamicPart += `\n\nYour installed skills: ${skillNames}`;
    }

    // ── AWS Credentials ───────────────────────────────────────────────────────
    dynamicPart += `\n\nYou can set AWS credentials using the "set_aws_credentials" tool.`;

    // ── Long-term profiles ────────────────────────────────────────────────────
    if (userProfile.trim()) {
      dynamicPart += `\n\nWhat I know about you: ${userProfile.slice(0, 4000)}`;
    }
    if (selfKnowledge.trim()) {
      dynamicPart += `\n\nWhat I know about myself: ${selfKnowledge.slice(0, 2000)}`;
    }

    // ── Time & memory ─────────────────────────────────────────────────────────
    dynamicPart += `\n\nCurrent time: ${now}`;

    if (semanticHits.length > 0) {
      dynamicPart += `\n\nRelevant memory:\n${semanticHits.join('\n')}`;
    }

    dynamicPart += `\n\nWhen the user switches to a completely different topic or task, call new_task() to condense stale tool outputs from the previous task.`;

    // ── Todo list — always injected so task state survives interruptions ─────
    const todos = readTodos(agent.memory_ns);
    if (todos.length > 0) {
      dynamicPart += `\n\n<todo_list>\n${formatTodosForPrompt(todos)}\n</todo_list>`;
    }
    dynamicPart += `\n\nWhen given a multi-step task, use todo_write() to track it. Rules (same as Claude Code):
- Create todos before starting work
- Mark the relevant todo in_progress before starting each step — only ONE task in_progress at a time
- Mark completed immediately when done
- The list persists across interruptions — always check it before resuming work`;

    // ── Flat system string (fallback for non-Claude adapters) ─────────────────
    const system = staticPart + dynamicPart;

    // ── Prompt caching blocks (Claude) ────────────────────────────────────────
    // Only emit system_blocks when the static part is large enough to cache
    // (Anthropic requires ≥1024 tokens ≈ ~4000 chars as a conservative guard).
    let system_blocks: LLMParams['system_blocks'];
    if (staticPart.length > 4000) {
      system_blocks = [
        { text: staticPart, cache_control: { type: 'ephemeral' } },
        { text: dynamicPart },
      ];
    }

    // ── Message history ───────────────────────────────────────────────────────
    // Token budget: keep only last MAX_MESSAGES turns
    let messages = shortTerm.slice(-MAX_MESSAGES);

    // Append current utterance as user message if not already in history
    const payload = event.payload as Record<string, unknown>;
    if (payload?.text && typeof payload.text === 'string') {
      const lastMsg = messages[messages.length - 1];
      const alreadyAdded = lastMsg?.role === 'user' && lastMsg?.content === payload.text;
      if (!alreadyAdded) {
        const userMsg: LLMMessage = { role: 'user', content: payload.text };
        // Pass image data through so vision-capable adapters can use it
        if (Array.isArray(payload.images_b64) && payload.images_b64.length > 0) {
          userMsg.images_b64 = payload.images_b64 as string[];
          userMsg.image_b64  = payload.images_b64[0] as string; // backward compat
        } else if (payload.image_b64 && typeof payload.image_b64 === 'string') {
          userMsg.image_b64 = payload.image_b64;
        }
        messages = [...messages, userMsg];
      }
    }

    const userText = typeof payload?.text === 'string' ? payload.text : '';

    return {
      system,
      system_blocks,
      dynamic_context: dynamicPart,
      messages,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      max_tokens: estimateMaxTokens(userText),
    };
  }
}
