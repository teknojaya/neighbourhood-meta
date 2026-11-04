import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { CreateListingBodySchema, type NeedsExtraction } from '@neighbourhood/shared';
import { createDb } from '../../lib/db.js';
import { HttpError } from '../../lib/http.js';
import type { ObjectStorage } from '../../lib/storage.js';
import { testDatabaseUrl } from '../../test/db-global-setup.js';
import { FakeGenerator } from '../../test/fakes.js';
import { ListingsService } from '../listings/listings.service.js';
import { MATCH_EXPLANATION_INSTRUCTION, MatchingService } from './matching.service.js';

const db = createDb(testDatabaseUrl());
const users: string[] = [];
class MemoryStorage implements ObjectStorage {
  files = new Map<string, Buffer>();
  async signedReadUrl(path: string) { return '/photo/' + path; }
  async put(path: string, bytes: Buffer) { this.files.set(path, bytes); }
  async get(path: string) { return this.files.get(path)!; }
  async remove(path: string) { this.files.delete(path); }
}
const listings = new ListingsService(db, new MemoryStorage());

async function createUser() {
  const uid = `matching-${randomUUID()}`;
  const row = await db.user.create({ data: { firebaseUid: uid, email: `${uid}@example.test`, emailVerified: true, homeLat: -6.2, homeLng: 106.816, areaLabel: 'Test neighbourhood', searchRadiusKm: 5 } });
  users.push(row.id);
  return row;
}
async function publish(ownerId: string, title: string, overrides: Record<string, unknown> = {}) {
  const row = await listings.createListing(ownerId, CreateListingBodySchema.parse({ mode: 'donate', category: 'appliances', title, description: 'Working, from a smoke-free home.', condition: 'like_new', quantity: 2, areaLabel: 'Test neighbourhood', exactLocation: { lat: -6.2005, lng: 106.8165 }, pickupInstructions: 'PRIVATE pickup 3A', collection: { method: 'owner_location', communityPointId: null }, appliance: { workingStatus: 'unknown', brand: null, model: null, approxWeightKg: null, dimensionsCm: null, powerRequirement: null, access: { floorLevel: null, elevatorAvailable: null, requiresDismantling: null, requiresInstallation: null, suggestedHelpers: null, notes: null } }, ...overrides }), randomUUID());
  await listings.uploadPhoto(ownerId, row.id, await sharp({ create: { width: 5, height: 5, channels: 3, background: 'green' } }).png().toBuffer(), 'image/png', 'fixture_photo_' + row.id);
  return listings.transitionStatus(ownerId, row.id, 'active', 'fixture_publish_' + row.id);
}
const extraction = (category: string, name: string): NeedsExtraction => ({ language: 'en', items: [{ name, category: category as NeedsExtraction['items'][number]['category'], quantity: 1, preference: 'donation', attributes: [] }], timing: { neededBy: null, loanDurationDays: null, originalText: null }, clarificationQuestions: [], outOfScope: [] });
async function fixture() {
  // A unique word per fixture keeps it apart from listings written by other tests.
  const tag = `zq${randomUUID().slice(0, 8)}`;
  const owner = await createUser(), searcher = await createUser();
  const relevant = await publish(owner.id, `Rice cooker ${tag}`);
  const unrelated = await publish(owner.id, `Electric fan ${tag}`);
  const own = await publish(searcher.id, `Rice cooker ${tag} spare`);
  const need = await db.need.create({ data: { userId: searcher.id, extraction: extraction('appliances', `Rice cooker ${tag}`) } });
  return { tag, owner, searcher, relevant, unrelated, own, need };
}
const ids = (result: { items: Array<{ listing: { id: string } }> }) => result.items.map(item => item.listing.id);

afterAll(async () => {
  await db.need.deleteMany({ where: { userId: { in: users } } });
  await db.listing.deleteMany({ where: { ownerId: { in: users } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

describe('saved need matching against PostgreSQL', () => {
  it('returns the named item, not unrelated items in the same category or the caller’s own listing', async () => {
    const f = await fixture();
    const result = await new MatchingService(db, listings, null).matches(f.searcher.id, f.need.id);
    expect(ids(result)).toEqual([f.relevant.id]);
    expect(result.explanationSource).toBe('filters');
    expect(result.items[0]).toMatchObject({ listing: { condition: 'like_new', stock: { total: 2 } }, fit: 'partial' });
  });

  it('omits the category filter when the saved category is unknown', async () => {
    const f = await fixture();
    const need = await db.need.create({ data: { userId: f.searcher.id, extraction: extraction('unknown', `Rice cooker ${f.tag}`) } });
    expect(ids(await new MatchingService(db, listings, null).matches(f.searcher.id, need.id))).toEqual([f.relevant.id]);
  });

  it('returns grounded AI explanations from verified fields under a no-unsupported-claims prompt', async () => {
    const f = await fixture();
    const generator = new FakeGenerator(req => {
      const { candidates } = JSON.parse(req.input) as { candidates: Array<{ listingId: string }> };
      return { matches: [{ listingId: candidates[0]!.listingId, fit: 'strong', reason: 'A like-new rice cooker.', missingInfo: [] }, { listingId: f.unrelated.id, fit: 'strong', reason: 'Injected', missingInfo: [] }] };
    });
    const result = await new MatchingService(db, listings, generator).matches(f.searcher.id, f.need.id);
    expect(result).toMatchObject({ explanationSource: 'model', items: [{ listing: { id: f.relevant.id }, reason: 'A like-new rice cooker.' }] });
    expect(ids(result)).not.toContain(f.unrelated.id);
    expect(generator.calls[0]!.systemInstruction).toBe(MATCH_EXPLANATION_INSTRUCTION);
    expect(MATCH_EXPLANATION_INSTRUCTION).toMatch(/State only facts present/);
    const sent = JSON.parse(generator.calls[0]!.input) as { candidates: Array<Record<string, unknown>> };
    expect(sent.candidates).toEqual([expect.objectContaining({ listingId: f.relevant.id, condition: 'like_new', availableQuantity: 2 })]);
    expect(generator.calls[0]!.input).not.toMatch(/PRIVATE pickup|-6\.2005|106\.8165/);
  });

  it('falls back to the same filter results when explanations fail', async () => {
    const f = await fixture();
    for (const failure of [() => { throw new HttpError('AI_TIMEOUT', 'slow'); }, () => ({ matches: 'not an array' })]) {
      const result = await new MatchingService(db, listings, new FakeGenerator(failure)).matches(f.searcher.id, f.need.id);
      expect(result.explanationSource).toBe('filters');
      expect(ids(result)).toEqual([f.relevant.id]);
    }
  });

  it('surfaces a failed search instead of returning an empty result', async () => {
    const f = await fixture();
    const broken = Object.assign(Object.create(listings) as ListingsService, { searchListings: async () => { throw new Error('database unavailable'); } });
    const generator = new FakeGenerator(() => ({ matches: [] }));
    await expect(new MatchingService(db, broken, generator).matches(f.searcher.id, f.need.id)).rejects.toThrow('database unavailable');
    expect(generator.calls).toHaveLength(0);
  });
});
