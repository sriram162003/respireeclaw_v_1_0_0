import OpenAI from 'openai';
import type { LLMAdapter, LLMParams, LLMResponse, ToolCall } from '../types.js';

export class OpenAIAdapter implements LLMAdapter {
  private client: OpenAI;
  readonly provider = 'openai';
  readonly model: string;
  private extraBody?: Record<string, unknown>;

  constructor(apiKey: string, model: string, baseURL?: string, extraBody?: Record<string, unknown>) {
    this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}), timeout: 120_000 });
    this.model = model;
    this.extraBody = extraBody;
  }

  async complete(params: LLMParams): Promise<LLMResponse> {
    const messages: OpenAI.ChatCompletionMessageParam[] = params.messages.map(msg => {
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: msg.tool_call_id ?? '',
          content: msg.content,
        };
      }
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        return {
          role: 'assistant',
          content: msg.content ?? null,
          tool_calls: msg.tool_calls.map(tc => ({
            id: tc.id, type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        };
      }
      // Handle vision: user message with image base64
      if (msg.role === 'user' && msg.image_b64) {
        return {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${msg.image_b64}` } },
            { type: 'text', text: msg.content },
          ],
        };
      }
      return { role: msg.role as 'user' | 'assistant', content: msg.content };
    });

    const tools: OpenAI.ChatCompletionTool[] | undefined = params.tools?.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: params.max_tokens ?? 4096,
      messages: [
        { role: 'system', content: params.system },
        ...messages,
      ],
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(this.extraBody ? { extra_body: this.extraBody } : {}),
    });

    const choice = response.choices[0];
    const text = choice?.message?.content ?? '';
    const rawToolCalls = choice?.message?.tool_calls ?? [];
    const toolCalls: ToolCall[] = rawToolCalls.map(tc => {
      // OpenAI v5+ uses either function or custom structure
      const fn = 'function' in tc ? tc.function : null;
      const custom = 'custom' in tc ? tc.custom : null;
      return {
        id: tc.id,
        name: fn?.name ?? custom?.name ?? '',
        args: fn ? JSON.parse(fn.arguments as string) as Record<string, unknown> : {},
      };
    });

    return {
      text,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        input_tokens:  response.usage?.prompt_tokens ?? 0,
        output_tokens: response.usage?.completion_tokens ?? 0,
      },
      model:    this.model,
      provider: this.provider,
    };
  }
}
