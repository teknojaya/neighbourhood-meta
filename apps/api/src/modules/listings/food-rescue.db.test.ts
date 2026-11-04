import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CreateListingBodySchema } from '@neighbourhood/shared';
import { createDb } from '../../lib/db.js';
import { testDatabaseUrl } from '../../test/db-global-setup.js';
import { PrismaRequestsService } from '../requests/requests.service.js';
import { MaintenanceService } from '../notifications/maintenance.service.js';
import { MatchingService } from '../needs/matching.service.js';
import { ListingsService } from './listings.service.js';

const db = createDb(testDatabaseUrl());
const listingsService = new ListingsService(db);
const requests = new PrismaRequestsService(db);
const maintenance = new MaintenanceService(db, null);
const users: string[] = [], listings: string[] = [];
const HOME = { lat: -6.2601, lng: 106.8101 };
let owner: string, alice: string, bob: string, carol: string;

async function user() {
  const uid = `food-${randomUUID()}`;
  const row = await db.user.create({ data: { firebaseUid: uid, email: `${uid}@example.test`, emailVerified: true, homeLat: HOME.lat, homeLng: HOME.lng, searchRadiusKm: 5 } });
  users.push(row.id);
  return row.id;
}
const hours = (h: number) => new Date(Date.now() + h * 3_600_000);
async function foodListing(stockTotal = 5, collectBy = hours(3), title = `Surplus nasi box ${randomUUID().slice(0, 6)}`) {
  const row = await db.listing.create({ data: {
    ownerId: owner, title, description: 'Cooked this afternoon', status: 'active', mode: 'donate', category: 'groceries', condition: 'new',
    stockTotal, areaLabel: 'Tebet', lat: HOME.lat, lng: HOME.lng, geohash: 'qqgux', collectionMethod: 'owner_location',
    foodRescue: true, collectBy, private: { create: { pickupInstructions: 'PRIVATE ADDRESS' } },
  } });
  listings.push(row.id);
  return row.id;
}
const pastDeadline = (id: string) => db.$executeRaw`UPDATE listings SET collect_by = now() - interval '1 minute' WHERE id = ${id}::uuid`;
const ask = (who: string, listingId: string, quantity = 1) => requests.create(who, randomUUID(), { listingId, quantity, message: '' }).then(r => r.body);
const move = (who: string, id: string, to: 'approved' | 'cancelled' | 'collected', pickupBy?: string) => requests.transition(who, randomUUID(), id, { to, ...(pickupBy ? { pickupBy } : {}) }).then(r => r.body);
const stock = (id: string) => db.listing.findUniqueOrThrow({ where: { id }, select: { stockReserved: true, stockCollected: true, foodExpiredAt: true } });

beforeEach(async () => { owner = await user(); alice = await user(); bob = await user(); carol = await user(); });
afterAll(async () => {
  await db.notification.deleteMany({ where: { userId: { in: users } } });
  await db.need.deleteMany({ where: { userId: { in: users } } });
  await db.donationRequest.deleteMany({ where: { listingId: { in: listings } } });
  await db.listing.deleteMany({ where: { id: { in: listings } } });
  await db.idempotencyKey.deleteMany({ where: { userId: { in: users } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

describe('surplus-food rescue against PostgreSQL', () => {
  const body = (food: Record<string, unknown>) => CreateListingBodySchema.parse({ mode: 'donate', category: 'groceries', title: 'Leftover bread rolls', description: '',
    condition: 'new', quantity: 6, areaLabel: 'Tebet', exactLocation: HOME, pickupInstructions: 'Gate 2', collection: { method: 'owner_location', communityPointId: null }, food });

  it('creates food offers only with a future deadline and keeps unknown details unknown', async () => {
    await expect(listingsService.createListing(owner, body({ collectBy: new Date(Date.now() - 60_000).toISOString() }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(listingsService.createListing(owner, body({ collectBy: hours(24 * 30).toISOString() }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const created = await listingsService.createListing(owner, body({ collectBy: hours(2).toISOString(), storage: 'Refrigerated' }));
    listings.push(created.id);
    expect(created.food).toMatchObject({ storage: 'Refrigerated', allergens: null, preparedAt: null, expired: false });
    expect(() => CreateListingBodySchema.parse({ ...body({ collectBy: hours(2).toISOString() }), category: 'household' })).toThrow();
    // The database refuses a food offer without a deadline even if application checks were bypassed.
    await expect(db.$executeRaw`UPDATE listings SET collect_by = NULL WHERE id = ${created.id}::uuid`).rejects.toThrow();
  });

  it('rejects requests, approvals and collection after the deadline but still lets a reservation be cancelled once', async () => {
    const id = await foodListing(5);
    const pending = await ask(alice, id);
    const approved = await move(owner, (await ask(bob, id, 2)).id, 'approved');
    const toCollect = await move(owner, (await ask(carol, id, 1)).id, 'approved');
    await pastDeadline(id);
    await expect(ask(await user(), id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(move(owner, pending.id, 'approved')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(move(owner, toCollect.id, 'collected')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await move(bob, approved.id, 'cancelled')).status).toBe('cancelled');
    expect(await stock(id)).toMatchObject({ stockReserved: 1, stockCollected: 0 });
  });

  it('never lets an approval pickup deadline exceed collect-by', async () => {
    const collectBy = hours(3);
    const id = await foodListing(3, collectBy);
    const defaulted = await move(owner, (await ask(alice, id)).id, 'approved');
    expect(defaulted.pickupBy).toBe(collectBy.toISOString());
    const explicit = await ask(bob, id);
    await expect(move(owner, explicit.id, 'approved', hours(5).toISOString())).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const inOneHour = hours(1).toISOString();
    expect((await move(owner, explicit.id, 'approved', inOneHour)).pickupBy).toBe(inOneHour);
    // Moving collect-by earlier than an approved pickup is refused.
    await expect(listingsService.updateListing(owner, id, { food: { collectBy: hours(0.5).toISOString() } })).rejects.toMatchObject({ code: 'CONFLICT' });
    const later = await listingsService.updateListing(owner, id, { food: { collectBy: hours(4).toISOString(), allergens: 'Peanuts' } });
    expect(later.food).toMatchObject({ allergens: 'Peanuts', expired: false });
  });

  it('expires outstanding requests once, releases each reservation once, preserves collections and notifies', async () => {
    const id = await foodListing(6);
    const pending = await ask(alice, id);
    const reserved = await move(owner, (await ask(bob, id, 2)).id, 'approved');
    const collected = await move(owner, await move(owner, (await ask(carol, id, 1)).id, 'approved').then(r => r.id), 'collected');
    await pastDeadline(id);
    // Two overlapping maintenance runs must not double-release or double-notify.
    await Promise.all([maintenance.expireFoodOffers(), maintenance.expireFoodOffers()]);
    await maintenance.expireFoodOffers();
    const statuses = Object.fromEntries((await db.donationRequest.findMany({ where: { listingId: id } })).map(r => [r.id, r.status]));
    expect(statuses).toEqual({ [pending.id]: 'expired', [reserved.id]: 'expired', [collected.id]: 'collected' });
    expect(await stock(id)).toMatchObject({ stockReserved: 0, stockCollected: 1, foodExpiredAt: expect.any(Date) });
    const notices = await db.notification.findMany({ where: { type: 'request_expired', userId: { in: [owner, alice, bob, carol] } } });
    expect(notices.map(n => n.userId).sort()).toEqual([owner, alice, bob].sort());
  });

  it('keeps stock consistent when a requester cancels while expiry runs', async () => {
    for (let round = 0; round < 3; round++) {
      const id = await foodListing(4);
      const reservations = await Promise.all([alice, bob].map(async who => move(owner, (await ask(who, id, 2)).id, 'approved')));
      await pastDeadline(id);
      const results = await Promise.allSettled([maintenance.expireFoodOffers(), move(alice, reservations[0]!.id, 'cancelled'), move(bob, reservations[1]!.id, 'cancelled')]);
      expect(results[0].status).toBe('fulfilled');
      await maintenance.expireFoodOffers();
      const rows = await db.donationRequest.findMany({ where: { listingId: id } });
      expect(rows.every(r => r.status === 'cancelled' || r.status === 'expired')).toBe(true);
      expect(await stock(id)).toMatchObject({ stockReserved: 0, stockCollected: 0, foodExpiredAt: expect.any(Date) });
    }
  });

  it('excludes expired food from discovery and saved-need matching', async () => {
    const title = `Rescue soup ${randomUUID().slice(0, 6)}`;
    const id = await foodListing(2, hours(2), title);
    const search = () => listingsService.searchListings({ searcherId: alice, center: HOME, radiusKm: 5, query: title, limit: 10 });
    expect((await search()).map(l => l.id)).toEqual([id]);
    const need = await db.need.create({ data: { userId: alice, extraction: { language: 'en', items: [{ name: title, category: 'groceries', quantity: null, preference: 'donation', attributes: [] }], timing: { neededBy: null, loanDurationDays: null, originalText: null }, clarificationQuestions: [], outOfScope: [] } } });
    const matching = new MatchingService(db, listingsService, null);
    expect((await matching.matches(alice, need.id)).items.map(m => m.listing.id)).toEqual([id]);
    await pastDeadline(id);
    expect(await search()).toEqual([]);
    expect((await matching.matches(alice, need.id)).items).toEqual([]);
    expect((await listingsService.getListingDetail(alice, id)).listing.food?.expired).toBe(true);
  });
});
