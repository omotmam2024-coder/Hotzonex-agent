import OpenAI from 'openai';
import type { ResponseInput } from 'openai/resources/responses/responses';
import type { TOOL_DEFINITIONS } from './tools.js';

export type InputItem =
  | { role: 'user' | 'assistant'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

export interface ModelRequest {
  model: string;
  instructions: string;
  input: InputItem[];
  tools: typeof TOOL_DEFINITIONS;
  toolChoice: 'auto' | 'none';
  maxOutputTokens: number;
  safetyIdentifier: string;
}

export interface ModelResponse {
  outputText: string;
  functionCalls: { call_id: string; name: string; arguments: string }[];
  usage: { input_tokens: number; output_tokens: number };
}

/** The model provider, behind an interface so unit tests can mock it. */
export interface AiModel {
  respond(request: ModelRequest, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<ModelResponse>;
}

/** OpenAI Responses API implementation. */
export class OpenAIResponsesModel implements AiModel {
  private readonly client: OpenAI;

  constructor(apiKey: string, client?: OpenAI) {
    this.client = client ?? new OpenAI({ apiKey, maxRetries: 0 });
  }

  async respond(request: ModelRequest, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<ModelResponse> {
    const response = await this.client.responses.create(
      {
        model: request.model,
        instructions: request.instructions,
        input: request.input as ResponseInput,
        tools: request.tools,
        tool_choice: request.toolChoice,
        parallel_tool_calls: false,
        max_output_tokens: request.maxOutputTokens,
        // Conversation data is kept in our database, not stored at OpenAI.
        store: false,
        truncation: 'auto',
        safety_identifier: request.safetyIdentifier,
      },
      { timeout: opts.timeoutMs, maxRetries: 0, ...(opts.signal ? { signal: opts.signal } : {}) },
    );

    const functionCalls = response.output
      .filter((item) => item.type === 'function_call')
      .map((item) => ({ call_id: item.call_id, name: item.name, arguments: item.arguments }));

    return {
      outputText: response.output_text ?? '',
      functionCalls,
      usage: { input_tokens: response.usage?.input_tokens ?? 0, output_tokens: response.usage?.output_tokens ?? 0 },
    };
  }
}
