import { GoogleGenerativeAI, type FunctionDeclaration, type Content, type Part } from '@google/generative-ai';
import type { LLMAdapter, LLMParams, LLMResponse, ToolCall } from '../types.js';

export class GeminiAdapter implements LLMAdapter {
  private genAI: GoogleGenerativeAI;
  readonly provider = 'gemini';
  readonly model: string;

  constructor(apiKey: string, model: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = model;
  }

  async complete(params: LLMParams): Promise<LLMResponse> {
    const geminiModel = this.genAI.getGenerativeModel({
      model: this.model,
      systemInstruction: params.system,
    });

    // Convert tool definitions to FunctionDeclarations
    const tools = params.tools && params.tools.length > 0
      ? [{
          functionDeclarations: params.tools.map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters as unknown as FunctionDeclaration['parameters'],
          } as FunctionDeclaration)),
        }]
      : undefined;

    // Build history from messages (all but last)
    const history: Content[] = params.messages.slice(0, -1).map(msg => {
      const parts: Part[] = [{ text: msg.content }];
      return { role: msg.role === 'assistant' ? 'model' : 'user', parts };
    });

    const lastMsg = params.messages[params.messages.length - 1];
    
    // Build user message with vision if image present
    const userParts: Part[] = [];
    if (lastMsg?.image_b64) {
      userParts.push({
        inlineData: {
          mimeType: 'image/jpeg',
          data: lastMsg.image_b64,
        },
      });
    }
    if (lastMsg?.content) {
      userParts.push({ text: lastMsg.content });
    }

    const chat = geminiModel.startChat({
      history,
      ...(tools ? { tools } : {}),
    });

    const result = await chat.sendMessage(userParts);
    const response = result.response;

    let text = '';
    const toolCalls: ToolCall[] = [];

    const candidate = response.candidates?.[0];
    if (candidate) {
      for (const part of candidate.content.parts) {
        if ('text' in part && part.text) {
          text += part.text;
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
}
