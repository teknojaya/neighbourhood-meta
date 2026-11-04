import { createHash, randomUUID } from 'node:crypto';
import { type CreateListingBody, type UpdateListingBody, type ListingStatus, type ItemCategory, type ListingMode,
  ListingPublicSchema, ListingPrivateSchema, geohashFor, approximateLocation, listingMachine, assertTransition } from '@neighbourhood/shared';
import { type Db, type Tx, Prisma } from '../../lib/db.js';
import { HttpError } from '../../lib/http.js';
import type { ObjectStorage } from '../../lib/storage.js';
import { runIdempotent } from '../requests/idempotency.js';
import { normalizeImage } from '../ask/ask.images.js';
import { normalizeListingSearch } from './search-terms.js';
import { searchNearbyListings } from './listings.repository.js';
import { assertFutureCollectBy, assertPreparedNotInFuture, foodCreateData, foodExpired, foodPublic } from './food-rescue.js';

const include = { owner: { select: { displayName: true } }, photos: { orderBy: { position: 'asc' as const } } };
type Row = Prisma.ListingGetPayload<{ include: typeof include }>;
export class ListingsService {
  constructor(private readonly db: Db, private readonly storage?: ObjectStorage) {}
  private async lock(tx: Tx, id: string, ownerId: string) {
    await tx.$queryRaw`SELECT id FROM listings WHERE id = ${id}::uuid FOR UPDATE`;
    const row = await tx.listing.findUnique({ where: { id } });
    if (!row) throw new HttpError('NOT_FOUND', 'Item not found');
    if (row.ownerId !== ownerId) throw new HttpError('FORBIDDEN', 'Only the owner can change this item');
    return row;
  }
  async createListing(ownerId: string, input: CreateListingBody, key: string = randomUUID()) {
    if (input.bestBefore && input.bestBefore < new Date().toISOString().slice(0, 10)) throw new HttpError('VALIDATION_FAILED', 'Do not publish expired items');
    const result = await runIdempotent(this.db, ownerId, key, 'listing:create', input, async tx => {
      // Checked inside the transaction so a replayed key returns the original result even after the deadline.
      const food = foodCreateData(input.food ?? null);
      let point: Prisma.CommunityPointGetPayload<object> | null = null;
      let bestBefore = input.bestBefore ? new Date(input.bestBefore) : null;
      if (input.collection.method === 'community_point') {
        await tx.$queryRaw`SELECT id FROM community_points WHERE id = ${input.collection.communityPointId}::uuid FOR UPDATE`;
        point = await tx.communityPoint.findFirst({ where: { id: input.collection.communityPointId!, active: true, community: { members: { some: { userId: ownerId, status: 'active', role: { in: ['volunteer', 'moderator'] } } } } } });
        if (!point) throw new HttpError('FORBIDDEN', 'Only point volunteers can publish point inventory');
        const stock = input.pointInventoryItemId ? await tx.pointInventoryItem.findFirst({ where: { id: input.pointInventoryItemId, pointId: point.id }, include: { listing: true } }) : null;
        if (!stock || stock.listing || stock.reserved || stock.available !== input.quantity || stock.category !== input.category || input.mode !== 'donate') throw new HttpError('CONFLICT', 'Choose unlisted confirmed point stock and review its current full quantity');
        bestBefore = stock.bestBefore;
        if (bestBefore && bestBefore.toISOString().slice(0, 10) < new Date().toISOString().slice(0, 10)) throw new HttpError('CONFLICT', 'Confirmed point stock is past its best-before date');
      } else if (input.pointInventoryItemId) {
        throw new HttpError('VALIDATION_FAILED', 'Point inventory requires point collection');
      }
      const row = await tx.listing.create({ data: {
        ownerId, status: 'draft', mode: input.mode, category: input.category, title: input.title,
        description: input.description, condition: input.condition, stockTotal: input.quantity,
        areaLabel: point?.areaLabel ?? input.areaLabel, lat: point?.lat ?? input.exactLocation.lat, lng: point?.lng ?? input.exactLocation.lng, geohash: point?.geohash ?? geohashFor(input.exactLocation),
        pointInventoryItemId: input.pointInventoryItemId ?? null,
        collectionMethod: input.collection.method, communityPointId: input.collection.communityPointId,
        appliance: input.appliance ?? Prisma.JsonNull, maxLoanDays: input.lending?.maxLoanDays ?? null,
        lendingNotes: input.lending?.notes ?? null, bestBefore, ...food,
        private: { create: { pickupInstructions: point ? `${point.exactAddress}\n${input.pickupInstructions}`.slice(0, 1000) : input.pickupInstructions } },
      } });
      return { status: 201, body: { id: row.id } };
    });
    return (await this.getListingDetail(ownerId, result.body.id)).listing;
  }
  async updateListing(ownerId: string, id: string, input: UpdateListingBody, key: string = randomUUID(), expectedUpdatedAt?: string) {
    await runIdempotent(this.db, ownerId, key, `listing:${id}:edit`, input, async tx => {
      const row = await this.lock(tx, id, ownerId);
      if (expectedUpdatedAt && row.updatedAt.toISOString() !== expectedUpdatedAt) throw new HttpError('CONFLICT', 'Listing changed; review a new preview');
      if (row.status === 'closed') throw new HttpError('CONFLICT', 'This listing is closed');
      if (input.quantity !== undefined && input.quantity < row.stockReserved + row.stockCollected) throw new HttpError('CONFLICT', 'Quantity is below committed stock');
      if (row.pointInventoryItemId && input.quantity !== undefined && input.quantity !== row.stockTotal) throw new HttpError('CONFLICT', 'Adjust community stock with an audited inventory change');
      if (row.pointInventoryItemId && input.bestBefore !== undefined && input.bestBefore !== (row.bestBefore?.toISOString().slice(0, 10) ?? null)) throw new HttpError('CONFLICT', 'The best-before date belongs to the confirmed point inventory');
      if (row.mode === 'lend' && input.quantity !== undefined && input.quantity !== 1) throw new HttpError('VALIDATION_FAILED', 'Lending items have quantity one');
      if (input.lending === null && row.mode === 'lend') throw new HttpError('VALIDATION_FAILED', 'Lending terms are required');
      if (row.category === 'appliances' && input.appliance === null) throw new HttpError('VALIDATION_FAILED', 'Keep the appliance condition and pickup access details');
      const food = input.food ? await this.foodEdit(tx, row, input.food) : {};
      await tx.listing.update({ where: { id }, data: { title: input.title, description: input.description, condition: input.condition,
        stockTotal: input.quantity, areaLabel: input.areaLabel,
        appliance: input.appliance === undefined ? undefined : input.appliance ?? Prisma.JsonNull,
        maxLoanDays: input.lending === undefined ? undefined : input.lending?.maxLoanDays ?? null,
        lendingNotes: input.lending === undefined ? undefined : input.lending?.notes ?? null,
        bestBefore: input.bestBefore === undefined ? undefined : input.bestBefore ? new Date(input.bestBefore) : null, ...food,
      } });
      if (input.pickupInstructions !== undefined) await tx.listingPrivate.upsert({ where: { listingId: id }, create: { listingId: id, pickupInstructions: input.pickupInstructions }, update: { pickupInstructions: input.pickupInstructions } });
      return { status: 200, body: { id } };
    });
    return (await this.getListingDetail(ownerId, id)).listing;
  }
  async transitionStatus(ownerId: string, id: string, to: ListingStatus, key: string = randomUUID(), expectedUpdatedAt?: string) {
    await runIdempotent(this.db, ownerId, key, `listing:${id}:transition`, { to }, async tx => {
      const row = await this.lock(tx, id, ownerId);
      assertTransition(listingMachine, row.status, to, 'owner');
      if (to === 'active' && !await tx.listingPhoto.count({ where: { listingId: id } })) throw new HttpError('VALIDATION_FAILED', 'Add at least one photo before publishing this item');
      if (to === 'active' && foodExpired(row)) throw new HttpError('CONFLICT', 'The collect-by time for this food has passed');
      if (expectedUpdatedAt && row.updatedAt.toISOString() !== expectedUpdatedAt) throw new HttpError('CONFLICT', 'Listing changed; review a new preview');
      if (to === 'closed' && (row.stockReserved > 0 || await tx.loan.count({ where: { listingId: id, status: { in: ['approved', 'checked_out'] } } }))) throw new HttpError('CONFLICT', 'Finish active requests and loans before closing');
      await tx.listing.update({ where: { id }, data: { status: to } });
      return { status: 200, body: { id } };
    });
    return (await this.getListingDetail(ownerId, id)).listing;
  }
  /** Edits to a food offer: the deadline stays in the future and never cuts an approved pickup short. */
  private async foodEdit(tx: Tx, row: Prisma.ListingGetPayload<object>, edit: NonNullable<UpdateListingBody['food']>) {
    if (!row.foodRescue) throw new HttpError('VALIDATION_FAILED', 'Food details apply only to food rescue offers');
    if (foodExpired(row)) throw new HttpError('CONFLICT', 'The collect-by time for this food has passed');
    const collectBy = edit.collectBy === undefined ? row.collectBy! : new Date(edit.collectBy);
    const preparedAt = edit.preparedAt === undefined ? row.foodPreparedAt : edit.preparedAt ? new Date(edit.preparedAt) : null;
    if (edit.collectBy !== undefined) {
      assertFutureCollectBy(collectBy);
      const later = await tx.donationRequest.count({ where: { listingId: row.id, status: 'approved', pickupBy: { gt: collectBy } } });
      if (later) throw new HttpError('CONFLICT', 'An approved pickup ends after this time. Cancel or finish it before moving the collect-by time earlier');
    }
    if (edit.preparedAt !== undefined) assertPreparedNotInFuture(preparedAt);
    if (preparedAt && preparedAt > collectBy) throw new HttpError('VALIDATION_FAILED', 'Preparation time must be before the collect-by time');
    return { collectBy, foodPreparedAt: preparedAt, foodStorage: edit.storage, foodAllergens: edit.allergens };
  }
  async getMyListings(ownerId: string) { return Promise.all((await this.db.listing.findMany({ where: { ownerId }, include, orderBy: { updatedAt: 'desc' }, take: 100 })).map(row => this.dto(row))); }
  async getListingDetail(userId: string | undefined, id: string) {
    const row = await this.db.listing.findUnique({ where: { id }, include });
    if (!row || (row.status !== 'active' && row.ownerId !== userId && !await this.participant(userId, id))) throw new HttpError('NOT_FOUND', 'Item not found');
    return { listing: await this.dto(row), ...(row.ownerId === userId ? { privateDetails: await this.pickup(userId, id) } : {}) };
  }
  private async participant(userId: string | undefined, id: string) {
    if (!userId) return false;
    return Boolean(await this.db.donationRequest.findFirst({ where: { listingId: id, requesterId: userId, status: { in: ['approved', 'collected'] } } })
      || await this.db.loan.findFirst({ where: { listingId: id, borrowerId: userId, status: { in: ['approved', 'checked_out', 'returned'] } } }));
  }
  async pickup(userId: string | undefined, id: string) {
    const row = await this.db.listing.findUnique({ where: { id }, include: { private: true } });
    if (!row || (row.ownerId !== userId && !await this.participant(userId, id))) throw new HttpError('NOT_FOUND', 'Pickup details unavailable');
    return ListingPrivateSchema.parse({ listingId: id, exactLocation: { lat: row.lat, lng: row.lng }, geohash: row.geohash, pickupInstructions: row.private?.pickupInstructions ?? '', contactNote: row.private?.contactNote ?? null });
  }
  async searchListings(params: { searcherId?: string; center: { lat: number; lng: number }; radiusKm: number; category?: ItemCategory; mode?: ListingMode; query?: string; limit: number }) {
    const rows = await searchNearbyListings(this.db, { ...params, ...normalizeListingSearch(params), excludeOwnerId: params.searcherId });
    const full = await this.db.listing.findMany({ where: { id: { in: rows.map(r => r.id) }, status: 'active' }, include });
    const byId = new Map(full.map(row => [row.id, row]));
    return Promise.all(rows.flatMap(row => { const found = byId.get(row.id); return found ? [this.dto(found, row.distanceKm)] : []; }));
  }
  async uploadPhoto(userId: string, id: string, bytes: Buffer, mimeType: string, key: string) {
    if (!Buffer.isBuffer(bytes)) throw new HttpError('VALIDATION_FAILED', 'Attach a JPEG, PNG or WebP image');
    if (!this.storage) throw new HttpError('AUTH_NOT_CONFIGURED', 'Photo storage is unavailable');
    const sourceHash = createHash('sha256').update(mimeType).update(bytes).digest('hex');
    const normalized = await normalizeImage(bytes, mimeType);
    const photoId = randomUUID();
    const path = `listings/${id}/${photoId}.webp`;
    // Cheap pre-check so unauthorized callers never upload; the locked re-check below is authoritative.
    const current = await this.db.listing.findUnique({ where: { id }, select: { ownerId: true } });
    if (!current) throw new HttpError('NOT_FOUND', 'Item not found');
    if (current.ownerId !== userId) throw new HttpError('FORBIDDEN', 'Only the owner can change this item');
    try {
      // Upload before the transaction: slow bucket I/O must not hold row locks or hit the transaction timeout.
      await this.storage.put(path, normalized, 'image/webp');
      const result = await runIdempotent(this.db, userId, key, `listing:${id}:photo`, { sourceHash }, async tx => {
        const row = await this.lock(tx, id, userId);
        if (row.status === 'closed') throw new HttpError('CONFLICT', 'Listing is closed');
        const count = await tx.listingPhoto.count({ where: { listingId: id } });
        if (count >= 6) throw new HttpError('CONFLICT', 'Maximum six photos per listing');
        await tx.listingPhoto.create({ data: { id: photoId, listingId: id, storagePath: path, position: count } });
        return { status: 201, body: { photoId, storagePath: path } };
      });
      // A replayed key returns the earlier photo; this request's object is unused.
      if (result.body.storagePath !== path) await this.storage.remove(path).catch(() => undefined);
      return result.body;
    } catch (err) { try { if (await this.db.listingPhoto.count({ where: { storagePath: path } }) === 0) await this.storage.remove(path); } catch { /* An uncertain DB commit is verified by retry or orphan maintenance. */ } throw err; }
  }
  async removePhoto(userId: string, id: string, photoId: string, key: string) {
    const result = await runIdempotent(this.db, userId, key, `listing:${id}:photo:${photoId}:delete`, {}, async tx => {
      await this.lock(tx, id, userId);
      const photo = await tx.listingPhoto.findFirst({ where: { id: photoId, listingId: id } });
      if (photo && await tx.listingPhoto.count({ where: { listingId: id } }) <= 1) throw new HttpError('CONFLICT', 'Keep at least one photo. Add a replacement before removing this photo');
      if (photo) await tx.listingPhoto.delete({ where: { id: photoId } });
      return { status: 200, body: { removed: true, path: photo?.storagePath ?? null } };
    });
    if (result.body.path && this.storage) await this.storage.remove(result.body.path);
    return { removed: true };
  }
  private async dto(row: Row, distanceKm?: number) {
    return ListingPublicSchema.parse({ ...row, ownerDisplayName: row.owner.displayName ?? 'Neighbour',
      stock: { total: row.stockTotal, reserved: row.stockReserved, collected: row.stockCollected },
      photos: await Promise.all(row.photos.map(async p => ({ id: p.id, path: p.storagePath, url: this.storage ? await this.storage.signedReadUrl(p.storagePath) : undefined }))),
      location: approximateLocation({ lat: row.lat, lng: row.lng }, row.areaLabel, distanceKm),
      collection: { method: row.collectionMethod, communityPointId: row.communityPointId },
      lending: row.maxLoanDays ? { maxLoanDays: row.maxLoanDays, notes: row.lendingNotes, depositRequired: false } : null,
      bestBefore: row.bestBefore?.toISOString().slice(0, 10) ?? null, food: foodPublic(row), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
  }
}
