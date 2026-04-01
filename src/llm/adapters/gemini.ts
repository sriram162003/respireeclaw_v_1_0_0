import { GoogleGenerativeAI, FunctionCallingMode, type FunctionDeclaration, type Content, type Part } from '@google/generative-ai';
import { GoogleAICacheManager } from '@google/generative-ai/server';
import type { LLMAdapter, LLMParams, LLMResponse, LLMMessage, ToolCall } from '../types.js';

// Gemini context caching requires at least ~4096 tokens in the cached block.
// Use a conservative character count (~16 000 chars ≈ 4000 tokens) as guard.
const GEMINI_CACHE_MIN_CHARS = 16_000;

export class GeminiAdapter implements LLMAdapter {
  private genAI: GoogleGenerativeAI;
  private cacheManager: GoogleAICacheManager;
  // key = first 64 chars of static system text (cheap content-change detection)
  private cacheMap = new Map<string, { name: string; expires: number }>();
  readonly provider = 'gemini';
  readonly model: string;

  constructor(apiKey: string, model: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.cacheManager = new GoogleAICacheManager(apiKey);
    this.model = model;
  }

  async complete(params: LLMParams): Promise<LLMResponse> {
    // Determine static system text for caching
    const staticSystem = params.system_blocks?.[0]?.text ?? params.system;
    const dynamicContext = params.dynamic_context ?? '';

    let contents = this.messagesToContents(params.messages);

    // Prepend dynamic context (sender identity, time, memory, todos) as a synthetic user message
    if (dynamicContext) {
      contents = [
        { role: 'user', parts: [{ text: `[Context]\n${dynamicContext}` }] },
        ...contents,
      ];
    }

    // Convert tool definitions
    const tools = params.tools && params.tools.length > 0
      ? [{
          functionDeclarations: params.tools.map(t => ({
            name: t.name,
            description: t.description,
            parameters: this.sanitizeSchema(t.parameters) as unknown as FunctionDeclaration['parameters'],
          } as FunctionDeclaration)),
        }]
      : undefined;

    let geminiModel;

    // Attempt context caching only when static block is large enough
    if (staticSystem.length >= GEMINI_CACHE_MIN_CHARS) {
      const cacheKey = staticSystem.slice(0, 64);
      const now = Date.now();
      let cachedEntry = this.cacheMap.get(cacheKey);

      // Refresh cache if missing or expiring within 60 s
      if (!cachedEntry || now > cachedEntry.expires - 60_000) {
        try {
          const cache = await this.cacheManager.create({
            model: `models/${this.model}`,
            systemInstruction: staticSystem,
            contents: [],   // required field; cache is system-instruction-only
            ttlSeconds: 3600,
          });
          cachedEntry = { name: cache.name!, expires: now + 3600_000 };
          this.cacheMap.set(cacheKey, cachedEntry);
        } catch (err) {
          // If cache creation fails (e.g. unsupported model), fall through to uncached path
          console.warn('[Gemini] Context cache creation failed, using uncached path:', err);
          cachedEntry = undefined;
        }
      }

      if (cachedEntry) {
        const cachedContent = await this.cacheManager.get(cachedEntry.name);
        geminiModel = this.genAI.getGenerativeModelFromCachedContent(cachedContent, {
          generationConfig: { maxOutputTokens: params.max_tokens ?? 8192 },
        });
      }
    }

    // Fall back to standard model (uncached) if caching was skipped or failed
    if (!geminiModel) {
      geminiModel = this.genAI.getGenerativeModel({
        model: this.model,
        // When system_blocks present, static part already used for cache; use full system as fallback
        ...(params.system ? { systemInstruction: params.system } : {}),
        generationConfig: { maxOutputTokens: params.max_tokens ?? 8192 },
      });
    }

    // Use generateContent directly — avoids SDK chat history validation
    // which incorrectly rejects functionResponse parts in user turns.
    let result = await geminiModel.generateContent({
      contents,
      ...(tools ? { tools } : {}),
    });
    let response = result.response;

    // Gemini 2.5 sometimes produces MALFORMED_FUNCTION_CALL — retry with tools disabled
    // so it generates a text answer from the context it already has.
    if ((response.candidates?.[0]?.finishReason as string) === 'MALFORMED_FUNCTION_CALL') {
      console.warn('[Gemini] MALFORMED_FUNCTION_CALL — retrying with tools disabled');
      result = await geminiModel.generateContent({
        contents,
        ...(tools ? { tools } : {}),
        toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.NONE } },
      });
      response = result.response;
    }

    let text = '';
    const toolCalls: ToolCall[] = [];

    const candidate = response.candidates?.[0];
    const finishReason = candidate?.finishReason;

    if ((finishReason as string) === 'MALFORMED_FUNCTION_CALL') {
      // Still failing after retry — return a readable fallback
      console.warn('[Gemini] MALFORMED_FUNCTION_CALL persists after retry');
      text = "I'm sorry, I encountered an issue processing your request. Please try again.";
    } else if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        const p = part as unknown as Record<string, unknown>;
        // Skip internal thought parts (Gemini 2.5 thinking models)
        if (p['thought']) continue;
        if ('text' in part && part.text) {
          text += (part as { text: string }).text;
        }
        if ('functionCall' in part && part.functionCall) {
          toolCalls.push({
            id:   crypto.randomUUID(),
            name: part.functionCall.name,
            args: part.functionCall.args as Record<string, unknown>,
          });
        }
      }
    }

    return {
      text,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        input_tokens:  response.usageMetadata?.promptTokenCount ?? 0,
        output_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      },
      model:    this.model,
      provider: this.provider,
    };
  }

  // Remove JSON Schema fields Gemini doesn't support to prevent MALFORMED_FUNCTION_CALL
  private sanitizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
    const UNSUPPORTED = new Set(['$schema', '$id', '$ref', 'additionalProperties', 'default', 'examples', 'if', 'then', 'else', 'allOf', 'anyOf', 'oneOf', 'not']);
    const clean = (obj: unknown): unknown => {
      if (Array.isArray(obj)) return obj.map(clean);
      if (obj && typeof obj === 'object') {
        return Object.fromEntries(
          Object.entries(obj as Record<string, unknown>)
            .filter(([k]) => !UNSUPPORTED.has(k))
            .map(([k, v]) => [k, clean(v)])
        );
      }
      return obj;
    };
    return clean(schema) as Record<string, unknown>;
  }

  private detectMimeType(b64: string): string {
    const prefix = b64.slice(0, 16);
    if (prefix.startsWith('/9j/'))      return 'image/jpeg';
    if (prefix.startsWith('iVBORw0K')) return 'image/png';
    if (prefix.startsWith('R0lGOD'))   return 'image/gif';
    if (prefix.startsWith('UklGR'))    return 'image/webp';
    return 'image/jpeg';
  }

  private messagesToContents(messages: LLMMessage[]): Content[] {
    // Build map from tool_call_id → tool name (needed for functionResponse)
    const toolCallNames = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolCallNames.set(tc.id, tc.name);
        }
      }
    }

    const contents: Content[] = [];
    let i = 0;

    while (i < messages.length) {
      const msg = messages[i];

      if (msg.role === 'tool') {
        // Merge consecutive tool results into a single user turn with functionResponse parts
        const parts: Part[] = [];
        while (i < messages.length && messages[i].role === 'tool') {
          const toolMsg = messages[i];
          const toolName = toolCallNames.get(toolMsg.tool_call_id ?? '') ?? 'unknown_function';
          let responseObj: Record<string, unknown>;
          try {
            const parsed = JSON.parse(toolMsg.content);
            // Gemini functionResponse.response must be an object, not an array
            responseObj = (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
              ? parsed as Record<string, unknown>
              : { result: parsed };
          } catch {
            responseObj = { result: toolMsg.content };
          }
          parts.push({ functionResponse: { name: toolName, response: responseObj } });
          i++;
        }
        contents.push({ role: 'user', parts });

      } else if (msg.role === 'assistant') {
        const parts: Part[] = [];
        if (msg.content) parts.push({ text: msg.content });
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            parts.push({ functionCall: { name: tc.name, args: tc.args ?? {} } });
          }
        }
        if (parts.length > 0) {
          contents.push({ role: 'model', parts });
        }
        i++;

      } else {
        // user role
        const parts: Part[] = [];
        if (msg.images_b64 && msg.images_b64.length > 0) {
          for (const img of msg.images_b64) {
            parts.push({ inlineData: { mimeType: this.detectMimeType(img), data: img } });
          }
        } else if (msg.image_b64) {
          parts.push({ inlineData: { mimeType: this.detectMimeType(msg.image_b64), data: msg.image_b64 } });
        }
        if (msg.content) parts.push({ text: msg.content });
        if (parts.length === 0) parts.push({ text: '' });
        contents.push({ role: 'user', parts });
        i++;
      }
    }

    return contents;
  }
}
