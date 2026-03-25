import Anthropic from '@anthropic-ai/sdk';
import type { LLMAdapter, LLMParams, LLMResponse, ToolCall } from '../types.js';

export class ClaudeAdapter implements LLMAdapter {
  private client: Anthropic;
  readonly provider = 'claude';
  readonly model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async complete(params: LLMParams): Promise<LLMResponse> {
    // Convert messages to Claude API format
    const messages: Anthropic.MessageParam[] = params.messages.map(msg => {
      // tool result → user message with tool_result content block
      if (msg.role === 'tool') {
        return {
          role: 'user',
          content: [{
            type:        'tool_result' as const,
            tool_use_id: msg.tool_call_id ?? '',
            content:     msg.content,
          }],
        };
      }
      // assistant with tool_calls → include tool_use blocks so tool_results are valid
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const content: Anthropic.ContentBlockParam[] = [];
        if (msg.content) content.push({ type: 'text', text: msg.content });
        for (const tc of msg.tool_calls) {
          content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
        }
        return { role: 'assistant', content };
      }
      // user message with one or more images → send as multimodal content blocks
      if (msg.role === 'user' && (msg.images_b64?.length || msg.image_b64)) {
        const imagesToSend = msg.images_b64?.length ? msg.images_b64 : [msg.image_b64!];
        const content: Anthropic.ContentBlockParam[] = [
          ...imagesToSend.map(b64 => ({
            type:   'image' as const,
            source: {
              type:       'base64' as const,
              media_type: 'image/jpeg' as const,
              data:       b64,
            },
          })),
          { type: 'text' as const, text: msg.content },
        ];
        return { role: 'user', content };
      }
      return { role: msg.role as 'user' | 'assistant', content: msg.content };
    });

    // Convert tool definitions
    const tools: Anthropic.Tool[] | undefined = params.tools?.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool['input_schema'],
    }));

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: params.max_tokens ?? 4096,
      system: params.system,
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
    });

    // Extract text
    let text = '';
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        text += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id:   block.id,
          name: block.name,
          args: block.input as Record<string, unknown>,
        });
      }
    }

    return {
      text,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        input_tokens:  response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
      model:    this.model,
      provider: this.provider,
    };
  }
}
