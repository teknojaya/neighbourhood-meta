/**
 * Server-side Geoapify geocoding for public area labels.
 * Docs: https://apidocs.geoapify.com/docs/geocoding/address-autocomplete/ (verified 2026-11-05).
 *
 * The API key lives in a private field and is only written into the outbound
 * request URL. Errors and logs carry HTTP status codes, never the URL, the
 * search text or coordinates.
 */
import { createHash } from 'node:crypto';
import { type PlaceKind, type PlaceSuggestion, type UiLanguage, PlaceSuggestionSchema } from '@neighbourhood/shared';
import { HttpError } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';

export const GEOAPIFY_BASE_URL = 'https://api.geoapify.com/v1/geocode';
const TIMEOUT_MS = 6000;
const MAX_SUGGESTIONS = 6;

/** Area result types returned for `type=locality`. Streets, buildings, amenities and postcodes are never offered. */
const AREA_TYPES = new Set(['suburb', 'district', 'city', 'county', 'state']);

export interface GeoapifyResult {
  result_type?: string; place_id?: string; name?: string; suburb?: string; district?: string; city?: string; county?: string; state?: string; country?: string; lat?: number; lon?: number;
}

export interface PlaceProvider {
  autocomplete(text: string, lang: UiLanguage, signal: AbortSignal): Promise<PlaceSuggestion[]>;
  reverse(point: { lat: number; lng: number }, lang: UiLanguage, signal: AbortSignal): Promise<PlaceSuggestion | null>;
}

const clean = (value: string | undefined) => value?.trim().slice(0, 120) || null;
const placeId = (r: GeoapifyResult, fallback: string) => (r.place_id ? createHash('sha256').update(r.place_id).digest('hex').slice(0, 32) : fallback);

/**
 * Builds one suggestion from one provider record, so the public label and the
 * pin always describe the same place. Provider data often repeats the place's
 * own name in its parent fields (Tebet's "state" is "Tebet"), so parents equal
 * to the name are skipped. A "city" result inside a different city is a
 * village or neighbourhood of that city.
 */
export function toSuggestion(r: GeoapifyResult, location: { lat: number; lng: number }): PlaceSuggestion | null {
  const name = clean(r.name);
  // Names like "RW.05, Desa …" are address fragments, not areas.
  if (!name || name.includes(',') || !r.result_type || !AREA_TYPES.has(r.result_type)) return null;
  const other = (value: string | undefined) => { const v = clean(value); return v && v.toLowerCase() !== name.toLowerCase() ? v : null; };
  const city = other(r.city), county = other(r.county), country = clean(r.country);
  const region = (() => { const state = other(r.state); return state && state !== city ? state : null; })();
  const type = r.result_type;
  const kind: PlaceKind = type === 'suburb' || type === 'district' || (type === 'city' && city) ? 'neighbourhood' : type === 'city' ? 'city' : 'region';
  const parent = kind === 'neighbourhood' ? city ?? county ?? region : kind === 'city' ? region ?? county ?? country : type === 'county' ? region ?? country : country;
  const label = (parent ? `${name}, ${parent}` : name).slice(0, 120);
  const parsed = PlaceSuggestionSchema.safeParse({ id: placeId(r, `${kind}:${label}`), kind, label, name, city: kind === 'neighbourhood' ? city ?? county : null, region, country, location });
  return parsed.success ? parsed.data : null;
}

export function suggestionsFrom(results: GeoapifyResult[]): PlaceSuggestion[] {
  const seen = new Set<string>(), out: PlaceSuggestion[] = [];
  for (const r of results) {
    if (typeof r.lat !== 'number' || typeof r.lon !== 'number') continue;
    const s = toSuggestion(r, { lat: r.lat, lng: r.lon });
    const key = s && `${s.label}|${s.region}|${s.country}`.toLowerCase();
    if (s && key && !seen.has(key)) { seen.add(key); out.push(s); }
    if (out.length === MAX_SUGGESTIONS) break;
  }
  return out;
}

/** Names the neighbourhood (or city) around a point. The nearest feature's own name (a shop, a building) is never used. */
export function areaFromReverse(r: GeoapifyResult | undefined, point: { lat: number; lng: number }): PlaceSuggestion | null {
  if (!r) return null;
  const area = { city: r.city, county: r.county, state: r.state, country: r.country };
  const neighbourhood = clean(r.suburb) ?? clean(r.district);
  if (neighbourhood) return toSuggestion({ ...area, result_type: 'suburb', name: neighbourhood }, point);
  if (clean(r.city)) return toSuggestion({ ...area, result_type: 'city', name: r.city, city: undefined }, point);
  return null;
}

/**
 * Keeps one instance under the free plan (5 requests/s, 3,000/day) with room
 * for a second instance: the Meta service scales to at most 2.
 */
export class RequestBudget {
  private recent: number[] = [];
  private day = '';
  private used = 0;
  constructor(private readonly perSecond = 2, private readonly perDay = 1400, private readonly now = () => Date.now()) {}
  take() {
    const t = this.now(), day = new Date(t).toISOString().slice(0, 10);
    if (day !== this.day) { this.day = day; this.used = 0; }
    this.recent = this.recent.filter(at => t - at < 1000);
    if (this.used >= this.perDay) throw new HttpError('RATE_LIMITED', 'Place search has reached today’s limit. Use device location or try tomorrow.');
    if (this.recent.length >= this.perSecond) throw new HttpError('RATE_LIMITED', 'Place search is busy. Please try again in a moment.');
    this.recent.push(t); this.used++;
  }
}

export class GeoapifyPlaces implements PlaceProvider {
  readonly #apiKey: string;
  constructor(apiKey: string, private readonly budget = new RequestBudget(), private readonly fetchImpl: typeof fetch = fetch, private readonly baseUrl = GEOAPIFY_BASE_URL) {
    this.#apiKey = apiKey;
  }

  async autocomplete(text: string, lang: UiLanguage, signal: AbortSignal) {
    const body = await this.get('autocomplete', { text, type: 'locality', lang, limit: '10', format: 'json' }, signal);
    return suggestionsFrom(body.results ?? []);
  }

  async reverse(point: { lat: number; lng: number }, lang: UiLanguage, signal: AbortSignal) {
    // ~110 m is enough to name the neighbourhood; the exact device point is not sent.
    const rounded = { lat: Math.round(point.lat * 1000) / 1000, lng: Math.round(point.lng * 1000) / 1000 };
    const body = await this.get('reverse', { lat: String(rounded.lat), lon: String(rounded.lng), lang, limit: '1', format: 'json' }, signal);
    return areaFromReverse(body.results?.[0], point);
  }

  private async get(path: 'autocomplete' | 'reverse', params: Record<string, string>, parent: AbortSignal): Promise<{ results?: GeoapifyResult[] }> {
    this.budget.take();
    const url = new URL(`${this.baseUrl}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('apiKey', this.#apiKey);
    const signal = AbortSignal.any([parent, AbortSignal.timeout(TIMEOUT_MS)]);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { accept: 'application/json' }, signal });
    } catch {
      if (parent.aborted) throw new HttpError('BAD_REQUEST', 'Place search cancelled');
      logger.warn('geocoding_unavailable', { path, status: 0 });
      throw new HttpError('GEOCODING_UNAVAILABLE', 'Place search is unavailable');
    }
    if (res.status === 429) { logger.warn('geocoding_rate_limited', { path }); throw new HttpError('RATE_LIMITED', 'Place search is busy. Please try again in a moment.'); }
    if (!res.ok) { logger.warn('geocoding_unavailable', { path, status: res.status }); throw new HttpError('GEOCODING_UNAVAILABLE', 'Place search is unavailable'); }
    const body = (await res.json().catch(() => null)) as { results?: GeoapifyResult[] } | null;
    if (!body || (body.results !== undefined && !Array.isArray(body.results))) throw new HttpError('GEOCODING_UNAVAILABLE', 'Place search is unavailable');
    return body;
  }
}
