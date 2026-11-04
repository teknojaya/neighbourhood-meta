/**
 * Minimal client for Meta's Model API (OpenAI-compatible Chat Completions).
 * Docs: https://dev.meta.ai/docs/protocols/chat-completions (verified 2026-11-04).
 *
 * The API key lives in a private field and is only ever written to the
 * Authorization header. Errors carry the HTTP status and the upstream error
 * type/code identifiers, never upstream message text.
 */
export const META_API_BASE_URL = 'https://api.meta.ai/v1';

export type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export interface ChatToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export type ChatMessage =
  | { role: 'developer' | 'system'; content: string }
  | { role: 'user'; content: string | ChatContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export interface ChatTool { type: 'function'; function: { name: string; description: string; parameters: unknown } }

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  max_completion_tokens: number;
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high';
  tools?: ChatTool[];
  response_format?: { type: 'json_schema'; json_schema: { name: string; schema: Record<string, unknown> } };
}
export interface ChatCompletion {
  choices?: { message?: { content?: string | null; tool_calls?: ChatToolCall[] }; finish_reason?: string | null }[];
}
export interface ChatCompletionChunk {
  choices?: {
    delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] };
    finish_reason?: string | null;
  }[];
}

export interface ChatClient {
  complete(body: ChatCompletionRequest, signal: AbortSignal): Promise<ChatCompletion>;
  stream(body: ChatCompletionRequest, signal: AbortSignal): AsyncIterable<ChatCompletionChunk>;
}

export class MetaApiError extends Error {
  override name = 'MetaApiError';
  constructor(readonly status: number, readonly type?: string, readonly code?: string) {
    super(`Meta Model API request failed (HTTP ${status})`);
  }
}

const identifier = (value: unknown) => (typeof value === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(value) ? value : undefined);
function upstreamError(status: number, body: unknown): MetaApiError {
  const error = (body as { error?: { type?: unknown; code?: unknown } } | null)?.error;
  return new MetaApiError(status, identifier(error?.type), identifier(error?.code));
}

export class MetaChatClient implements ChatClient {
  readonly #apiKey: string;
  constructor(apiKey: string, private readonly baseUrl = META_API_BASE_URL, private readonly fetchImpl: typeof fetch = fetch) {
    this.#apiKey = apiKey;
  }

  async complete(body: ChatCompletionRequest, signal: AbortSignal): Promise<ChatCompletion> {
    const res = await this.post({ ...body, stream: false }, signal);
    return (await res.json()) as ChatCompletion;
  }

  async *stream(body: ChatCompletionRequest, signal: AbortSignal): AsyncIterable<ChatCompletionChunk> {
    const res = await this.post({ ...body, stream: true }, signal);
    if (!res.body) throw new MetaApiError(502);
    let buffer = '';
    for await (const text of res.body.pipeThrough(new TextDecoderStream())) {
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        if (!data) continue;
        const chunk = JSON.parse(data) as ChatCompletionChunk & { error?: unknown };
        if (chunk.error) throw upstreamError(502, chunk);
        yield chunk;
      }
    }
  }

  private async post(body: ChatCompletionRequest & { stream: boolean }, signal: AbortSignal): Promise<Response> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#apiKey}`, 'content-type': 'application/json', accept: body.stream ? 'text/event-stream' : 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw upstreamError(res.status, await res.json().catch(() => null));
    return res;
  }
}
