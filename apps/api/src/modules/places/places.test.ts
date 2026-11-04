import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { PlaceReverseSchema, PlaceSuggestionsSchema } from '@neighbourhood/shared';
import { HttpError } from '../../lib/http.js';
import { bearer, buildTestApp } from '../../test/fakes.js';
import { GeoapifyPlaces, type GeoapifyResult, RequestBudget, suggestionsFrom } from './geoapify.client.js';

const KEY = 'geo-test-key-not-real';
// Shapes copied from real type=locality responses, including their quirks.
const tebet: GeoapifyResult = { result_type: 'suburb', place_id: 'p-tebet', name: 'Tebet', suburb: 'Tebet', city: 'South Jakarta', state: 'Tebet', country: 'Indonesia', lat: -6.226, lon: 106.858 };
const menteng: GeoapifyResult = { result_type: 'city', place_id: 'p-menteng', name: 'Menteng', city: 'Central Jakarta', county: 'Menteng', country: 'Indonesia', lat: -6.196, lon: 106.832 };
const bandungCity: GeoapifyResult = { result_type: 'city', place_id: 'p-bdg', name: 'Bandung City', city: 'Bandung City', state: 'West Java', country: 'Indonesia', lat: -6.917, lon: 107.619 };
const westJava: GeoapifyResult = { result_type: 'state', place_id: 'p-jabar', name: 'West Java', state: 'West Java', country: 'Indonesia', lat: -6.889, lon: 107.64 };
const street: GeoapifyResult = { result_type: 'street', name: 'Jalan Tebet Raya', city: 'South Jakarta', county: 'Tebet', country: 'Indonesia', lat: -6.23, lon: 106.85 };
const addressFragment: GeoapifyResult = { result_type: 'suburb', name: 'RW.05, Desa Manggungsari kecamatan Rajapolah', suburb: 'RW.05, Desa Manggungsari kecamatan Rajapolah', county: 'Tasikmalaya', state: 'West Java', country: 'Indonesia', lat: -7.2, lon: 108.2 };
const shop: GeoapifyResult = { result_type: 'amenity', name: 'FamilyMart', suburb: 'Tebet', city: 'South Jakarta', county: 'Jakarta Selatan', state: 'Jakarta', country: 'Indonesia', lat: -6.2261, lon: 106.8581 };

function fakeFetch(respond: (url: URL) => Response | Promise<Response>) {
  const urls: URL[] = [];
  const impl = (async (input: string | URL) => { const url = new URL(String(input)); urls.push(url); return respond(url); }) as typeof fetch;
  return { impl, urls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const never = new AbortController().signal;

describe('Geoapify place suggestions', () => {
  it('keeps each label with the coordinates of the same place and drops addresses', () => {
    const items = suggestionsFrom([street, tebet, addressFragment, menteng, { ...menteng, place_id: 'p-menteng-postcode' }, shop, bandungCity, westJava]);
    expect(items.map(i => [i.kind, i.label, i.location])).toEqual([
      ['neighbourhood', 'Tebet, South Jakarta', { lat: -6.226, lng: 106.858 }],
      ['neighbourhood', 'Menteng, Central Jakarta', { lat: -6.196, lng: 106.832 }],
      ['city', 'Bandung City, West Java', { lat: -6.917, lng: 107.619 }],
      ['region', 'West Java, Indonesia', { lat: -6.889, lng: 107.64 }],
    ]);
    // A parent that repeats the place's own name ("state: Tebet") is not shown as its province.
    expect(items[0]).toMatchObject({ city: 'South Jakarta', region: null, country: 'Indonesia' });
    expect(JSON.stringify(items)).not.toMatch(/Jalan|RW\.05|FamilyMart|p-tebet/);
  });

  it('distinguishes same-named places by region and country instead of merging them', () => {
    const springfieldIl: GeoapifyResult = { result_type: 'city', place_id: 'a', name: 'Springfield', city: 'Springfield', county: 'Sangamon County', state: 'Illinois', country: 'United States', lat: 39.8, lon: -89.6 };
    const springfieldMo: GeoapifyResult = { ...springfieldIl, place_id: 'b', county: 'Greene County', state: 'Missouri', lat: 37.2, lon: -93.3 };
    const items = suggestionsFrom([springfieldIl, springfieldMo, { ...springfieldIl, place_id: 'c' }]);
    expect(items.map(i => i.label)).toEqual(['Springfield, Illinois', 'Springfield, Missouri']);
    expect(items.map(i => i.location.lat)).toEqual([39.8, 37.2]);
  });

  it('sends the key only to Geoapify and never includes it or the URL in errors', async () => {
    const ok = fakeFetch(() => json({ results: [tebet] }));
    const places = new GeoapifyPlaces(KEY, new RequestBudget(10, 100), ok.impl);
    expect(await places.autocomplete('Tebet', 'id', never)).toHaveLength(1);
    expect(ok.urls[0]!.origin + ok.urls[0]!.pathname).toBe('https://api.geoapify.com/v1/geocode/autocomplete');
    expect(Object.fromEntries(ok.urls[0]!.searchParams)).toMatchObject({ text: 'Tebet', type: 'locality', lang: 'id', format: 'json', apiKey: KEY });

    for (const [respond, code] of [[() => json({ message: `bad key ${KEY}` }, 401), 'GEOCODING_UNAVAILABLE'], [() => json({}, 429), 'RATE_LIMITED'], [() => { throw new TypeError(`fetch failed ${KEY}`); }, 'GEOCODING_UNAVAILABLE'], [() => new Response('<html>', { status: 200 }), 'GEOCODING_UNAVAILABLE']] as const) {
      const failing = new GeoapifyPlaces(KEY, new RequestBudget(10, 100), fakeFetch(respond).impl);
      const error = await failing.autocomplete('Tebet', 'en', never).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ code });
      expect(JSON.stringify({ message: (error as Error).message, ...(error as object) })).not.toContain(KEY);
    }
  });

  it('names the area around a device point without sending the exact point or returning the address', async () => {
    const f = fakeFetch(() => json({ results: [shop] }));
    const item = await new GeoapifyPlaces(KEY, new RequestBudget(10, 100), f.impl).reverse({ lat: -6.2312345, lng: 106.8519876 }, 'en', never);
    expect(f.urls[0]!.searchParams.get('lat')).toBe('-6.231');
    expect(f.urls[0]!.searchParams.get('lon')).toBe('106.852');
    expect(item).toMatchObject({ kind: 'neighbourhood', label: 'Tebet, South Jakarta', location: { lat: -6.2312345, lng: 106.8519876 } });
    expect(JSON.stringify(item)).not.toContain('FamilyMart');
  });

  it('enforces per-second and per-day provider budgets before calling the provider', () => {
    let now = Date.parse('2026-11-05T10:00:00Z');
    const budget = new RequestBudget(2, 3, () => now);
    budget.take(); budget.take();
    expect(() => budget.take()).toThrow(/busy/);
    now += 1000; budget.take();
    now += 1000; expect(() => budget.take()).toThrow(/today/);
    now = Date.parse('2026-11-06T00:00:01Z'); expect(() => budget.take()).not.toThrow();
  });
});

describe('GET /api/v1/places', () => {
  const provider = { autocomplete: async () => suggestionsFrom([tebet]), reverse: async () => suggestionsFrom([tebet])[0]! };
  it('requires sign-in', async () => {
    await request(buildTestApp({ places: provider }).app).get('/api/v1/places/autocomplete?q=Tebet').expect(401);
  });
  it('reports an unconfigured provider instead of inventing results', async () => {
    const res = await request(buildTestApp().app).get('/api/v1/places/autocomplete?q=Tebet').set('Authorization', bearer('p1')).expect(503);
    expect(res.body.error.code).toBe('GEOCODING_NOT_CONFIGURED');
  });
  it('validates the query and returns contract-shaped suggestions', async () => {
    const { app } = buildTestApp({ places: provider });
    await request(app).get('/api/v1/places/autocomplete?q=T').set('Authorization', bearer('p2')).expect(400);
    const res = await request(app).get('/api/v1/places/autocomplete?q=Tebet&lang=id').set('Authorization', bearer('p2')).expect(200);
    expect(PlaceSuggestionsSchema.parse(res.body).items[0]!.label).toBe('Tebet, South Jakarta');
    const reverse = await request(app).get('/api/v1/places/reverse?lat=-6.2&lng=106.8').set('Authorization', bearer('p2')).expect(200);
    expect(PlaceReverseSchema.parse(reverse.body).item?.kind).toBe('neighbourhood');
  });
});
