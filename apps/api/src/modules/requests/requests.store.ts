import {
  type Actor,
  assertNotSelfRequest,
  assertTransition,
  DomainError,
  type DonationRequestStatus,
  donationRequestMachine,
} from '@neighbourhood/shared';
import type { Db, Tx } from '../../lib/db.js';
import { pgErrorCode } from '../../lib/db.js';
import { PrismaAccessRepository, hasCommunityRole } from '../auth/access.js';

/**
 * PostgreSQL persistence for donation requests with atomic stock accounting.
 * Pending requests never reserve stock.
 *
 *   approve  : pending  → approved   reserve  (stock_reserved += q)
 *   cancel   : approved → cancelled  release  (stock_reserved -= q)
 *   expire   : approved → expired    release
 *   collect  : approved → collected  reserved → collected
 *
 * Each transition: lock the request row (FOR UPDATE), resolve the actor from
 * stored records, check the state machine, then a conditional UPDATE on the
 * listing whose WHERE clause re-checks availability under the row lock — so
 * concurrent approvals cannot oversell. CHECK constraints are the backstop.
 */
export class DonationRequestsStore {
  constructor(private readonly db: Db) {}

  async create(input: { listingId: string; requesterId: string; quantity: number; message: string }, tx: Db | Tx = this.db) {
    // FOR SHARE: food expiry maintenance locks the listing FOR UPDATE, so a request
    // that passed the deadline check is always visible to the expiry sweep.
    const locked = await tx.$queryRaw<Array<{ food_open: boolean }>>`
      SELECT (NOT food_rescue OR collect_by > now()) AS food_open FROM listings WHERE id = ${input.listingId}::uuid FOR SHARE`;
    const listing = await tx.listing.findUnique({
      where: { id: input.listingId },
      select: { ownerId: true, status: true, mode: true, bestBefore: true },
    });
    if (!listing || listing.status !== 'active' || listing.mode !== 'donate') {
      throw new DomainError('CONFLICT', 'This item is not available for requests');
    }
    if (locked[0]?.food_open === false) throw new DomainError('CONFLICT', 'The collect-by time for this food has passed');
    assertNotSelfRequest(listing.ownerId, input.requesterId);
    if (listing.bestBefore && listing.bestBefore.toISOString().slice(0, 10) < new Date().toISOString().slice(0, 10)) throw new DomainError('CONFLICT', 'This item is past its listed date');
    try {
      return await tx.donationRequest.create({
        data: { ...input, ownerId: listing.ownerId },
      });
    } catch (err) {
      const code = pgErrorCode(err);
      if (code === '23505') throw new DomainError('CONFLICT', 'You already have an active request for this item');
      if (code === '23514') throw new DomainError('SELF_REQUEST', 'You cannot request your own item');
      throw err;
    }
  }

  transition(requestId: string, actorUserId: string, to: Exclude<DonationRequestStatus, 'pending'>, opts: TransitionOptions = {}) {
    return this.db.$transaction((tx) => this.transitionInTransaction(tx, requestId, actorUserId, to, opts));
  }

  /**
   * Food rescue: approval and collection are refused once collect-by has passed
   * (whatever maintenance has done so far); cancellation still releases stock.
   * A pickup deadline never exceeds collect-by: a default is shortened to it,
   * an explicit later deadline is rejected.
   */
  async transitionInTransaction(tx: Tx, requestId: string, actorUserId: string, to: Exclude<DonationRequestStatus, 'pending'>, opts: TransitionOptions = {}) {
    const rows = await tx.$queryRaw<Array<{ id: string; listing_id: string; owner_id: string; requester_id: string; quantity: number; status: DonationRequestStatus }>>`
      SELECT id, listing_id, owner_id, requester_id, quantity, status
      FROM donation_requests WHERE id = ${requestId}::uuid FOR UPDATE`;
    const req = rows[0];
    if (!req) throw new DomainError('BAD_REQUEST', 'Request not found');

    const actor = actorUserId === 'system' ? 'system' : await resolveActor(tx, actorUserId, req);
    assertTransition(donationRequestMachine, req.status, to, actor);
    const pointListing = await tx.listing.findUnique({ where: { id: req.listing_id }, select: { communityPointId: true, pointInventoryItemId: true, foodRescue: true, collectBy: true } });
    let pickupBy = opts.pickupBy;
    if (pointListing?.foodRescue && (to === 'approved' || to === 'collected')) {
      const collectBy = pointListing.collectBy!;
      if (collectBy.getTime() <= Date.now()) throw new DomainError('CONFLICT', 'The collect-by time for this food has passed');
      if (to === 'approved' && pickupBy && pickupBy > collectBy) {
        if (opts.pickupByExplicit) throw new DomainError('BAD_REQUEST', 'Pickup deadline cannot be later than the food collect-by time');
        pickupBy = collectBy;
      }
    }
    if (pointListing?.pointInventoryItemId && pointListing.communityPointId) await tx.$queryRaw`SELECT id FROM community_points WHERE id = ${pointListing.communityPointId}::uuid FOR UPDATE`;

    if (to === 'approved') await reserve(tx, req.listing_id, req.quantity);
    else if (req.status === 'approved' && (to === 'cancelled' || to === 'expired')) await release(tx, req.listing_id, req.quantity);
    else if (to === 'collected') await collect(tx, req.listing_id, req.quantity);
    if (pointListing?.pointInventoryItemId) {
      const id = pointListing.pointInventoryItemId;
      let changed = 1;
      if (to === 'approved') changed = await tx.$executeRaw`UPDATE point_inventory_items SET available = available - ${req.quantity}, reserved = reserved + ${req.quantity}, updated_at = now() WHERE id = ${id}::uuid AND available >= ${req.quantity}`;
      else if (req.status === 'approved' && (to === 'cancelled' || to === 'expired')) changed = await tx.$executeRaw`UPDATE point_inventory_items SET available = available + ${req.quantity}, reserved = reserved - ${req.quantity}, updated_at = now() WHERE id = ${id}::uuid AND reserved >= ${req.quantity}`;
      else if (to === 'collected') {
        changed = await tx.$executeRaw`UPDATE point_inventory_items SET reserved = reserved - ${req.quantity}, updated_at = now() WHERE id = ${id}::uuid AND reserved >= ${req.quantity}`;
        await tx.stockAdjustment.create({ data: { pointId: pointListing.communityPointId!, itemId: id, delta: -req.quantity, reason: 'collected', actorId: actorUserId, requestId, note: 'Collected after approved request' } });
      }
      if (changed !== 1) throw new DomainError('INSUFFICIENT_STOCK', 'Point stock changed; review inventory');
    }

    return tx.donationRequest.update({
      where: { id: requestId },
      data: { status: to, ...(to === 'approved' && pickupBy ? { pickupBy } : {}) },
    });
  }
}

export interface TransitionOptions { pickupBy?: Date; pickupByExplicit?: boolean }

async function resolveActor(
  tx: Tx,
  userId: string,
  req: { listing_id: string; owner_id: string; requester_id: string },
): Promise<Actor> {
  if (userId === req.owner_id) return 'owner';
  if (userId === req.requester_id) return 'requester';
  // Volunteers of the community that runs the listing's collection point.
  const listing = await tx.listing.findUnique({
    where: { id: req.listing_id },
    select: { communityPoint: { select: { communityId: true } } },
  });
  const communityId = listing?.communityPoint?.communityId;
  if (communityId) {
    const m = await new PrismaAccessRepository(tx).getMembership(communityId, userId);
    if (hasCommunityRole(m, 'volunteer')) return 'volunteer';
  }
  throw new DomainError('FORBIDDEN', 'You are not a participant in this request');
}

async function reserve(tx: Tx, listingId: string, qty: number) {
  const n = await tx.$executeRaw`
    UPDATE listings SET stock_reserved = stock_reserved + ${qty}, updated_at = now()
    WHERE id = ${listingId}::uuid AND status = 'active'
      AND (best_before IS NULL OR best_before >= CURRENT_DATE)
      AND (NOT food_rescue OR collect_by > now())
      AND stock_total - stock_reserved - stock_collected >= ${qty}`;
  if (n !== 1) throw new DomainError('INSUFFICIENT_STOCK', 'Not enough units available, or the listing is not active');
}

async function release(tx: Tx, listingId: string, qty: number) {
  const n = await tx.$executeRaw`
    UPDATE listings SET stock_reserved = stock_reserved - ${qty}, updated_at = now()
    WHERE id = ${listingId}::uuid AND stock_reserved >= ${qty}`;
  if (n !== 1) throw new DomainError('CONFLICT', 'Reserved stock is inconsistent');
}

async function collect(tx: Tx, listingId: string, qty: number) {
  const n = await tx.$executeRaw`
    UPDATE listings SET stock_reserved = stock_reserved - ${qty}, stock_collected = stock_collected + ${qty}, updated_at = now()
    WHERE id = ${listingId}::uuid AND stock_reserved >= ${qty} AND (best_before IS NULL OR best_before >= CURRENT_DATE)
      AND (NOT food_rescue OR collect_by > now())`;
  if (n !== 1) throw new DomainError('CONFLICT', 'Reserved stock is inconsistent');
}
