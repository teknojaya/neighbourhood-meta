import { Router, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { PlaceQuerySchema, PlaceReverseQuerySchema } from '@neighbourhood/shared';
import { HttpError, parseQuery } from '../../lib/http.js';
import { authUser } from '../auth/auth.js';
import type { PlaceProvider } from './geoapify.client.js';

/** Aborts the provider call when the browser drops a stale autocomplete request. */
function clientSignal(res: Response) {
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  return controller.signal;
}

export function placesRouter(provider: PlaceProvider | null): Router {
  const r = Router();
  // The browser debounces typing; this caps a single account well below the shared provider budget.
  const limiter = rateLimit({ windowMs: 60_000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: req => `user:${authUser(req).userId}`,
    handler: (_req, _res, next) => next(new HttpError('RATE_LIMITED', 'Too many place searches. Please wait a minute.')) });
  const configured = () => { if (!provider) throw new HttpError('GEOCODING_NOT_CONFIGURED', 'Place search is not configured'); return provider; };
  r.get('/places/autocomplete', limiter, async (req, res) => {
    const query = parseQuery(PlaceQuerySchema, req);
    res.json({ items: await configured().autocomplete(query.q, query.lang, clientSignal(res)) });
  });
  r.get('/places/reverse', limiter, async (req, res) => {
    const query = parseQuery(PlaceReverseQuerySchema, req);
    res.json({ item: await configured().reverse({ lat: query.lat, lng: query.lng }, query.lang, clientSignal(res)) });
  });
  return r;
}
