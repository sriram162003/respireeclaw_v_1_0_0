import fs from 'fs';
import path from 'path';
import os from 'os';
import type { GatewayEvent } from '../channels/types.js';
import type { AgentConfig } from '../agents/types.js';
import type { LLMMessage, LLMParams, ToolDefinition } from './types.js';
import type { GatewayConfig } from '../config/loader.js';

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

const MAX_MESSAGES = 20;

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

    // ── Identity & persona ────────────────────────────────────────────────────
    let system = agent.persona.trim();

    // Hard identity rule — prevent the model from describing itself as the
    // underlying LLM when asked "what are you" or "what can you do".
    system += `\n\nYour name is ${agent.name}. You are a personal AI assistant.`;

    // ── Sender identity ───────────────────────────────────────────────────────
    // Look up who is messaging from contacts.md so Gary always knows the sender.
    const sender = lookupSender(event.node_id);
    if (sender) {
      system += `\n\nYou are currently talking with: ${sender.name} (node_id: ${event.node_id})`;
      if (sender.notes) system += ` — Notes: ${sender.notes}`;
    } else {
      system += `\n\nYou are currently talking with: unknown contact (node_id: ${event.node_id})`;
      system += `\nIf they introduce themselves, save them to contacts.md using the filesystem skill.`;
    }
    system += `\nYou are ${agent.name}. Be friendly, helpful, and conversational.`;

    // ── Capabilities summary ──────────────────────────────────────────────────
    // Build from the actual loaded tool definitions so this always stays in sync.
    // Canvas internals are excluded from the narrative; everything else is shown.
    const nonInternalTools = toolDefs.filter(
      t => !['canvas_clear','canvas_append','canvas_update','canvas_delete'].includes(t.name)
    );

    if (nonInternalTools.length > 0) {
      // List actual tools with descriptions so the agent knows what it can do
      const toolList = nonInternalTools.map(t => `  - ${t.name}: ${t.description}`).join('\n');
      system += `\n\nAVAILABLE TOOLS:\n${toolList}`;
      system += `\n\nWhen tool calls don't depend on each other, call all of them together in one response — mix different tools freely and call the same tool multiple times with different arguments (e.g. describe_instances for every region + list_s3_buckets + list_lambda at the same time). Only call sequentially when a tool needs the result of a previous one.`;
    }

    // ── Live channel connections ───────────────────────────────────────────────
    const enabledChannels = Object.entries(config.channels)
      .filter(([, cfg]) => (cfg as Record<string, unknown>)['enabled'] === true)
      .map(([name]) => name);

    if (enabledChannels.length > 0) {
      system += `\n\nYou can send messages through: ${enabledChannels.join(', ')}.`;
    }

    // ── Installed skills ──────────────────────────────────────────────────────
    if (installedSkills && installedSkills.length > 0) {
      const skillNames = installedSkills.map(s => s.name).join(', ');
      system += `\n\nYour installed skills: ${skillNames}`;
    }

    // ── AWS Credentials ───────────────────────────────────────────────────────
    system += `\n\nYou can set AWS credentials using the "set_aws_credentials" tool.`;

    // ── Long-term profiles ────────────────────────────────────────────────────
    if (userProfile.trim()) {
      system += `\n\nWhat I know about you: ${userProfile.slice(0, 2000)}`;
    }
    if (selfKnowledge.trim()) {
      system += `\n\nWhat I know about myself: ${selfKnowledge.slice(0, 1000)}`;
    }

    // ── Time & memory ─────────────────────────────────────────────────────────
    system += `\n\nCurrent time: ${now}`;

    if (semanticHits.length > 0) {
      system += `\n\nRelevant memory:\n${semanticHits.join('\n')}`;
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

    return {
      system,
      messages,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      max_tokens: 4096,
    };
  }
}
