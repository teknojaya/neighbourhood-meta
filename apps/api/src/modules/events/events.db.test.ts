import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CreateEventBodySchema } from '@neighbourhood/shared';
import { createDb } from '../../lib/db.js';
import { testDatabaseUrl } from '../../test/db-global-setup.js';
import { EventsService } from './events.service.js';

const db = createDb(testDatabaseUrl());
const events = new EventsService(db);
const users: string[] = [];
let organizer: string, alice: string, bob: string, carol: string;
const POINT = { lat: -6.2302, lng: 106.8201 };

async function user() {
  const uid = `event-${randomUUID()}`;
  const row = await db.user.create({ data: { firebaseUid: uid, email: `${uid}@example.test`, emailVerified: true, displayName: uid.slice(0, 20) } });
  users.push(row.id); return row.id;
}
const key = () => randomUUID();
async function event(needQty = 10, capacity = 2) {
  return events.create(organizer, key(), CreateEventBodySchema.parse({ title: 'School supply drive', purpose: 'Collect school supplies for neighbourhood children.',
    startsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), areaLabel: 'Menteng', location: POINT, privateNote: 'Community hall, rear entrance',
    needs: [{ title: 'Notebooks', category: 'books', quantity: needQty }], slots: [{ title: 'Sorting table', capacity }] }));
}

beforeEach(async () => { organizer = await user(); alice = await user(); bob = await user(); carol = await user(); });
afterAll(async () => {
  await db.charityEvent.deleteMany({ where: { organizerId: { in: users } } });
  await db.notification.deleteMany({ where: { userId: { in: users } } });
  await db.idempotencyKey.deleteMany({ where: { userId: { in: users } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

describe('charity events against PostgreSQL', () => {
  it('never over-pledges a need under concurrent pledges', async () => {
    const e = await event(5);
    const needId = e.needs[0]!.id;
    const contributors = await Promise.all(Array.from({ length: 6 }, () => user()));
    const results = await Promise.allSettled(contributors.map(id => events.pledge(id, key(), e.id, { needId, quantity: 2, note: '' })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter(r => r.status === 'rejected').every(r => (r as PromiseRejectedResult).reason.code === 'INSUFFICIENT_STOCK')).toBe(true);
    const detail = await events.detail(organizer, e.id);
    expect(detail.needs[0]).toMatchObject({ quantity: 5, pledged: 4, received: 0 });
    // A cancelled pledge frees its units for someone else.
    await events.transitionPledge(detail.pledges[0]!.mine ? organizer : organizer, key(), detail.pledges[0]!.id, 'cancelled');
    await expect(events.pledge(alice, key(), e.id, { needId, quantity: 3, note: '' })).resolves.toBeTruthy();
  });

  it('enforces volunteer slot capacity concurrently and once per person', async () => {
    const e = await event(5, 2);
    const slotId = e.slots[0]!.id;
    const people = await Promise.all(Array.from({ length: 5 }, () => user()));
    const results = await Promise.allSettled(people.map(id => events.signup(id, key(), e.id, slotId)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2);
    const winner = people[results.findIndex(r => r.status === 'fulfilled')]!;
    await expect(events.signup(winner, key(), e.id, slotId)).rejects.toMatchObject({ code: expect.stringMatching(/CONFLICT|INSUFFICIENT_STOCK/) });
    expect((await events.detail(organizer, e.id)).slots[0]).toMatchObject({ capacity: 2, taken: 2, accepted: 0 });
  });

  it('lets organizers manage only their events and users manage only their contributions', async () => {
    const e = await event();
    const needId = e.needs[0]!.id, slotId = e.slots[0]!.id;
    await expect(events.pledge(organizer, key(), e.id, { needId, quantity: 1, note: '' })).rejects.toMatchObject({ code: 'SELF_REQUEST' });
    const pledgeId = (await events.pledge(alice, key(), e.id, { needId, quantity: 2, note: 'Brand new' })).pledges[0]!.id;
    await expect(events.transitionPledge(alice, key(), pledgeId, 'accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(events.transitionPledge(alice, key(), pledgeId, 'received')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(events.transitionPledge(bob, key(), pledgeId, 'cancelled')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(events.cancel(bob, key(), e.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Received only after acceptance, and only by the organizer.
    await expect(events.transitionPledge(organizer, key(), pledgeId, 'received')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await events.transitionPledge(organizer, key(), pledgeId, 'accepted');
    await events.transitionPledge(organizer, key(), pledgeId, 'received');
    await expect(events.transitionPledge(alice, key(), pledgeId, 'cancelled')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const signupId = (await events.signup(bob, key(), e.id, slotId)).signups[0]!.id;
    await expect(events.transitionSignup(carol, key(), signupId, 'cancelled')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(events.transitionSignup(bob, key(), signupId, 'accepted')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Contributors see only their own entries and never other names.
    const bobView = await events.detail(bob, e.id);
    expect(bobView.pledges).toEqual([]);
    expect(bobView.signups.map(s => s.contributorName)).toEqual([null]);
    expect((await events.detail(organizer, e.id)).pledges[0]).toMatchObject({ status: 'received', contributorName: expect.any(String) });
  });

  it('discloses the exact location only to the organizer and accepted contributors', async () => {
    const e = await event();
    expect(e.privateLocation).toMatchObject({ exactLocation: POINT, note: 'Community hall, rear entrance' });
    const pledgeId = (await events.pledge(alice, key(), e.id, { needId: e.needs[0]!.id, quantity: 1, note: '' })).pledges[0]!.id;
    expect((await events.detail(alice, e.id)).privateLocation).toBeNull();
    expect((await events.detail(bob, e.id)).privateLocation).toBeNull();
    const nearby = await events.nearby(bob, POINT, 3);
    expect(JSON.stringify(nearby)).not.toContain(String(POINT.lat));
    expect(nearby.some(n => n.id === e.id)).toBe(true);
    await events.transitionPledge(organizer, key(), pledgeId, 'accepted');
    expect((await events.detail(alice, e.id)).privateLocation).toMatchObject({ exactLocation: POINT });
  });

  it('cancels open contributions once, preserves received goods and notifies contributors', async () => {
    const e = await event(10, 3);
    const needId = e.needs[0]!.id, slotId = e.slots[0]!.id;
    const received = (await events.pledge(alice, key(), e.id, { needId, quantity: 2, note: '' })).pledges[0]!.id;
    await events.transitionPledge(organizer, key(), received, 'accepted');
    await events.transitionPledge(organizer, key(), received, 'received');
    await events.pledge(bob, key(), e.id, { needId, quantity: 3, note: '' });
    await events.signup(carol, key(), e.id, slotId);
    const cancelKey = key();
    await Promise.all([events.cancel(organizer, cancelKey, e.id), events.cancel(organizer, cancelKey, e.id)]);
    await events.cancel(organizer, key(), e.id);
    const detail = await events.detail(organizer, e.id);
    expect(detail.status).toBe('cancelled');
    expect(detail.pledges.map(p => [p.id === received, p.status]).sort()).toEqual([[false, 'cancelled'], [true, 'received']]);
    expect(detail.signups.map(s => s.status)).toEqual(['cancelled']);
    expect(detail.pledges.every(p => p.allowedActions.length === 0)).toBe(true);
    const notices = await db.notification.findMany({ where: { title: 'Event cancelled', userId: { in: [alice, bob, carol] } } });
    expect(notices.map(n => n.userId).sort()).toEqual([alice, bob, carol].sort());
    await expect(events.pledge(alice, key(), e.id, { needId, quantity: 1, note: '' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await events.detail(alice, e.id)).privateLocation).toBeNull();
    expect((await events.nearby(alice, POINT, 3)).some(n => n.id === e.id)).toBe(false);
  });

  it('closes contributions once the event starts and rejects past start times', async () => {
    await expect(events.create(organizer, key(), CreateEventBodySchema.parse({ title: 'Too late', purpose: 'This should be refused.', startsAt: new Date(Date.now() - 60_000).toISOString(),
      areaLabel: 'Menteng', location: POINT, needs: [{ title: 'Rice', category: 'groceries', quantity: 2 }], slots: [] }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const e = await event();
    await db.charityEvent.update({ where: { id: e.id }, data: { startsAt: new Date(Date.now() - 60_000) } });
    await expect(events.pledge(alice, key(), e.id, { needId: e.needs[0]!.id, quantity: 1, note: '' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(events.signup(alice, key(), e.id, e.slots[0]!.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('replays an idempotent pledge instead of pledging twice', async () => {
    const e = await event(4);
    const k = key();
    await Promise.all([events.pledge(alice, k, e.id, { needId: e.needs[0]!.id, quantity: 2, note: '' }), events.pledge(alice, k, e.id, { needId: e.needs[0]!.id, quantity: 2, note: '' })]);
    expect((await events.detail(organizer, e.id)).needs[0]!.pledged).toBe(2);
  });
});
