import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { AI_LIMITS, ExtractNeedsBodySchema } from '@neighbourhood/shared';
import { HttpError, parseBody } from '../../lib/http.js';
import type { MatchingService } from '../needs/matching.service.js';
import { authUser } from '../auth/auth.js';
import type { AiService } from './ai.service.js';

/**
 * Per-user limiter (keyed by verified uid, so it must run after requireAuth).
 * In-memory: each Cloud Run instance keeps its own counters. Meta Model API
 * team rate limits are is the global backstop; see docs/architecture.md.
 */
export function aiRateLimiter() {
  return rateLimit({
    windowMs: AI_LIMITS.rateLimitWindowMs,
    limit: AI_LIMITS.rateLimitPerWindow,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => `user:${authUser(req).userId}`,
    handler: (_req, _res, next) => next(new HttpError('RATE_LIMITED', 'Too many AI requests. Please wait a minute.')),
  });
}

export function aiRouter(service: AiService, integrations?: { matching?: MatchingService; photo?: (userId: string, sessionId: string, attachmentId: string) => Promise<{ bytes: Buffer; mimeType: string }> }): Router {
  const r = Router();
  const limiter = aiRateLimiter();

  r.get('/ai/status', (_req, res) => {
    res.json(service.status());
  });

  r.post('/ai/needs/extract', limiter, async (req, res) => {
    const body = parseBody(ExtractNeedsBodySchema, req);
    res.json(await service.extractNeeds(body));
  });

  // Contracts defined in packages/shared/src/ai/contracts.ts; owners: see docs/module-ownership.md.
  r.post('/ai/listing-draft', limiter, async (req, res) => {
    const body = parseBody(z.strictObject({ sessionId: z.uuid(), attachmentId: z.uuid(), hint: z.string().max(500).default('') }), req);
    if (!integrations?.photo) throw new HttpError('AI_NOT_CONFIGURED', 'Photo storage unavailable');
    const photo = await integrations.photo(authUser(req).userId, body.sessionId, body.attachmentId);
    res.json(await service.draftPhoto(photo.bytes, photo.mimeType, body.hint));
  });
  r.post('/ai/match-explanations', limiter, async (req, res) => { const body = parseBody(z.strictObject({ needId: z.uuid() }), req); if (!integrations?.matching) throw new HttpError('AI_NOT_CONFIGURED', 'Matching unavailable'); res.json(await integrations.matching.matches(authUser(req).userId, body.needId)); });
  return r;
}
