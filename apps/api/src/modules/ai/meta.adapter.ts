import { HttpError } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { MetaApiError, type ChatClient } from './meta.client.js';

export interface StructuredRequest {
  task: string; systemInstruction: string; input: string;
  jsonSchema: Record<string, unknown>; maxOutputTokens: number; timeoutMs: number;
}
export interface StructuredGenerator { readonly model: string; generateJson(req: StructuredRequest): Promise<unknown> }
/** Short structured tasks; reasoning tokens count against max_completion_tokens. */
export const META_REASONING_EFFORT = 'low';

/** Meta's structured-output docs do not list array-length keywords, so they are not sent.
 * Zod still enforces all array bounds after generation; tools keep their own schema.
 */
export function modelOutputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const clean = (value: unknown): unknown => Array.isArray(value) ? value.map(clean) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => !['maxItems', 'minItems', '$schema'].includes(key)).map(([key, child]) => [key, clean(child)])) : value;
  return clean(schema) as Record<string, unknown>;
}
/** Typed, stateless structured generation. Validation and grounding belong to the caller. */
export class MetaAdapter implements StructuredGenerator {
  constructor(readonly model: string, private readonly client: ChatClient) {}
  async generateJson(req: StructuredRequest): Promise<unknown> {
    const started = Date.now();
    try {
      const response = await this.client.complete({ model: this.model,
        messages: [{ role: 'developer', content: req.systemInstruction }, { role: 'user', content: req.input }],
        response_format: { type: 'json_schema', json_schema: { name: req.task, schema: modelOutputSchema(req.jsonSchema) } },
        max_completion_tokens: req.maxOutputTokens, reasoning_effort: META_REASONING_EFFORT }, AbortSignal.timeout(req.timeoutMs));
      const choice = response.choices?.[0];
      const text = choice?.message?.content;
      if (choice?.finish_reason === 'length' || !text) throw new HttpError('AI_INVALID_OUTPUT', 'The AI response did not finish');
      try { const result: unknown = JSON.parse(text); logger.info('ai_call_completed', { task: req.task, model: this.model, durationMs: Date.now() - started }); return result; }
      catch { throw new HttpError('AI_INVALID_OUTPUT', 'The AI service returned malformed output'); }
    } catch (error) {
      const failure = error instanceof HttpError ? error : mapAiError(error);
      logger.warn('ai_call_failed', { task: req.task, model: this.model, code: failure.code, upstreamStatus: error instanceof MetaApiError ? error.status : null, durationMs: Date.now() - started });
      throw failure;
    }
  }
}

/** Maps client/HTTP failures to stable API error codes. Never echoes upstream text. */
export function mapAiError(err: unknown): HttpError {
  const name = err instanceof Error ? err.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new HttpError('AI_TIMEOUT', 'The AI service took too long to respond');
  }
  if (!(err instanceof MetaApiError)) return new HttpError('AI_UPSTREAM_ERROR', 'The AI service is temporarily unavailable');
  const { status, code } = err;
  if (status === 429 || status === 402) return new HttpError('AI_QUOTA_EXCEEDED', 'AI quota or rate limit reached. Please try again later.');
  if (status === 401 || status === 403) {
    return new HttpError('AI_NOT_CONFIGURED', 'The AI service rejected the server credentials');
  }
  if (status === 404 || code === 'model_not_found') {
    return new HttpError('AI_MODEL_UNAVAILABLE', 'The configured AI model is not available');
  }
  if (status === 400 || status === 413) return new HttpError('AI_INPUT_REJECTED', 'The AI service could not process this input');
  if (status === 504) return new HttpError('AI_TIMEOUT', 'The AI service took too long to respond');
  return new HttpError('AI_UPSTREAM_ERROR', 'The AI service is temporarily unavailable');
}
