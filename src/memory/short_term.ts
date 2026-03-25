import type { LLMMessage } from '../llm/types.js';

const MAX_TURNS = 20;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Per-session RAM ring buffer for recent conversation turns.
 * Automatically trims to MAX_TURNS when capacity exceeded.
 * Sessions inactive for 2 hours are removed by cleanup().
 */
export class ShortTermMemory {
  private sessions = new Map<string, LLMMessage[]>();
  private lastSeen = new Map<string, number>();

  addTurn(
    session_id: string,
    role: 'user' | 'assistant',
    content: string,
    tool_call_id?: string
  ): void {
    if (!this.sessions.has(session_id)) {
      this.sessions.set(session_id, []);
    }
    const msgs = this.sessions.get(session_id)!;
    msgs.push({
      role,
      content,
      ...(tool_call_id ? { tool_call_id } : {}),
    });
    // Keep only last MAX_TURNS
    if (msgs.length > MAX_TURNS) {
      msgs.splice(0, msgs.length - MAX_TURNS);
    }
    this.lastSeen.set(session_id, Date.now());
  }

  get(session_id: string): LLMMessage[] {
    this.lastSeen.set(session_id, Date.now());
    return this.sessions.get(session_id) ?? [];
  }

  clear(session_id: string): void {
    this.sessions.delete(session_id);
    this.lastSeen.delete(session_id);
  }

  /** Remove sessions that have been inactive for more than 2 hours */
  cleanup(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, ts] of this.lastSeen) {
      if (ts < cutoff) {
        this.sessions.delete(id);
        this.lastSeen.delete(id);
      }
    }
  }
}
