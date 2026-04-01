import type { LLMMessage } from '../llm/types.js';

const DEFAULT_MAX_TURNS    = 30;
const DEFAULT_SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

interface ShortTermTurn {
  full:   LLMMessage[]; // raw messages exactly as received
  digest: LLMMessage[]; // compressed: tool results replaced with compact summaries, noise dropped
}

interface SessionTokenUsage {
  input:         number;
  output:        number;
  cache_creation: number;
  cache_read:    number;
  calls:         number;
}

/**
 * Build a compact digest of a turn's messages.
 * Called once at storage time — O(1) read cost in get().
 *
 * - user messages: pass through unchanged
 * - assistant with tool_calls: replace with "[called: name1, name2]" (drops tool_calls array
 *   so older context doesn't have dangling tool_call_id references)
 * - assistant without tool_calls (final reply): pass through unchanged
 * - tool result: compress by tool name (see compressToolResult)
 */
function buildDigest(msgs: LLMMessage[]): LLMMessage[] {
  // Build tool_call_id → tool_name map from assistant messages
  const idToName = new Map<string, string>();
  for (const msg of msgs) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const call of msg.tool_calls) {
        idToName.set(call.id, call.name);
      }
    }
  }

  const result: LLMMessage[] = [];
  for (const msg of msgs) {
    if (msg.role === 'user') {
      result.push(msg);
    } else if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Replace intermediate assistant round with a single-line summary
        const names = msg.tool_calls.map(c => c.name).join(', ');
        result.push({ role: 'assistant', content: `[called: ${names}]` });
      } else {
        result.push(msg); // final assistant reply — keep as-is
      }
    } else if (msg.role === 'tool') {
      const toolName = idToName.get(msg.tool_call_id ?? '') ?? '';
      const compressed = compressToolResult(toolName, msg.content);
      if (compressed !== null) {
        // Keep tool_call_id so the message structure stays valid (some adapters require it)
        result.push({ role: 'tool', content: compressed, tool_call_id: msg.tool_call_id });
      }
      // null = drop this tool result entirely
    }
  }
  return result;
}

/**
 * Compress a tool result to a compact string.
 * Returns null to drop the result entirely.
 */
function compressToolResult(toolName: string, content: string): string | null {
  // Tools whose results are always noise — drop entirely
  if (toolName === 'wait_for' || toolName === 'scroll' || toolName === 'keyboard') {
    return null;
  }

  // Try to parse JSON for structured compression
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(content) as Record<string, unknown>; } catch { /* fall through */ }

  if (toolName === 'fill' || toolName === 'check') {
    if (parsed) {
      const ok = parsed['filled'] === true || parsed['state'] !== null;
      return `${toolName} → ${ok ? 'ok' : 'failed'}`;
    }
    return `${toolName} → ok`;
  }

  if (toolName === 'click') {
    if (parsed) {
      const ok = parsed['clicked'] === true;
      const url = String(parsed['url'] ?? '');
      const err = String(parsed['error'] ?? '');
      return ok ? `click → ok${url ? ', url: ' + url : ''}` : `click → failed: ${err.slice(0, 80)}`;
    }
    return content.length > 200 ? content.slice(0, 200) + '…' : content;
  }

  if (toolName === 'navigate') {
    const url = parsed ? String(parsed['url'] ?? '') : '';
    return `navigate → ${url || content.slice(0, 100)}`;
  }

  if (toolName === 'open_browser') {
    const url = parsed ? String(parsed['url'] ?? '') : '';
    return `browser opened: ${url || content.slice(0, 100)}`;
  }

  if (toolName === 'login') {
    const ok = parsed ? parsed['success'] === true : false;
    const url = parsed ? String(parsed['url'] ?? '') : '';
    return `login → ${ok ? 'ok' : 'failed'}${url ? ' at ' + url : ''}`;
  }

  if (toolName === 'snapshot') {
    if (parsed) {
      const url = String(parsed['url'] ?? '');
      const title = String(parsed['title'] ?? '').slice(0, 60);
      const inputs = Array.isArray(parsed['inputs']) ? parsed['inputs'].length : '?';
      const buttons = Array.isArray(parsed['buttons']) ? parsed['buttons'].length : '?';
      return `snapshot: ${url} '${title}' — ${inputs} inputs, ${buttons} buttons`;
    }
    return content.slice(0, 200) + '…';
  }

  if (toolName === 'take_screenshot') {
    const filename = parsed ? String(parsed['filename'] ?? '') : '';
    return `screenshot: ${filename || content.slice(0, 100)}`;
  }

  // Report tools — keep short
  if (toolName === 'start_report' || toolName === 'record_step' || toolName === 'finish_report' ||
      toolName === 'get_report' || toolName === 'list_reports' || toolName === 'send_report') {
    return content.slice(0, 150);
  }

  // Unknown tool — pass through if small, truncate if large
  if (content.length <= 500) return content;
  return content.slice(0, 200) + '…';
}

/**
 * Copy user + final assistant text from a turn into result (skip tool messages and
 * intermediate assistant-with-tool-calls messages).
 */
function pushTextOnly(result: LLMMessage[], msgs: LLMMessage[]): void {
  for (const msg of msgs) {
    if (msg.role === 'tool') continue;
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) continue;
    result.push(msg);
  }
}

/**
 * Per-session RAM store for recent conversation turns.
 *
 * Each turn is stored with two representations:
 *   full   — the raw message chain for full-fidelity recall
 *   digest — a compact summary for older-turn context
 *
 * get() applies 3-level condensing:
 *   Level 1 (most recent turn):  full fidelity
 *   Level 2 (turns -2 and -3):   digest (compact tool summaries, noise dropped)
 *   Level 3 (older, or before topic boundary): text only (user + final assistant)
 *
 * setTopicBoundary() marks all current turns as Level 3 regardless of recency,
 * so stale tool context from a previous task doesn't bleed into a new one.
 */
export class ShortTermMemory {
  private sessions        = new Map<string, ShortTermTurn[]>();
  private lastSeen        = new Map<string, number>();
  private topicBoundaries = new Map<string, number>(); // session_id → turn index (exclusive)
  private sessionTokens   = new Map<string, SessionTokenUsage>();

  private readonly maxTurns:     number;
  private readonly sessionTtlMs: number;

  constructor(opts: { maxTurns?: number; sessionTtlMs?: number } = {}) {
    this.maxTurns     = opts.maxTurns     ?? DEFAULT_MAX_TURNS;
    this.sessionTtlMs = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  }

  addTurnMessages(session_id: string, msgs: LLMMessage[]): void {
    if (!this.sessions.has(session_id)) {
      this.sessions.set(session_id, []);
    }
    const turns = this.sessions.get(session_id)!;
    turns.push({ full: msgs, digest: buildDigest(msgs) });

    if (turns.length > this.maxTurns) {
      const removed = turns.length - this.maxTurns;
      turns.splice(0, removed);
      // Shift topic boundary so it tracks the same logical position after trim
      const b = this.topicBoundaries.get(session_id);
      if (b !== undefined) {
        this.topicBoundaries.set(session_id, Math.max(0, b - removed));
      }
    }

    this.lastSeen.set(session_id, Date.now());
  }

  /** Shim: add a single message as its own turn (backward compat). */
  addTurn(session_id: string, role: 'user' | 'assistant', content: string): void {
    this.addTurnMessages(session_id, [{ role, content }]);
  }

  /**
   * Flatten stored turns into an LLMMessage[] for context building.
   * 3-level condensing — see class comment.
   */
  get(session_id: string): LLMMessage[] {
    this.lastSeen.set(session_id, Date.now());
    const turns    = this.sessions.get(session_id) ?? [];
    const boundary = this.topicBoundaries.get(session_id) ?? 0;
    const result: LLMMessage[] = [];

    for (let i = 0; i < turns.length; i++) {
      const distFromEnd = turns.length - 1 - i; // 0 = most recent turn
      const pastBoundary = i < boundary;

      if (pastBoundary || distFromEnd > 2) {
        // Level 3: text only
        pushTextOnly(result, turns[i]!.full);
      } else if (distFromEnd === 0) {
        // Level 1: most recent — full fidelity
        result.push(...turns[i]!.full);
      } else {
        // Level 2: turns -2 and -3 — digest (pre-computed at storage time)
        result.push(...turns[i]!.digest);
      }
    }

    return result;
  }

  /**
   * Mark all currently stored turns as "past boundary" (Level 3 text-only),
   * regardless of how recent they are. Subsequent turns start fresh.
   * Call this when the user switches to a clearly different task.
   */
  setTopicBoundary(session_id: string): void {
    const turns = this.sessions.get(session_id) ?? [];
    this.topicBoundaries.set(session_id, turns.length);
    this.lastSeen.set(session_id, Date.now());
  }

  /** Record token usage for a session (accumulated across all LLM calls in the session). */
  recordTokens(session_id: string, usage: { input: number; output: number; cache_creation?: number; cache_read?: number }): void {
    const current = this.sessionTokens.get(session_id) ?? { input: 0, output: 0, cache_creation: 0, cache_read: 0, calls: 0 };
    current.input          += usage.input;
    current.output         += usage.output;
    current.cache_creation += usage.cache_creation ?? 0;
    current.cache_read     += usage.cache_read     ?? 0;
    current.calls++;
    this.sessionTokens.set(session_id, current);
    this.lastSeen.set(session_id, Date.now());
  }

  /** Get accumulated token usage for a session, or null if no data yet. */
  getTokenUsage(session_id: string): SessionTokenUsage | null {
    return this.sessionTokens.get(session_id) ?? null;
  }

  /** Get token usage for all active sessions. */
  getAllTokenUsage(): Record<string, SessionTokenUsage> {
    const result: Record<string, SessionTokenUsage> = {};
    for (const [id, usage] of this.sessionTokens) {
      result[id] = usage;
    }
    return result;
  }

  clear(session_id: string): void {
    this.sessions.delete(session_id);
    this.lastSeen.delete(session_id);
    this.topicBoundaries.delete(session_id);
    this.sessionTokens.delete(session_id);
  }

  /** Remove sessions inactive for longer than sessionTtlMs */
  cleanup(): void {
    const cutoff = Date.now() - this.sessionTtlMs;
    for (const [id, ts] of this.lastSeen) {
      if (ts < cutoff) {
        this.sessions.delete(id);
        this.lastSeen.delete(id);
        this.topicBoundaries.delete(id);
        this.sessionTokens.delete(id);
      }
    }
  }
}
