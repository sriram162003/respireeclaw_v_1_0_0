import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';
import type { AgentConfig } from '../agents/types.js';

export const AURA_DIR = path.join(os.homedir(), '.aura');
export const SKILLS_DIR = path.join(AURA_DIR, 'skills');
export const MEMORY_DIR    = path.join(AURA_DIR, 'memory');
export const TOKENS_DIR    = path.join(AURA_DIR, 'tokens');
export const WORKSPACE_DIR = path.join(AURA_DIR, 'workspace');

export interface GatewayConfig {
  agent: {
    name:    string;
    persona: string;
  };
  llm: {
    default: string;
    routing: Record<string, string>;
    providers: Record<string, { api_key?: string; base_url?: string; models: string[] }>;
  };
  channels: Record<string, { enabled: boolean; [key: string]: unknown }>;
  voice: {
    tts: { provider: string; api_key?: string; voice_id: string };
    stt: { provider: string; api_key?: string };
  };
  canvas:    { enabled: boolean; port: number };
  scheduler: { heartbeat_interval_min: number; reminder_check_sec: number; nightly_summary_time: string };
  security:  { bind_address: string; rest_port: number };
}

function interpolateEnv(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (_, expr) => {
      const [key, ...rest] = expr.split(':-');
      return process.env[key] ?? rest.join(':-');
    });
  }
  if (Array.isArray(obj)) return obj.map(interpolateEnv);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, interpolateEnv(v)])
    );
  }
  return obj;
}

function loadYaml<T>(filePath: string, defaultVal: T): T {
  try {
    if (!fs.existsSync(filePath)) return defaultVal;
    const raw = fs.readFileSync(filePath, 'utf8');
    return interpolateEnv(yaml.load(raw)) as T;
  } catch (err) {
    console.error(`[Config] Failed to load ${filePath}:`, err);
    return defaultVal;
  }
}

export function loadConfig(): GatewayConfig {
  const configPath = path.join(AURA_DIR, 'config.yaml');
  const defaults: GatewayConfig = {
    agent: { name: 'RespireeClaw', persona: 'You are RespireeClaw, a friendly and helpful personal AI assistant. Keep responses natural and conversational.' },
    llm: {
      default: 'claude-haiku-4-5',
      routing: { simple: 'claude-haiku-4-5', complex: 'claude-sonnet-4-6', vision: 'claude-sonnet-4-6', creative: 'claude-opus-4', offline: 'ollama/llama3.2:3b' },
      providers: {
        claude:      { api_key: process.env.ANTHROPIC_API_KEY,  models: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4'] },
        openai:      { api_key: process.env.OPENAI_API_KEY,    models: ['gpt-4o', 'gpt-4o-mini'] },
        ollama:      { base_url: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434', models: ['llama3.2:3b'] },
        gemini:      { api_key: process.env.GOOGLE_API_KEY,    models: ['gemini-1.5-pro', 'gemini-1.5-flash'] },
        mistral:     { api_key: process.env.MISTRAL_API_KEY,   models: ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-7b'] },
        openrouter:  { api_key: process.env.OPENROUTER_API_KEY, models: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o', 'google/gemini-pro-1.5'] },
        nvidia:      { api_key: process.env.NVIDIA_API_KEY,      base_url: 'https://integrate.api.nvidia.com/v1',  models: ['nvidia/nvidia/llama-3.1-nemotron-70b-instruct', 'nvidia/nvidia/llama-3.1-nemotron-nano-8b-v1', 'nvidia/moonshotai/kimi-k2.5', 'nvidia/mistralai/mistral-nemo-12b-instruct'] },
        groq:        { api_key: process.env.GROQ_API_KEY,        base_url: 'https://api.groq.com/openai/v1',       models: ['groq/llama-3.3-70b-versatile', 'groq/llama-3.1-8b-instant', 'groq/mixtral-8x7b-32768', 'groq/gemma2-9b-it'] },
        deepseek:    { api_key: process.env.DEEPSEEK_API_KEY,    base_url: 'https://api.deepseek.com/v1',          models: ['deepseek/deepseek-chat', 'deepseek/deepseek-reasoner'] },
        xai:         { api_key: process.env.XAI_API_KEY,         base_url: 'https://api.x.ai/v1',                  models: ['xai/grok-2-latest', 'xai/grok-2-vision-preview', 'xai/grok-3-latest'] },
        together:    { api_key: process.env.TOGETHER_API_KEY,    base_url: 'https://api.together.xyz/v1',          models: ['together/meta-llama/Llama-3.3-70B-Instruct-Turbo', 'together/mistralai/Mixtral-8x7B-Instruct-v0.1', 'together/google/gemma-2-27b-it'] },
        perplexity:  { api_key: process.env.PERPLEXITY_API_KEY,  base_url: 'https://api.perplexity.ai',            models: ['perplexity/llama-3.1-sonar-large-128k-online', 'perplexity/llama-3.1-sonar-small-128k-online', 'perplexity/llama-3.1-sonar-huge-128k-online'] },
      },
    },
    channels: {
      telegram: { enabled: false },
      whatsapp: { enabled: false },
      signal:   { enabled: false },
      slack:    { enabled: false },
      discord:  { enabled: false },
      google_chat: { enabled: false },
      teams:    { enabled: false, app_id: '', app_secret: '', webhook_port: 3004 },
      webchat:  { enabled: true, port: 3000 },
    },
    voice: {
      tts: { provider: 'elevenlabs', api_key: process.env.ELEVENLABS_API_KEY, voice_id: '21m00Tcm4TlvDq8ikWAM' },
      stt: { provider: 'whisper_api', api_key: process.env.OPENAI_API_KEY },
    },
    canvas:    { enabled: true, port: 3001 },
    scheduler: { heartbeat_interval_min: 30, reminder_check_sec: 60, nightly_summary_time: '23:30' },
    security:  { bind_address: '0.0.0.0', rest_port: 3002 },
  };
  return { ...defaults, ...loadYaml<Partial<GatewayConfig>>(configPath, {}) } as GatewayConfig;
}

export function loadAgents(): AgentConfig[] {
  const agentsPath = path.join(AURA_DIR, 'agents.yaml');
  const data = loadYaml<{ agents: AgentConfig[] }>(agentsPath, { agents: [] });
  return data.agents ?? [];
}

export function ensureAuraDirs(): void {
  for (const dir of [AURA_DIR, SKILLS_DIR, MEMORY_DIR, TOKENS_DIR, path.join(MEMORY_DIR, 'personal'), path.join(MEMORY_DIR, 'dev'), path.join(MEMORY_DIR, 'social')]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
