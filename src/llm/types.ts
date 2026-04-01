export interface LLMAdapter {
  complete(params: LLMParams): Promise<LLMResponse>;
  readonly provider: string;
  readonly model:    string;
}

export interface LLMParams {
  system:           string;
  /** Claude: split system prompt into cacheable static + dynamic blocks. */
  system_blocks?:   Array<{ text: string; cache_control?: { type: 'ephemeral' } }>;
  /** Gemini: dynamic system content injected as a synthetic context message. */
  dynamic_context?: string;
  messages:         LLMMessage[];
  tools?:           ToolDefinition[];
  max_tokens?:      number;
}

export interface LLMMessage {
  role:          'user' | 'assistant' | 'tool';
  content:       string;
  image_b64?:    string;       // base64-encoded image for vision messages (user role only)
  images_b64?:   string[];     // multiple images — takes precedence over image_b64 when present
  tool_call_id?: string;
  tool_calls?:   ToolCall[];   // included in assistant messages that triggered tool calls
}

export interface LLMResponse {
  text:        string;
  tool_calls?: ToolCall[];
  usage: {
    input_tokens:           number;
    output_tokens:          number;
    cache_creation_tokens?: number;
    cache_read_tokens?:     number;
  };
  model:    string;
  provider: string;
}

export interface ToolCall {
  id:   string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolDefinition {
  name:        string;
  description: string;
  parameters:  Record<string, unknown>;
}

export type LLMTier = 'simple' | 'complex' | 'vision' | 'creative' | 'offline';
