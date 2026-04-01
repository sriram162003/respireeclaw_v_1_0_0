import type { GatewayConfig } from '../config/loader.js';
import type { LLMParams, LLMResponse } from './types.js';
import { ClaudeAdapter } from './adapters/claude.js';
import { OpenAIAdapter } from './adapters/openai.js';
import { OllamaAdapter } from './adapters/ollama.js';
import { GeminiAdapter } from './adapters/gemini.js';
import { MistralAdapter } from './adapters/mistral.js';
import { OpenRouterAdapter } from './adapters/openrouter.js';
import type { LLMAdapter } from './types.js';

/**
 * Routes LLM requests to the correct adapter based on tier configuration.
 * Supports live config reload via reload() — no restart required.
 */
export class LLMRouter {
  private config: GatewayConfig;
  private adapters = new Map<string, LLMAdapter>();

  constructor(config: GatewayConfig) {
    this.config = config;
  }

  /**
   * Hot-reload the LLM config. Clears the adapter cache so new model/tier
   * mappings take effect immediately on the next request.
   */
  reload(newConfig: GatewayConfig): void {
    const oldRouting  = JSON.stringify(this.config.llm.routing);
    const oldDefault  = this.config.llm.default;
    this.config = newConfig;
    this.adapters.clear(); // force re-creation with new provider settings
    console.log('[LLM] Config reloaded.');
    if (this.config.llm.default !== oldDefault) {
      console.log(`[LLM]   default: ${oldDefault} → ${this.config.llm.default}`);
    }
    const newRouting = JSON.stringify(this.config.llm.routing);
    if (newRouting !== oldRouting) {
      for (const [tier, model] of Object.entries(this.config.llm.routing)) {
        console.log(`[LLM]   ${tier}: ${model}`);
      }
    }
  }

  /**
   * Complete a prompt using the specified tier or model string.
   * @param tier - LLM tier ('simple', 'complex', 'vision', 'creative', 'offline') or model string
   */
  async complete(tier: string, params: LLMParams, _agent_id?: string): Promise<LLMResponse> {
    const modelStr = this.config.llm.routing[tier] ?? this.config.llm.default;
    const adapter = this.getAdapter(modelStr);
    return adapter.complete(params);
  }

  private getAdapter(modelStr: string): LLMAdapter {
    if (this.adapters.has(modelStr)) {
      return this.adapters.get(modelStr)!;
    }

    const adapter = this.createAdapter(modelStr);
    this.adapters.set(modelStr, adapter);
    return adapter;
  }

  private createAdapter(modelStr: string): LLMAdapter {
    let provider: string;
    let model: string;

    if (modelStr.includes('/')) {
      // Use indexOf so provider/org/model-name (e.g. together/meta-llama/Model) splits correctly
      const idx = modelStr.indexOf('/');
      provider = modelStr.slice(0, idx);
      model = modelStr.slice(idx + 1);
    } else if (modelStr.startsWith('claude-')) {
      provider = 'claude';
      model = modelStr;
    } else if (modelStr.startsWith('gpt-')) {
      provider = 'openai';
      model = modelStr;
    } else if (modelStr.startsWith('gemini-')) {
      provider = 'gemini';
      model = modelStr;
    } else if (modelStr.startsWith('mistral-') || modelStr.startsWith('open-mistral') || modelStr.startsWith('open-mixtral')) {
      provider = 'mistral';
      model = modelStr;
    } else if (modelStr.startsWith('deepseek-')) {
      provider = 'deepseek';
      model = modelStr;
    } else if (modelStr.startsWith('grok-')) {
      provider = 'xai';
      model = modelStr;
    } else {
      provider = 'claude';
      model = modelStr;
    }

    const providerCfg = this.config.llm.providers[provider];

    switch (provider) {
      case 'claude': {
        const apiKey = providerCfg?.api_key ?? process.env['ANTHROPIC_API_KEY'] ?? '';
        return new ClaudeAdapter(apiKey, model);
      }
      case 'openai': {
        const apiKey = providerCfg?.api_key ?? process.env['OPENAI_API_KEY'] ?? '';
        return new OpenAIAdapter(apiKey, model);
      }
      case 'ollama': {
        const baseUrl = providerCfg?.base_url ?? 'http://localhost:11434';
        return new OllamaAdapter(baseUrl, model);
      }
      case 'lm_studio': {
        const baseUrl = providerCfg?.base_url ?? 'http://localhost:1234';
        return new OllamaAdapter(baseUrl, model); // LM Studio is Ollama-compatible
      }
      case 'gemini': {
        const apiKey = providerCfg?.api_key ?? process.env['GOOGLE_API_KEY'] ?? '';
        return new GeminiAdapter(apiKey, model);
      }
      case 'mistral': {
        const apiKey = providerCfg?.api_key ?? process.env['MISTRAL_API_KEY'] ?? '';
        return new MistralAdapter(apiKey, model);
      }
      case 'openrouter': {
        const apiKey = providerCfg?.api_key ?? process.env['OPENROUTER_API_KEY'] ?? '';
        return new OpenRouterAdapter(apiKey, model);
      }
      case 'nvidia': {
        const apiKey = providerCfg?.api_key ?? process.env['NVIDIA_API_KEY'] ?? '';
        const baseUrl = providerCfg?.base_url ?? 'https://integrate.api.nvidia.com/v1';
        // NVIDIA NIM model strings are org/model (e.g. moonshotai/kimi-k2.5, nvidia/llama-3.1-nemotron-70b-instruct)
        // The router split already stripped the 'nvidia/' provider prefix, so pass model directly.
        // Only disable thinking mode for models that support it — sending chat_template_kwargs to
        // non-thinking models (e.g. nemotron, mistral-nemo) causes a 400 error.
        const isThinkingModel = /kimi|deepseek-r1|qwq|thinking/i.test(model);
        const extraBody = isThinkingModel ? { chat_template_kwargs: { thinking: false } } : undefined;
        return new OpenAIAdapter(apiKey, model, baseUrl, extraBody);
      }
      case 'groq': {
        const apiKey = providerCfg?.api_key ?? process.env['GROQ_API_KEY'] ?? '';
        const baseUrl = providerCfg?.base_url ?? 'https://api.groq.com/openai/v1';
        return new OpenAIAdapter(apiKey, model, baseUrl);
      }
      case 'deepseek': {
        const apiKey = providerCfg?.api_key ?? process.env['DEEPSEEK_API_KEY'] ?? '';
        const baseUrl = providerCfg?.base_url ?? 'https://api.deepseek.com/v1';
        return new OpenAIAdapter(apiKey, model, baseUrl);
      }
      case 'xai': {
        const apiKey = providerCfg?.api_key ?? process.env['XAI_API_KEY'] ?? '';
        const baseUrl = providerCfg?.base_url ?? 'https://api.x.ai/v1';
        return new OpenAIAdapter(apiKey, model, baseUrl);
      }
      case 'together': {
        const apiKey = providerCfg?.api_key ?? process.env['TOGETHER_API_KEY'] ?? '';
        const baseUrl = providerCfg?.base_url ?? 'https://api.together.xyz/v1';
        return new OpenAIAdapter(apiKey, model, baseUrl);
      }
      case 'perplexity': {
        const apiKey = providerCfg?.api_key ?? process.env['PERPLEXITY_API_KEY'] ?? '';
        const baseUrl = providerCfg?.base_url ?? 'https://api.perplexity.ai';
        return new OpenAIAdapter(apiKey, model, baseUrl);
      }
      default:
        throw new Error(`Unknown LLM provider: ${provider}`);
    }
  }
}
