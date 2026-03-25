import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadConfig, loadAgents, AURA_DIR } from './loader.js';
import * as fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('fs');

describe('Config Loader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('loadConfig', () => {
    it('should return defaults when no config file exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      
      const config = loadConfig();
      
      expect(config.agent.name).toBe('RespireeClaw');
      expect(config.llm.default).toBe('claude-haiku-4-5');
      expect(config.channels.webchat.enabled).toBe(true);
    });

    it('should return defaults for all required fields', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      
      const config = loadConfig();
      
      expect(config).toHaveProperty('agent');
      expect(config).toHaveProperty('llm');
      expect(config).toHaveProperty('channels');
      expect(config).toHaveProperty('voice');
      expect(config).toHaveProperty('canvas');
      expect(config).toHaveProperty('scheduler');
      expect(config).toHaveProperty('security');
    });

    it('should have correct LLM providers configured', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      
      const config = loadConfig();
      
      expect(config.llm.providers).toHaveProperty('claude');
      expect(config.llm.providers).toHaveProperty('openai');
      expect(config.llm.providers).toHaveProperty('ollama');
      expect(config.llm.providers).toHaveProperty('gemini');
    });

    it('should have correct routing tiers', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      
      const config = loadConfig();
      
      expect(config.llm.routing.simple).toBe('claude-haiku-4-5');
      expect(config.llm.routing.complex).toBe('claude-sonnet-4-6');
      expect(config.llm.routing.vision).toBe('claude-sonnet-4-6');
      expect(config.llm.routing.creative).toBe('claude-opus-4');
      expect(config.llm.routing.offline).toBe('ollama/llama3.2:3b');
    });
  });

  describe('loadAgents', () => {
    it('should return empty array when no agents file exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      
      const agents = loadAgents();
      
      expect(agents).toEqual([]);
    });
  });

  describe('AURA_DIR', () => {
    it('should point to ~/.aura', () => {
      expect(AURA_DIR).toBe(path.join(os.homedir(), '.aura'));
    });
  });
});
