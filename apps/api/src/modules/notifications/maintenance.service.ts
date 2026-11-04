import type { Db } from '../../lib/db.js';
import { DonationRequestsStore } from '../requests/requests.store.js';
import type { PushSender } from './push.adapter.js';
import { logger } from '../../lib/logger.js';

export class MaintenanceService {
  constructor(private readonly db: Db, private readonly push: PushSender | null) {}
  async expireRequests() {
    const candidates = await this.db.donationRequest.findMany({ where: { status: 'approved', pickupBy: { lte: new Date() } }, take: 100 });
    let expired = 0;
    for (const candidate of candidates) {
      await this.db.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM donation_requests WHERE id = ${candidate.id}::uuid FOR UPDATE`;
        const row = await tx.donationRequest.findUniqueOrThrow({ where: { id: candidate.id } });
        if (row.status !== 'approved' || !row.pickupBy || row.pickupBy > new Date()) return;
        await new DonationRequestsStore(this.db).transitionInTransaction(tx, row.id, 'system', 'expired');
        await tx.notification.createMany({ data: [row.ownerId, row.requesterId].map(userId => ({ userId, type: 'request_expired', title: 'Pickup window expired', body: 'An item request expired and its stock was released.', link: `/activity?request=${row.id}` })) });
        expired++;
      });
    }
    return expired;
  }
  /**
   * Food rescue expiry. Each outstanding request on a food offer past collect-by
   * is expired in its own transaction (request row locked first, the same order
   * as user transitions), so an approved reservation is released exactly once and
   * collected/cancelled requests are never touched. The listing is marked only
   * when no outstanding request remains under its FOR UPDATE lock, which also
   * waits for in-flight request inserts (they hold FOR SHARE). Reruns are no-ops.
   */
  async expireFoodOffers() {
    const store = new DonationRequestsStore(this.db);
    const listings = await this.db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM listings WHERE food_rescue AND food_expired_at IS NULL AND collect_by <= now() ORDER BY collect_by LIMIT 50`;
    let requests = 0, offers = 0;
    for (const { id } of listings) {
      const outstanding = await this.db.donationRequest.findMany({ where: { listingId: id, status: { in: ['pending', 'approved'] } }, select: { id: true }, orderBy: { id: 'asc' }, take: 200 });
      for (const candidate of outstanding) {
        const done = await this.db.$transaction(async tx => {
          await tx.$queryRaw`SELECT id FROM donation_requests WHERE id = ${candidate.id}::uuid FOR UPDATE`;
          const row = await tx.donationRequest.findUniqueOrThrow({ where: { id: candidate.id } });
          if (row.status !== 'pending' && row.status !== 'approved') return false;
          await store.transitionInTransaction(tx, row.id, 'system', 'expired');
          await tx.notification.create({ data: { userId: row.requesterId, type: 'request_expired',
            title: 'Food collect-by time passed', body: row.status === 'approved' ? 'The food you reserved was not collected in time. Your reservation was released.' : 'This food offer closed before your request was approved.',
            link: `/activity?request=${row.id}` } });
          return true;
        });
        if (done) requests++;
      }
      const marked = await this.db.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM listings WHERE id = ${id}::uuid FOR UPDATE`;
        if (await tx.donationRequest.count({ where: { listingId: id, status: { in: ['pending', 'approved'] } } })) return false;
        const listing = await tx.listing.findUniqueOrThrow({ where: { id }, select: { ownerId: true, title: true, stockCollected: true } });
        const n = await tx.$executeRaw`UPDATE listings SET food_expired_at = now() WHERE id = ${id}::uuid AND food_expired_at IS NULL AND collect_by <= now()`;
        if (n !== 1) return false;
        await tx.notification.create({ data: { userId: listing.ownerId, type: 'request_expired', title: 'Food offer closed',
          body: `${listing.title.slice(0, 120)} passed its collect-by time. Outstanding requests were closed and any reservations released.`, link: `/listings/${id}` } });
        return true;
      });
      if (marked) offers++;
    }
    return { requests, offers };
  }
  async deliverPush() {
    if (!this.push) return 0;
    const claimed = await this.db.$transaction(async tx => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM notifications WHERE push_sent_at IS NULL AND push_attempts < 5 AND next_push_at <= now() AND (push_started_at IS NULL OR push_started_at < now() - interval '2 minutes') ORDER BY next_push_at LIMIT 20 FOR UPDATE SKIP LOCKED`;
      await tx.notification.updateMany({ where: { id: { in: rows.map(r => r.id) } }, data: { pushStartedAt: new Date(), pushAttempts: { increment: 1 } } });
      return tx.notification.findMany({ where: { id: { in: rows.map(r => r.id) } } });
    });
    let delivered = 0;
    for (const row of claimed) {
      try {
        const tokens = row.readAt ? [] : (await this.db.pushToken.findMany({ where: { userId: row.userId }, take: 20 })).map(t => t.token);
        const result = await this.push.send(tokens, { title: 'NeighbourHood update', body: 'You have an update. Open your inbox to view it.', link: row.link?.startsWith('/') && !row.link.startsWith('//') ? row.link : '/notifications' });
        await this.db.pushToken.deleteMany({ where: { userId: row.userId, token: { in: result.invalidTokens } } });
        if (result.successCount < tokens.length - result.invalidTokens.length) throw new Error('Partial push delivery');
        await this.db.notification.update({ where: { id: row.id }, data: { pushSentAt: new Date(), pushStartedAt: null } });
        delivered++;
      } catch {
        logger.warn('push_delivery_retry', { notificationId: row.id });
        await this.db.notification.update({ where: { id: row.id }, data: { pushStartedAt: null, nextPushAt: new Date(Date.now() + Math.min(3600, 30 * 2 ** row.pushAttempts) * 1000) } });
      }
    }
    return delivered;
  }
  async run() {
    const expired = await this.expireRequests();
    const food = await this.expireFoodOffers();
    return { expired, foodRequestsExpired: food.requests, foodOffersClosed: food.offers, pushed: await this.deliverPush() };
  }
}
