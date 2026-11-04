import { CharityEventDetailSchema, CharityEventListSchema, EventDraftResponseSchema, type CreateEventBody } from '@neighbourhood/shared';
import { api } from '../../lib/api';

export const fetchNearbyEvents = (p: { lat: number; lng: number; radiusKm: number }, signal?: AbortSignal) =>
  api(`/api/v1/events?${new URLSearchParams({ lat: String(p.lat), lng: String(p.lng), radiusKm: String(p.radiusKm) })}`, { schema: CharityEventListSchema, signal });
export const fetchMyEvents = (signal?: AbortSignal) => api('/api/v1/events/mine', { schema: CharityEventListSchema, signal });
export const fetchEvent = (id: string, signal?: AbortSignal) => api(`/api/v1/events/${id}`, { schema: CharityEventDetailSchema, signal });
export const draftEvent = (text: string) => api('/api/v1/events/draft', { method: 'POST', body: { text }, schema: EventDraftResponseSchema });
export const createEvent = (body: CreateEventBody, key: string) => api('/api/v1/events', { method: 'POST', body, idempotencyKey: key, schema: CharityEventDetailSchema });
export const cancelEvent = (id: string, key: string) => api(`/api/v1/events/${id}/cancel`, { method: 'POST', body: {}, idempotencyKey: key, schema: CharityEventDetailSchema });
export const pledge = (id: string, body: { needId: string; quantity: number; note: string }, key: string) => api(`/api/v1/events/${id}/pledges`, { method: 'POST', body, idempotencyKey: key, schema: CharityEventDetailSchema });
export const signup = (id: string, slotId: string, key: string) => api(`/api/v1/events/${id}/slots/${slotId}/signups`, { method: 'POST', body: {}, idempotencyKey: key, schema: CharityEventDetailSchema });
export const movePledge = (pledgeId: string, to: 'accepted' | 'received' | 'cancelled', key: string) => api(`/api/v1/event-pledges/${pledgeId}/transition`, { method: 'POST', body: { to }, idempotencyKey: key, schema: CharityEventDetailSchema });
export const moveSignup = (signupId: string, to: 'accepted' | 'cancelled', key: string) => api(`/api/v1/event-signups/${signupId}/transition`, { method: 'POST', body: { to }, idempotencyKey: key, schema: CharityEventDetailSchema });
