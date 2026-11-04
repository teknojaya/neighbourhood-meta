import { Router } from 'express';
import { CreateEventBodySchema, CreatePledgeBodySchema, EventDraftBodySchema, PledgeTransitionBodySchema, SearchEventsQuerySchema, SignupTransitionBodySchema } from '@neighbourhood/shared';
import { parseBody, parseQuery } from '../../lib/http.js';
import { uuidParam } from '../../lib/route-input.js';
import { authUser } from '../auth/auth.js';
import { aiRateLimiter } from '../ai/ai.routes.js';
import { idempotencyKey } from '../requests/idempotency.js';
import type { EventsService } from './events.service.js';
import type { EventDraftService } from './events.ai.js';

/** Charity events. Every write needs an Idempotency-Key and is authorised against stored records. */
export function eventsRouter(service: EventsService, drafts: EventDraftService): Router {
  const r = Router();
  const limiter = aiRateLimiter();
  r.get('/events', async (req, res) => { const q = parseQuery(SearchEventsQuerySchema, req); res.json({ items: await service.nearby(authUser(req).userId, { lat: q.lat, lng: q.lng }, q.radiusKm) }); });
  r.get('/events/mine', async (req, res) => { res.json({ items: await service.mine(authUser(req).userId) }); });
  r.post('/events/draft', limiter, async (req, res) => { res.json(await drafts.draft(parseBody(EventDraftBodySchema, req).text)); });
  r.post('/events', async (req, res) => { res.status(201).json(await service.create(authUser(req).userId, idempotencyKey(req), parseBody(CreateEventBodySchema, req))); });
  r.get('/events/:eventId', async (req, res) => { res.json(await service.detail(authUser(req).userId, uuidParam(req, 'eventId'))); });
  r.post('/events/:eventId/cancel', async (req, res) => { res.json(await service.cancel(authUser(req).userId, idempotencyKey(req), uuidParam(req, 'eventId'))); });
  r.post('/events/:eventId/pledges', async (req, res) => { res.status(201).json(await service.pledge(authUser(req).userId, idempotencyKey(req), uuidParam(req, 'eventId'), parseBody(CreatePledgeBodySchema, req))); });
  r.post('/events/:eventId/slots/:slotId/signups', async (req, res) => { res.status(201).json(await service.signup(authUser(req).userId, idempotencyKey(req), uuidParam(req, 'eventId'), uuidParam(req, 'slotId'))); });
  r.post('/event-pledges/:pledgeId/transition', async (req, res) => { res.json(await service.transitionPledge(authUser(req).userId, idempotencyKey(req), uuidParam(req, 'pledgeId'), parseBody(PledgeTransitionBodySchema, req).to)); });
  r.post('/event-signups/:signupId/transition', async (req, res) => { res.json(await service.transitionSignup(authUser(req).userId, idempotencyKey(req), uuidParam(req, 'signupId'), parseBody(SignupTransitionBodySchema, req).to)); });
  return r;
}
