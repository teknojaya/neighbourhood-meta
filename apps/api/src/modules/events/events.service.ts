
import {
  approximateLocation, geohashFor, geohashRanges, EVENT_LIMITS,
  CharityEventDetailSchema, CharityEventSummarySchema,
  type CreateEventBody, type EventPledgeStatus, type VolunteerSignupStatus,
} from '@neighbourhood/shared';
import { type Db, type Tx, Prisma, pgErrorCode } from '../../lib/db.js';
import { HttpError } from '../../lib/http.js';
import { runIdempotent } from '../requests/idempotency.js';

type Role = 'organizer' | 'contributor';
/** Allowed pledge moves per actor. `received` is recorded by the organizer only. */
const PLEDGE_RULES: Record<Role, Partial<Record<EventPledgeStatus, EventPledgeStatus[]>>> = {
  organizer: { pledged: ['accepted', 'cancelled'], accepted: ['received', 'cancelled'] },
  contributor: { pledged: ['cancelled'], accepted: ['cancelled'] },
};
const SIGNUP_RULES: Record<Role, Partial<Record<VolunteerSignupStatus, VolunteerSignupStatus[]>>> = {
  organizer: { pending: ['accepted', 'cancelled'], accepted: ['cancelled'] },
  contributor: { pending: ['cancelled'], accepted: ['cancelled'] },
};
const LIVE_PLEDGE: EventPledgeStatus[] = ['pledged', 'accepted', 'received'];
const LIVE_SIGNUP: VolunteerSignupStatus[] = ['pending', 'accepted'];
const EARTH_RADIUS_KM = 6371;

const include = {
  organizer: { select: { displayName: true } },
  needs: { orderBy: { position: 'asc' as const } },
  slots: { orderBy: { position: 'asc' as const } },
};
type EventRow = Prisma.CharityEventGetPayload<{ include: typeof include }>;

export class EventsService {
  constructor(private readonly db: Db) {}

  async create(userId: string, key: string, body: CreateEventBody) {
    const result = await runIdempotent(this.db, userId, key, 'events:create', body, async tx => {
      const startsAt = new Date(body.startsAt), now = Date.now();
      if (startsAt.getTime() <= now) throw new HttpError('VALIDATION_FAILED', 'The event must start in the future');
      if (startsAt.getTime() > now + EVENT_LIMITS.maxDaysAhead * 86_400_000) throw new HttpError('VALIDATION_FAILED', `Events can be planned up to ${EVENT_LIMITS.maxDaysAhead} days ahead`);
      const row = await tx.charityEvent.create({ data: {
        organizerId: userId, title: body.title, purpose: body.purpose, startsAt, endsAt: body.endsAt ? new Date(body.endsAt) : null,
        areaLabel: body.areaLabel, lat: body.location.lat, lng: body.location.lng, geohash: geohashFor(body.location), privateNote: body.privateNote,
        needs: { create: body.needs.map((need, position) => ({ ...need, position })) },
        slots: { create: body.slots.map((slot, position) => ({ ...slot, position })) },
      } });
      return { status: 201, body: { id: row.id } };
    });
    return this.detail(userId, result.body.id);
  }

  /** Organizer cancellation: open contributions are cancelled and their owners notified once. Received goods stay recorded. */
  async cancel(userId: string, key: string, eventId: string) {
    await runIdempotent(this.db, userId, key, `events:${eventId}:cancel`, {}, async tx => {
      const event = await this.lockEvent(tx, eventId, 'UPDATE');
      if (event.organizerId !== userId) throw new HttpError('FORBIDDEN', 'Only the organizer can cancel this event');
      if (event.status === 'cancelled') return { status: 200, body: { id: eventId } };
      // Contributors whose goods were already received are told too; their record is kept.
      const pledges = await tx.eventPledge.findMany({ where: { eventId, status: { in: LIVE_PLEDGE } }, select: { userId: true } });
      const signups = await tx.volunteerSignup.findMany({ where: { eventId, status: { in: LIVE_SIGNUP } }, select: { userId: true } });
      await tx.eventPledge.updateMany({ where: { eventId, status: { in: ['pledged', 'accepted'] } }, data: { status: 'cancelled' } });
      await tx.volunteerSignup.updateMany({ where: { eventId, status: { in: LIVE_SIGNUP } }, data: { status: 'cancelled' } });
      await tx.charityEvent.update({ where: { id: eventId }, data: { status: 'cancelled', cancelledAt: new Date() } });
      const affected = [...new Set([...pledges, ...signups].map(p => p.userId))];
      await tx.notification.createMany({ data: affected.map(id => ({ userId: id, type: 'request_cancelled', title: 'Event cancelled',
        body: `${event.title.slice(0, 200)} was cancelled by the organizer. Open pledges and volunteer sign-ups were cancelled; goods already received stay recorded.`, link: `/events/${eventId}` })) });
      return { status: 200, body: { id: eventId } };
    });
    return this.detail(userId, eventId);
  }

  async pledge(userId: string, key: string, eventId: string, body: { needId: string; quantity: number; note: string }) {
    await runIdempotent(this.db, userId, key, `events:${eventId}:pledge`, body, async tx => {
      const event = await this.lockEvent(tx, eventId, 'SHARE');
      this.assertOpen(event, userId);
      await tx.$queryRaw`SELECT id FROM event_needs WHERE id = ${body.needId}::uuid FOR UPDATE`;
      const need = await tx.eventNeed.findFirst({ where: { id: body.needId, eventId } });
      if (!need) throw new HttpError('NOT_FOUND', 'Need not found');
      const committed = await tx.eventPledge.aggregate({ where: { needId: need.id, status: { in: LIVE_PLEDGE } }, _sum: { quantity: true } });
      const remaining = need.quantity - (committed._sum.quantity ?? 0);
      if (body.quantity > remaining) throw new HttpError('INSUFFICIENT_STOCK', remaining > 0 ? `Only ${remaining} more ${need.title} needed` : `${need.title} is fully pledged`);
      const row = await tx.eventPledge.create({ data: { eventId, needId: need.id, userId, quantity: body.quantity, note: body.note } });
      await tx.notification.create({ data: { userId: event.organizerId, type: 'request_received', title: 'New pledge for your event',
        body: `A neighbour pledged ${body.quantity} × ${need.title.slice(0, 100)}. Accept it, then mark it received when it arrives.`, link: `/events/${eventId}` } });
      return { status: 201, body: { id: row.id } };
    });
    return this.detail(userId, eventId);
  }

  async transitionPledge(userId: string, key: string, pledgeId: string, to: Exclude<EventPledgeStatus, 'pledged'>) {
    const found = await this.db.eventPledge.findUnique({ where: { id: pledgeId }, select: { eventId: true } });
    if (!found) throw new HttpError('NOT_FOUND', 'Pledge not found');
    await runIdempotent(this.db, userId, key, `events:pledge:${pledgeId}`, { to }, async tx => {
      const event = await this.lockEvent(tx, found.eventId, 'SHARE');
      await tx.$queryRaw`SELECT id FROM event_pledges WHERE id = ${pledgeId}::uuid FOR UPDATE`;
      const pledge = await tx.eventPledge.findUniqueOrThrow({ where: { id: pledgeId }, include: { need: { select: { title: true } } } });
      const role = this.role(event.organizerId, pledge.userId, userId);
      if (!role) throw new HttpError('NOT_FOUND', 'Pledge not found');
      if (!PLEDGE_RULES[role][pledge.status]?.includes(to)) throw new HttpError('FORBIDDEN', `This pledge cannot move from ${pledge.status} to ${to}`);
      if (event.status === 'cancelled') throw new HttpError('CONFLICT', 'This event was cancelled');
      await tx.eventPledge.update({ where: { id: pledgeId }, data: { status: to } });
      const other = role === 'organizer' ? pledge.userId : event.organizerId;
      const verb = { accepted: 'accepted', received: 'marked as received', cancelled: 'cancelled' }[to];
      await tx.notification.create({ data: { userId: other, type: to === 'received' ? 'request_collected' : to === 'accepted' ? 'request_approved' : 'request_cancelled',
        title: `Pledge ${verb}`, body: `${pledge.quantity} × ${pledge.need.title.slice(0, 100)} for ${event.title.slice(0, 100)} was ${verb}.`, link: `/events/${event.id}` } });
      return { status: 200, body: { id: pledgeId } };
    });
    return this.detail(userId, found.eventId);
  }

  async signup(userId: string, key: string, eventId: string, slotId: string) {
    await runIdempotent(this.db, userId, key, `events:${eventId}:slot:${slotId}:signup`, {}, async tx => {
      const event = await this.lockEvent(tx, eventId, 'SHARE');
      this.assertOpen(event, userId);
      await tx.$queryRaw`SELECT id FROM volunteer_slots WHERE id = ${slotId}::uuid FOR UPDATE`;
      const slot = await tx.volunteerSlot.findFirst({ where: { id: slotId, eventId } });
      if (!slot) throw new HttpError('NOT_FOUND', 'Volunteer slot not found');
      if (await tx.volunteerSignup.count({ where: { slotId, status: { in: LIVE_SIGNUP } } }) >= slot.capacity) throw new HttpError('INSUFFICIENT_STOCK', 'This volunteer slot is full');
      try {
        await tx.volunteerSignup.create({ data: { slotId, eventId, userId } });
      } catch (error) {
        if (pgErrorCode(error) === '23505') throw new HttpError('CONFLICT', 'You already signed up for this slot');
        throw error;
      }
      await tx.notification.create({ data: { userId: event.organizerId, type: 'request_received', title: 'New volunteer sign-up',
        body: `A neighbour offered to help with ${slot.title.slice(0, 100)}.`, link: `/events/${eventId}` } });
      return { status: 201, body: { slotId } };
    });
    return this.detail(userId, eventId);
  }

  async transitionSignup(userId: string, key: string, signupId: string, to: Exclude<VolunteerSignupStatus, 'pending'>) {
    const found = await this.db.volunteerSignup.findUnique({ where: { id: signupId }, select: { eventId: true, slotId: true } });
    if (!found) throw new HttpError('NOT_FOUND', 'Sign-up not found');
    await runIdempotent(this.db, userId, key, `events:signup:${signupId}`, { to }, async tx => {
      const event = await this.lockEvent(tx, found.eventId, 'SHARE');
      await tx.$queryRaw`SELECT id FROM volunteer_slots WHERE id = ${found.slotId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM volunteer_signups WHERE id = ${signupId}::uuid FOR UPDATE`;
      const signup = await tx.volunteerSignup.findUniqueOrThrow({ where: { id: signupId }, include: { slot: true } });
      const role = this.role(event.organizerId, signup.userId, userId);
      if (!role) throw new HttpError('NOT_FOUND', 'Sign-up not found');
      if (!SIGNUP_RULES[role][signup.status]?.includes(to)) throw new HttpError('FORBIDDEN', `This sign-up cannot move from ${signup.status} to ${to}`);
      if (event.status === 'cancelled') throw new HttpError('CONFLICT', 'This event was cancelled');
      if (to === 'accepted' && await tx.volunteerSignup.count({ where: { slotId: signup.slotId, status: 'accepted' } }) >= signup.slot.capacity) throw new HttpError('INSUFFICIENT_STOCK', 'This volunteer slot is full');
      await tx.volunteerSignup.update({ where: { id: signupId }, data: { status: to } });
      await tx.notification.create({ data: { userId: role === 'organizer' ? signup.userId : event.organizerId, type: to === 'accepted' ? 'request_approved' : 'request_cancelled',
        title: `Volunteer sign-up ${to}`, body: `${signup.slot.title.slice(0, 100)} for ${event.title.slice(0, 100)} was ${to}.`, link: `/events/${event.id}` } });
      return { status: 200, body: { id: signupId } };
    });
    return this.detail(userId, found.eventId);
  }

  async nearby(userId: string, center: { lat: number; lng: number }, radiusKm: number) {
    const ranges = geohashRanges(center, radiusKm);
    const rangeSql = Prisma.join(ranges.map(([s, e]) => Prisma.sql`(e.geohash COLLATE "C" >= ${s} AND e.geohash COLLATE "C" <= ${e})`), ' OR ');
    const rows = await this.db.$queryRaw<Array<{ id: string; distanceKm: number }>>`
      SELECT * FROM (SELECT e.id, ${EARTH_RADIUS_KM} * 2 * asin(sqrt(power(sin(radians(e.lat - ${center.lat}) / 2), 2) +
        cos(radians(${center.lat})) * cos(radians(e.lat)) * power(sin(radians(e.lng - ${center.lng}) / 2), 2))) AS "distanceKm"
        FROM charity_events e WHERE e.status = 'published' AND COALESCE(e.ends_at, e.starts_at) > now() AND (${rangeSql})) c
      WHERE c."distanceKm" <= ${radiusKm} ORDER BY c."distanceKm", c.id LIMIT 30`;
    const full = new Map((await this.db.charityEvent.findMany({ where: { id: { in: rows.map(r => r.id) } }, include })).map(row => [row.id, row]));
    return Promise.all(rows.flatMap(r => { const row = full.get(r.id); return row ? [this.summary(row, userId, r.distanceKm)] : []; }));
  }

  async mine(userId: string) {
    const rows = await this.db.charityEvent.findMany({ where: { OR: [{ organizerId: userId }, { pledges: { some: { userId } } }, { signups: { some: { userId } } }] }, include, orderBy: { startsAt: 'asc' }, take: 50 });
    return Promise.all(rows.map(row => this.summary(row, userId)));
  }

  async detail(userId: string, eventId: string) {
    const row = await this.db.charityEvent.findUnique({ where: { id: eventId }, include });
    if (!row) throw new HttpError('NOT_FOUND', 'Event not found');
    const organizer = row.organizerId === userId;
    // Contributors see only their own contributions; names are visible to the organizer only.
    const scope = organizer ? { eventId } : { eventId, userId };
    const [pledges, signups] = await Promise.all([
      this.db.eventPledge.findMany({ where: scope, include: { need: { select: { title: true } }, user: { select: { displayName: true } } }, orderBy: { createdAt: 'asc' } }),
      this.db.volunteerSignup.findMany({ where: scope, include: { slot: { select: { title: true } }, user: { select: { displayName: true } } }, orderBy: { createdAt: 'asc' } }),
    ]);
    const accepted = pledges.some(p => p.userId === userId && (p.status === 'accepted' || p.status === 'received')) || signups.some(s => s.userId === userId && s.status === 'accepted');
    const disclose = organizer || (row.status === 'published' && accepted);
    const role = (ownerId: string): Role | null => this.role(row.organizerId, ownerId, userId);
    return CharityEventDetailSchema.parse({
      ...await this.summary(row, userId),
      pledges: pledges.map(p => ({ id: p.id, needId: p.needId, needTitle: p.need.title, quantity: p.quantity, note: p.note, status: p.status,
        contributorName: organizer ? p.user.displayName ?? 'Neighbour' : null, mine: p.userId === userId, createdAt: p.createdAt.toISOString(),
        allowedActions: row.status === 'cancelled' ? [] : PLEDGE_RULES[role(p.userId)!][p.status] ?? [] })),
      signups: signups.map(s => ({ id: s.id, slotId: s.slotId, slotTitle: s.slot.title, status: s.status,
        contributorName: organizer ? s.user.displayName ?? 'Neighbour' : null, mine: s.userId === userId, createdAt: s.createdAt.toISOString(),
        allowedActions: row.status === 'cancelled' ? [] : SIGNUP_RULES[role(s.userId)!][s.status] ?? [] })),
      privateLocation: disclose ? { exactLocation: { lat: row.lat, lng: row.lng }, note: row.privateNote } : null,
    });
  }

  private async summary(row: EventRow, userId: string, distanceKm?: number) {
    const [pledged, received, taken, acceptedSignups] = await Promise.all([
      this.db.eventPledge.groupBy({ by: ['needId'], where: { eventId: row.id, status: { in: LIVE_PLEDGE } }, _sum: { quantity: true } }),
      this.db.eventPledge.groupBy({ by: ['needId'], where: { eventId: row.id, status: 'received' }, _sum: { quantity: true } }),
      this.db.volunteerSignup.groupBy({ by: ['slotId'], where: { eventId: row.id, status: { in: LIVE_SIGNUP } }, _count: { _all: true } }),
      this.db.volunteerSignup.groupBy({ by: ['slotId'], where: { eventId: row.id, status: 'accepted' }, _count: { _all: true } }),
    ]);
    const sum = (rows: typeof pledged, id: string) => rows.find(r => r.needId === id)?._sum.quantity ?? 0;
    const count = (rows: typeof taken, id: string) => rows.find(r => r.slotId === id)?._count._all ?? 0;
    return CharityEventSummarySchema.parse({ id: row.id, title: row.title, purpose: row.purpose, status: row.status,
      startsAt: row.startsAt.toISOString(), endsAt: row.endsAt?.toISOString() ?? null,
      location: approximateLocation({ lat: row.lat, lng: row.lng }, row.areaLabel, distanceKm),
      organizerId: row.organizerId, organizerName: row.organizer.displayName ?? 'Neighbour', isOrganizer: row.organizerId === userId,
      needs: row.needs.map(n => ({ id: n.id, title: n.title, category: n.category, quantity: n.quantity, pledged: sum(pledged, n.id), received: sum(received, n.id) })),
      slots: row.slots.map(s => ({ id: s.id, title: s.title, capacity: s.capacity, taken: count(taken, s.id), accepted: count(acceptedSignups, s.id) })) });
  }

  private async lockEvent(tx: Tx, eventId: string, mode: 'UPDATE' | 'SHARE') {
    if (mode === 'UPDATE') await tx.$queryRaw`SELECT id FROM charity_events WHERE id = ${eventId}::uuid FOR UPDATE`;
    else await tx.$queryRaw`SELECT id FROM charity_events WHERE id = ${eventId}::uuid FOR SHARE`;
    const event = await tx.charityEvent.findUnique({ where: { id: eventId } });
    if (!event) throw new HttpError('NOT_FOUND', 'Event not found');
    return event;
  }

  private assertOpen(event: { status: string; startsAt: Date; organizerId: string }, userId: string) {
    if (event.status !== 'published') throw new HttpError('CONFLICT', 'This event was cancelled');
    if (event.startsAt.getTime() <= Date.now()) throw new HttpError('CONFLICT', 'This event has already started');
    if (event.organizerId === userId) throw new HttpError('SELF_REQUEST', 'Organizers manage their own event rather than contributing to it');
  }

  private role(organizerId: string, contributorId: string, userId: string): Role | null {
    if (userId === organizerId) return 'organizer';
    if (userId === contributorId) return 'contributor';
    return null;
  }
}

