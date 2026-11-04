import {
  allowedTargets, donationRequestMachine, DonationRequestSchema,
  type DonationRequest, type DonationRequestStatus, type Actor,
  type CreateDonationRequestBodySchema, type DonationRequestTransitionBodySchema,
} from '@neighbourhood/shared';
import { z } from 'zod';
import type { Prisma, Db, Tx } from '../../lib/db.js';
import { HttpError } from '../../lib/http.js';
import { beforeCursor, decodeCursor, pageRows, type PageOptions } from '../../lib/pagination.js';
import { ConversationsStore } from '../conversations/conversations.store.js';
import { DonationRequestsStore } from './requests.store.js';
import { runIdempotent, type MutationResult } from './idempotency.js';
import type { ObjectStorage } from '../../lib/storage.js';

type CreateBody = z.infer<typeof CreateDonationRequestBodySchema>;
type TransitionBody = z.infer<typeof DonationRequestTransitionBodySchema>;
type RequestPage = { items: DonationRequest[]; nextCursor: string | null };
export interface RequestsService {
  create(userId: string, key: string, body: CreateBody): Promise<MutationResult<DonationRequest>>;
  transition(userId: string, key: string, requestId: string, body: TransitionBody): Promise<MutationResult<DonationRequest>>;
  get(userId: string, requestId: string): Promise<DonationRequest>;
  list(userId: string, direction: 'incoming' | 'outgoing', opts: PageOptions): Promise<RequestPage>;
}

const include = {
  conversation: { select: { id: true } },
  listing: { select: { title: true, photos: { orderBy: { position: 'asc' }, take: 1 }, communityPoint: { select: { communityId: true } } } },
} satisfies Prisma.DonationRequestInclude;
type RequestRow = Prisma.DonationRequestGetPayload<{ include: typeof include }>;

export class PrismaRequestsService implements RequestsService {
  private readonly store: DonationRequestsStore;
  private readonly conversations: ConversationsStore;
  constructor(private readonly db: Db, private readonly photos?: ObjectStorage) {
    this.store = new DonationRequestsStore(db);
    this.conversations = new ConversationsStore(db);
  }

  create(userId: string, key: string, body: CreateBody) {
    if (!z.uuid().safeParse(body.listingId).success) throw new HttpError('VALIDATION_FAILED', 'Invalid listingId');
    return runIdempotent(this.db, userId, key, 'POST /requests', body, async (tx) => {
      const req = await this.store.create({ ...body, requesterId: userId }, tx);
      const conversation = await this.conversations.ensureForDonationRequest(tx, req.id);
      if (body.message) {
        await this.conversations.sendInTransaction(tx, conversation.id, userId, body.message);
      }
      await tx.notification.create({ data: {
        userId: req.ownerId, type: 'request_received', title: 'New item request',
        body: 'A neighbour requested one of your items.', link: `/activity?request=${req.id}`,
      } });
      return { status: 201, body: await this.read(tx, userId, req.id) };
    });
  }

  transition(userId: string, key: string, requestId: string, body: TransitionBody) {
    return runIdempotent(this.db, userId, key, `POST /requests/${requestId}/transition`, body, async (tx) => {
      await this.read(tx, userId, requestId);
      const pickupBy = body.to === 'approved'
        ? new Date(body.pickupBy ?? Date.now() + 48 * 60 * 60 * 1000)
        : undefined;
      if (pickupBy && pickupBy.getTime() <= Date.now()) throw new HttpError('VALIDATION_FAILED', 'Pickup deadline must be in the future');
      if (body.to !== 'approved' && body.pickupBy) throw new HttpError('VALIDATION_FAILED', 'Pickup deadline is only set during approval');
      const req = await this.store.transitionInTransaction(tx, requestId, userId, body.to, { pickupBy, pickupByExplicit: body.pickupBy !== undefined });
      const conversation = await this.conversations.ensureForDonationRequest(tx, requestId);
      if (body.note) {
        await this.conversations.appendStatusNoteInTransaction(tx, conversation.id, userId, body.note);
      }
      const type: Partial<Record<DonationRequestStatus, string>> = {
        approved: 'request_approved', rejected: 'request_rejected', cancelled: 'request_cancelled', collected: 'request_collected',
      };
      const recipients = [req.ownerId, req.requesterId].filter((id) => id !== userId);
      await tx.notification.createMany({ data: recipients.map((id) => ({
        userId: id, type: type[body.to]!, title: `Request ${body.to}`,
        body: 'Your item request has an update.', link: `/activity?request=${requestId}`,
      })) });
      return { status: 200, body: await this.read(tx, userId, requestId) };
    });
  }

  get(userId: string, requestId: string) { return this.read(this.db, userId, requestId); }

  async list(userId: string, direction: 'incoming' | 'outgoing', opts: PageOptions): Promise<RequestPage> {
    const cursor = decodeCursor(opts.cursor);
    const communityIds = await this.volunteerCommunities(this.db, userId);
    const scope: Prisma.DonationRequestWhereInput = direction === 'outgoing' ? { requesterId: userId } : {
      OR: [{ ownerId: userId }, { listing: { communityPoint: { communityId: { in: communityIds } } } }],
    };
    const rows = await this.db.donationRequest.findMany({
      where: { AND: [scope, beforeCursor(cursor)] }, include,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: opts.limit + 1,
    });
    const page = pageRows(rows, opts.limit);
    return { ...page, items: await Promise.all(page.items.map((row) => this.dto(row, userId, communityIds))) };
  }

  private async volunteerCommunities(db: Db | Tx, userId: string) {
    return (await db.communityMembership.findMany({
      where: { userId, status: 'active', role: { in: ['volunteer', 'moderator'] } }, select: { communityId: true },
    })).map((m) => m.communityId);
  }

  private async read(db: Db | Tx, userId: string, id: string) {
    const row = await db.donationRequest.findUnique({ where: { id }, include });
    const communityIds = await this.volunteerCommunities(db, userId);
    if (!row || !this.actor(row, userId, communityIds)) throw new HttpError('NOT_FOUND', 'Request not found');
    return this.dto(row, userId, communityIds);
  }

  private actor(row: RequestRow, userId: string, communityIds: string[]): Actor | null {
    if (row.ownerId === userId) return 'owner';
    if (row.requesterId === userId) return 'requester';
    const communityId = row.listing.communityPoint?.communityId;
    return communityId && communityIds.includes(communityId) ? 'volunteer' : null;
  }

  private async dto(row: RequestRow, userId: string, communityIds: string[]) {
    const actor = this.actor(row, userId, communityIds);
    return DonationRequestSchema.parse({
      id: row.id, listingId: row.listingId, listingTitle: row.listing.title,
      listingPhotoUrl: row.listing.photos[0] && this.photos ? await this.photos.signedReadUrl(row.listing.photos[0].storagePath) : undefined,
      ownerId: row.ownerId, requesterId: row.requesterId, quantity: row.quantity, message: row.message,
      status: row.status, pickupBy: row.pickupBy?.toISOString() ?? null,
      conversationId: actor === 'volunteer' ? null : row.conversation?.id ?? null,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
      allowedActions: actor ? allowedTargets(donationRequestMachine, row.status, actor).filter((s) => s !== 'expired') : [],
    });
  }
}
