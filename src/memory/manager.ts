import type { GatewayConfig } from '../config/loader.js';
import { ensureAuraDirs } from '../config/loader.js';
import type { LLMMessage } from '../llm/types.js';
import { ShortTermMemory } from './short_term.js';
import { EpisodicMemory } from './episodic.js';
import { SemanticMemory, type ReminderRow, type WebhookRow } from './semantic.js';
import { ProfileMemory } from './profile.js';
import { VectorMemory } from './vector.js';

/**
 * Unified facade for all memory tiers:
 * - Short-term: per-session RAM ring buffer
 * - Episodic: daily .md files per agent namespace
 * - Semantic: SQLite FTS5 search + reminders + webhooks
 * - Vector: embedding-based semantic search
 */
export class MemoryManager {
  private shortTerm: ShortTermMemory;
  private episodic:  EpisodicMemory;
  private semantic!: SemanticMemory;
  private profiles:  ProfileMemory;
  private vector!:   VectorMemory;

  constructor(config: GatewayConfig) {
    const mem = (config as unknown as { memory?: { max_turns?: number; session_ttl_hours?: number } }).memory;
    this.shortTerm = new ShortTermMemory({
      maxTurns:     mem?.max_turns ?? 30,
      sessionTtlMs: (mem?.session_ttl_hours ?? 2) * 3600_000,
    });
    this.episodic  = new EpisodicMemory();
    this.profiles  = new ProfileMemory();
  }

  async init(): Promise<void> {
    ensureAuraDirs();
    this.semantic = new SemanticMemory();
    this.vector = new VectorMemory();
  }

  // ── Short-term ────────────────────────────────────────────────────────────

  addTurn(session_id: string, _agent_ns: string, role: 'user' | 'assistant', content: string): void {
    this.shortTerm.addTurn(session_id, role, content);
  }

  addTurnMessages(session_id: string, _agent_ns: string, msgs: LLMMessage[]): void {
    this.shortTerm.addTurnMessages(session_id, msgs);
  }

  setTopicBoundary(session_id: string): void {
    this.shortTerm.setTopicBoundary(session_id);
  }

  getShortTerm(session_id: string): LLMMessage[] {
    return this.shortTerm.get(session_id);
  }

  cleanupSessions(): void {
    this.shortTerm.cleanup();
  }

  recordSessionTokens(session_id: string, usage: { input: number; output: number; cache_creation?: number; cache_read?: number }): void {
    this.shortTerm.recordTokens(session_id, usage);
  }

  getSessionTokenUsage(session_id: string): { input: number; output: number; cache_creation: number; cache_read: number; calls: number } | null {
    return this.shortTerm.getTokenUsage(session_id);
  }

  getAllSessionTokenUsage(): Record<string, { input: number; output: number; cache_creation: number; cache_read: number; calls: number }> {
    return this.shortTerm.getAllTokenUsage();
  }

  // ── Episodic ──────────────────────────────────────────────────────────────

  async writeEpisodic(agent_ns: string, date: string, content: string): Promise<void> {
    await this.episodic.write(agent_ns, date, content);
  }

  async readEpisodic(agent_ns: string, date: string): Promise<string> {
    return this.episodic.read(agent_ns, date);
  }

  async deleteEpisodic(agent_ns: string, date: string): Promise<void> {
    await this.episodic.delete(agent_ns, date);
  }

  // ── Semantic FTS5 ─────────────────────────────────────────────────────────

  async indexEpisodic(agent_ns: string, date: string, content: string): Promise<void> {
    this.semantic.index(agent_ns, date, content);
  }

  async search(agent_ns: string, query: string, limit?: number): Promise<string[]> {
    return this.semantic.search(agent_ns, query, limit);
  }

  // ── Reminders ─────────────────────────────────────────────────────────────

  async storeReminder(text: string, fire_at: string, target_node: string, agent_id: string): Promise<number> {
    return this.semantic.storeReminder(text, fire_at, target_node, agent_id);
  }

  async getPendingReminders(now: string): Promise<Array<Omit<ReminderRow, 'fired'>>> {
    return this.semantic.getPendingReminders(now);
  }

  async markReminderFired(id: number): Promise<void> {
    this.semantic.markReminderFired(id);
  }

  async listReminders(): Promise<ReminderRow[]> {
    return this.semantic.listReminders();
  }

  async cancelReminder(id: number): Promise<void> {
    this.semantic.cancelReminder(id);
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────

  async storeWebhook(key: string, payload: string): Promise<void> {
    this.semantic.storeWebhook(key, payload);
  }

  async getWebhooks(key: string, limit?: number): Promise<WebhookRow[]> {
    return this.semantic.getWebhooks(key, limit);
  }

  async deleteWebhooks(key: string): Promise<void> {
    this.semantic.deleteWebhooks(key);
  }

  // ── Profiles ──────────────────────────────────────────────────────────────

  readProfile(ns: string): string {
    return this.profiles.readProfile(ns);
  }

  readSelf(ns: string): string {
    return this.profiles.readSelf(ns);
  }

  appendToProfile(ns: string, facts: string): void {
    this.profiles.appendToProfile(ns, facts);
  }

  appendToSelf(ns: string, facts: string): void {
    this.profiles.appendToSelf(ns, facts);
  }

  writeProfile(ns: string, content: string): void {
    this.profiles.writeProfile(ns, content);
  }

  writeSelf(ns: string, content: string): void {
    this.profiles.writeSelf(ns, content);
  }

  // ── Vector Memory ───────────────────────────────────────────────────────────

  async indexVector(agentId: string, content: string, metadata: Record<string, unknown> = {}): Promise<number> {
    return this.vector.index(agentId, content, metadata);
  }

  async searchVector(agentId: string, query: string, limit = 10): Promise<{ content: string; score: number; metadata: Record<string, unknown> }[]> {
    return this.vector.search(agentId, query, limit);
  }

  deleteVector(agentId: string): void {
    this.vector.delete(agentId);
  }

  close(): void {
    this.vector.close();
    this.semantic.close();
  }
}
