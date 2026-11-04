import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type { FunctionDeclaration } from './ask.model.js';
import {
  ASK_LIMITS, AskActionPayloadSchema, AskInputSchema, AskListingDraftDataSchema, AskListingDraftSchema, AskPartSchema,
  CreateDonationRequestBodySchema, DonationRequestTransitionBodySchema, NeedsExtractionSchema,
  type AskActionPayload, type AskPart, type ListingPublic,
  FOOD_RESCUE_LIMITS, ItemCategorySchema, ListingModeSchema, RadiusKmSchema, MAX_RADIUS_KM, MarketplaceActionSchema, modelSafe,
} from '@neighbourhood/shared';
import type { Db } from '../../lib/db.js';
import { HttpError } from '../../lib/http.js';
import type { NeedsService } from '../needs/needs.service.js';
import type { RequestsService } from '../requests/requests.service.js';
import type { ConversationsService } from '../conversations/conversations.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import { actionDto } from './ask.dto.js';
import { ModelMarketplaceActionSchema, authorizeProposal, marketplaceSummary, type MarketplaceServices } from './ask.marketplace.js';
import { PRODUCT_GUIDE } from './product-knowledge.js';
import { normalizeListingSearch } from '../listings/search-terms.js';
import { DESCRIPTION_QUESTION, FOOD_DEADLINE_QUESTION, NO_DESCRIPTION_OPTION, descriptionDeclined, guardFoodFacts, quantityWasStated, wantsToPublish } from './ask.presentation.js';

export interface AskServices {
  marketplace?: MarketplaceServices;
  needs: NeedsService; requests: RequestsService; conversations: ConversationsService; notifications: NotificationsService;
  /** Engineer 1 can connect this when authorized listing detail is implemented. */
  listings?: { get(userId: string, id: string): Promise<ListingPublic> };
}
export interface ToolContext { userId: string; sessionId: string; runId: string; attemptId: string; signal: AbortSignal }
interface ToolResult { result: unknown; parts: AskPart[]; reply?: string }
interface RegisteredTool { declaration: FunctionDeclaration; execute(args: unknown, ctx: ToolContext): Promise<ToolResult> }
const paging = z.strictObject({ cursor: z.string().max(500).optional() });

export class AskTools {
  private readonly tools = new Map<string, RegisteredTool>();
  constructor(private readonly db: Db, private readonly services: AskServices) {
    this.add('request_input', 'Open a real photo chooser, Profile location form or secure listing pickup review. Use instead of text choices such as Set location in Profile or Add photo. Ends the turn and waits for the user. Coordinates/private addresses are entered in secure UI, never chat. For sharing without a photo, request photo first; a photo is mandatory before publication.', z.strictObject({ input: AskInputSchema, prompt: z.string().trim().min(1).max(300) }), async ({ input, prompt }, ctx) => {
      if (input === 'photo' && await db.askAttachment.count({ where: { sessionId: ctx.sessionId } })) return { result: { photoAlreadyProvided: true, note: 'A photo is already available. Continue with missing facts, do not ask again.' }, parts: [] };
      return { result: { waitingForUser: true, committed: false, input }, parts: [{ kind: 'input_request', input, prompt }] };
    });
    this.add('ask_questions', 'Ask ONE short conversational follow-up, then wait for the resident’s ordinary chat reply. No questionnaire. Ask only an unanswered, necessary fact; explicit intent and previous replies are already known. Optional quick replies are shortcuts, not a form. Ends this turn without marketplace operations.', z.strictObject({ questions: z.array(z.strictObject({ question: z.string().trim().min(1).max(240), options: z.array(z.string().trim().min(1).max(100)).max(6).default([]) })).min(1).max(4) }), async ({ questions }) => ({ result: { waitingForUser: true, committed: false, note: 'Only the first question was asked. Wait for the user reply before asking another.' }, parts: [{ kind: 'questions', questions: questions.slice(0, 1) }] }));
    this.add('get_product_guide', 'Read authoritative NeighbourHood product knowledge and navigation. Use for what is a community point, how roles work, giving, borrowing, saved needs/items, map/radius, photos and app help. Static guide; does not search neighbours or change anything.', z.strictObject({ topic: z.enum(['overview', 'roles', 'sharing', 'borrowing', 'points', 'saved_needs', 'saved_items', 'location', 'chat', 'navigation', 'all']).default('overview') }), async ({ topic }) => ({ result: topic === 'all' ? PRODUCT_GUIDE : { topic, guide: PRODUCT_GUIDE[topic] }, parts: [] }));
    this.add('my_account', 'Read the caller’s actual baseline account label, platform roles, community memberships/statuses and whether a search location is set. No home coordinates, email or private pickup details. Use before answering about my role or memberships; neighbour is not proof of membership.', z.strictObject({}), async (_args, ctx) => {
      const user = await db.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { areaLabel: true, preferredLanguage: true, searchRadiusKm: true, homeLat: true, homeLng: true, roles: { select: { role: true } }, memberships: { select: { role: true, status: true, communityId: true, community: { select: { name: true } } }, orderBy: { updatedAt: 'desc' }, take: 100 } } });
      const searchLocationSet = user.homeLat !== null && user.homeLng !== null;
      return { result: { accountLabel: 'neighbour', platformRoles: user.roles.map(r => r.role), memberships: user.memberships.map(m => ({ communityId: m.communityId, communityName: m.community.name, role: m.role, status: m.status })), searchLocationSet, pickupLocationReady: searchLocationSet && Boolean(user.areaLabel?.trim()), missingLocationFields: [...(!searchLocationSet ? ['coordinates'] : []), ...(!user.areaLabel?.trim() ? ['publicArea'] : [])], publicArea: user.areaLabel, preferredLanguage: user.preferredLanguage, searchRadiusKm: user.searchRadiusKm }, parts: [] };
    });
    if (services.marketplace) {
      const market = services.marketplace;
      this.add('list_saved_items', 'Read the caller’s bookmarked actual products. Saved items are distinct from saved needs. Does not reserve stock or change anything.', z.strictObject({}), async (_args, ctx) => { const rows = await db.savedListing.findMany({ where: { userId: ctx.userId }, orderBy: { createdAt: 'desc' }, take: 20 }); const items: ListingPublic[] = []; for (const row of rows) { try { items.push((await market.listings.getListingDetail(ctx.userId, row.listingId)).listing); } catch (err) { if (!(err instanceof HttpError && ['NOT_FOUND','FORBIDDEN'].includes(err.code))) throw err; } } return { result: { items, unavailableCount: rows.length - items.length }, parts: [{ kind: 'listings', items }] }; });
      this.add('list_categories', 'Read supported product categories.', z.strictObject({}), async () => ({ result: { categories: ItemCategorySchema.options }, parts: [] }));
      if (market.matching) this.add('match_saved_need', 'Find real eligible nearby matches for a caller-owned saved need and provide grounded explanations. Requires a saved Profile location.', z.strictObject({ needId: z.uuid() }), async (args, ctx) => { const result = await market.matching!.matches(ctx.userId, args.needId); return { result, parts: [{ kind: 'matches', items: result.items, explanationSource: result.explanationSource }] }; });
      this.add('search_listings', 'Search real eligible nearby items using the caller’s private saved location. Query keywords should be short item names, not whole sentences. Radius is kilometres.', z.strictObject({ query: z.string().max(100).optional(), category: ItemCategorySchema.optional(), mode: ListingModeSchema.optional(), radiusKm: RadiusKmSchema.optional() }), async (args, ctx) => {
        const user = await db.user.findUniqueOrThrow({ where: { id: ctx.userId } });
        if (user.homeLat === null || user.homeLng === null) throw new HttpError('VALIDATION_FAILED', 'Set your location in Profile to search nearby');
        const radiusKm = args.radiusKm ?? user.searchRadiusKm;
        const normalized = normalizeListingSearch(args);
        const search = { ...args, ...normalized, searcherId: ctx.userId, center: { lat: user.homeLat, lng: user.homeLng }, radiusKm, limit: 10 };
        const items = await market.listings.searchListings(search);
        const broaderRadiusKm = items.length === 0 && radiusKm < MAX_RADIUS_KM ? MAX_RADIUS_KM : null;
        const fartherItems = broaderRadiusKm ? await market.listings.searchListings({ ...search, radiusKm: broaderRadiusKm }) : [];
        const scope = { radiusKm, broaderRadiusKm, query: normalized.query, category: normalized.category, mode: args.mode, fartherItems };
        return { result: { items, ...scope, note: 'Items and fartherItems are separate. State the checked radius. Empty means none eligible in that checked area now, never worldwide unavailability. Do not repeat an answered radius question. Do not suggest widening when the wider check is also empty. Never call farther items nearby or reserved.' }, parts: [{ kind: 'listings', items, search: scope }] };
      });
      this.add('get_listing', 'Read one accessible listing by its real UUID. Never returns private pickup details.', z.strictObject({ listingId: z.uuid() }), async (args, ctx) => { const { listing } = await market.listings.getListingDetail(ctx.userId, args.listingId); return { result: { listing }, parts: [{ kind: 'listings', items: [listing] }] }; });
      this.add('list_my_listings', 'Read the caller’s shared items.', z.strictObject({}), async (_args, ctx) => { const items = await market.listings.getMyListings(ctx.userId); return { result: { items }, parts: [{ kind: 'listings', items }] }; });
      this.add('list_loans', 'Read the caller’s incoming or outgoing loans and allowed actions.', z.strictObject({ direction: z.enum(['incoming', 'outgoing']) }), async (args, ctx) => { const page = await market.loans.list(ctx.userId, args.direction, { limit: 10 }); return { result: page, parts: [{ kind: 'loans', items: page.items }] }; });
      this.add('get_loan', 'Read one participant-authorized loan.', z.strictObject({ loanId: z.uuid() }), async (args, ctx) => { const item = await market.loans.get(ctx.userId, args.loanId); return { result: item, parts: [{ kind: 'loans', items: [item] }] }; });
      this.add('loan_availability', 'Read reserved loan date ranges, without borrower identity.', z.strictObject({ listingId: z.uuid() }), async (args, ctx) => ({ result: await market.loans.availability(ctx.userId, args.listingId), parts: [] }));
      this.add('list_communities', 'Browse communities. Discovery is independent of radius.', z.strictObject({}), async () => { const page = await market.communities.list(); return { result: page, parts: [{ kind: 'communities', items: page.items }] }; });
      this.add('get_community', 'Read a community and caller membership. Moderators can use its card to prepare a new point securely.', z.strictObject({ communityId: z.uuid() }), async (args, ctx) => { const result = await market.communities.get(ctx.userId, args.communityId); return { result, parts: [{ kind: 'communities', items: [result.community] }] }; });
      this.add('list_points', 'Read active collection points and consented public addresses.', z.strictObject({ communityId: z.uuid() }), async args => { const page = await market.communities.points(args.communityId); return { result: page, parts: [{ kind: 'points', items: page.items }] }; });
      this.add('point_inventory', 'Read collection point inventory.', z.strictObject({ pointId: z.uuid() }), async args => { const page = await market.communities.inventory(args.pointId); return { result: page, parts: [{ kind: 'inventory', items: page.items }] }; });
      this.add('list_deposits', 'Read caller-owned deposits or volunteer-authorized deposits.', z.strictObject({ pointId: z.uuid() }), async (args, ctx) => { const page = await market.communities.deposits(ctx.userId, args.pointId); return { result: page, parts: [{ kind: 'deposits', items: page.items }] }; });
      this.add('list_members', 'Moderators only: read members pending review and roles.', z.strictObject({ communityId: z.uuid() }), async (args, ctx) => { const page = await market.communities.members(ctx.userId, args.communityId); return { result: page, parts: [{ kind: 'members', items: page.items }] }; });
      this.add('inventory_audit', 'Volunteers only: read stock adjustments.', z.strictObject({ pointId: z.uuid() }), async (args, ctx) => { const page = await market.communities.audit(ctx.userId, args.pointId); return { result: page, parts: [{ kind: 'stock_audit', items: page.items }] }; });
      this.add('prepare_marketplace_action', 'Prepare a review card for the requested operation. Never executes it. Read the real resource first; current permissions and state are rechecked at confirmation. In-person deposit, checkout, return and collection require human confirmation.', ModelMarketplaceActionSchema, async (action, ctx) => this.propose(ctx, { kind: 'marketplace', action: await authorizeProposal(db, market, ctx.userId, action) }, await marketplaceSummary(db, market, ctx.userId, action)));
      this.add('my_preferences', 'Read only area, language and search radius; never coordinates.', z.strictObject({}), async (_args, ctx) => { const user = await db.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { areaLabel: true, preferredLanguage: true, searchRadiusKm: true } }); return { result: user, parts: [] }; });
    }
    this.add('list_saved_needs', 'List the caller\'s private saved needs. Does not change them.', paging, async (args, ctx) => {
      const page = await services.needs.list(ctx.userId, { ...args, limit: 10 });
      return { result: page, parts: [{ kind: 'saved_needs', items: page.items }] };
    });
    this.add('list_requests', 'Read incoming or outgoing item requests and their server-allowed actions.', paging.extend({ direction: z.enum(['incoming', 'outgoing']) }), async (args, ctx) => {
      const page = await services.requests.list(ctx.userId, args.direction, { ...args, limit: 10 });
      return { result: page, parts: [{ kind: 'requests', items: page.items }] };
    });
    this.add('get_request', 'Read one request the caller may access.', z.strictObject({ requestId: z.uuid() }), async (args, ctx) => {
      const item = await services.requests.get(ctx.userId, args.requestId);
      return { result: item, parts: [{ kind: 'requests', items: [item] }] };
    });
    this.add('list_conversations', 'List the caller\'s private neighbour conversations.', paging, async (args, ctx) => {
      const page = await services.conversations.list(ctx.userId, { ...args, limit: 10 });
      return { result: page, parts: [{ kind: 'conversations', items: page.items }] };
    });
    this.add('read_messages', 'Read messages only in a conversation the caller participates in. Does not mark unread messages read.', paging.extend({ conversationId: z.uuid() }), async (args, ctx) => {
      const page = await services.conversations.messages(ctx.userId, args.conversationId, { ...args, limit: 10 });
      return { result: page, parts: [{ kind: 'messages', items: page.items }] };
    });
    this.add('list_notifications', 'Read the caller\'s inbox updates.', paging, async (args, ctx) => {
      const page = await services.notifications.list(ctx.userId, { ...args, limit: 10 });
      return { result: page, parts: [{ kind: 'notifications', items: page.items }] };
    });
    this.add('prepare_save_need', 'Prepare an editable review card to save a structured need. This does not save the need.', z.strictObject({ extraction: NeedsExtractionSchema }), async (args, ctx) => {
      if (!args.extraction.items.length) throw new HttpError('VALIDATION_FAILED', 'A need must contain at least one item');
      return this.propose(ctx, { kind: 'save_need', ...args }, args.extraction.items.map((i) => i.name).join(', ').slice(0, 300));
    });
    if (services.listings) this.add('prepare_request', 'Prepare a donation request for a known listing UUID. Submission and stock eligibility are checked when the user confirms.', CreateDonationRequestBodySchema, async (body, ctx) => {
      if (!z.uuid().safeParse(body.listingId).success) throw new HttpError('VALIDATION_FAILED', 'Invalid listing');
      const listing = await services.listings!.get(ctx.userId, body.listingId);
      if (listing.status !== 'active' || listing.mode !== 'donate' || listing.ownerId === ctx.userId) throw new HttpError('NOT_FOUND', 'Listing unavailable');
      if (listing.food?.expired) throw new HttpError('CONFLICT', 'The collect-by time for this food has passed');
      const existing = await db.donationRequest.findFirst({ where: { listingId: body.listingId, requesterId: ctx.userId, status: { in: ['pending', 'approved'] } } });
      if (existing) {
        const item = await services.requests.get(ctx.userId, existing.id);
        return { result: { alreadyRequested: true, request: item, committed: false }, parts: [{ kind: 'requests', items: [item] }], reply: `You already have a ${item.status} request for ${listing.title}. Open the existing request below to check its status or message the neighbour.` };
      }
      const history = await db.askMessage.findMany({ where: { sessionId: ctx.sessionId }, orderBy: { sequence: 'desc' }, take: 30 });
      const resultMessage = history.find(message => Array.isArray(message.parts) && (message.parts as Array<{kind?:string}>).some(part => part.kind === 'listings'));
      const sameName = [...new Map((resultMessage ? z.array(AskPartSchema).parse(resultMessage.parts) : []).flatMap(part => part.kind === 'listings' ? [...part.items, ...(part.search?.fartherItems ?? [])] : []).filter(item => item.title === listing.title).map(item => [item.id, item])).values()];
      if (sameName.length > 1) {
        const choice = history.find(message => message.role === 'user' && message.sequence > resultMessage!.sequence && /\b(first|second|third|pertama|kedua|ketiga)\b/i.test(message.text));
        if (!choice) return { result: { waitingForUser: true, ambiguousListing: true, committed: false }, parts: [{ kind: 'questions', questions: [{ question: `There is more than one listing called ${listing.title}. Which one would you like?`, options: sameName.slice(0, 3).map((_item, index) => `${['First','Second','Third'][index]} ${listing.title}`.slice(0, 100)) }] }] };
        const selected = /\b(first|pertama)\b/i.test(choice.text) ? 0 : /\b(second|kedua)\b/i.test(choice.text) ? 1 : 2;
        if (sameName[selected]?.id !== body.listingId) throw new HttpError('VALIDATION_FAILED', 'Use the listing selected by the user, not another listing with the same title');
      }
      return this.propose(ctx, { kind: 'request_item', body }, listing.title);
    });
    this.add('prepare_request_transition', 'Prepare a request approval, rejection, cancellation or handover review card. Use only a server-allowed action.', z.strictObject({ requestId: z.uuid(), body: DonationRequestTransitionBodySchema }), async (args, ctx) => {
      const req = await services.requests.get(ctx.userId, args.requestId);
      if (!req.allowedActions?.includes(args.body.to)) throw new HttpError('FORBIDDEN', 'This action is unavailable');
      return this.propose(ctx, { kind: 'transition_request', ...args }, `${req.listingTitle ?? 'Item request'} × ${req.quantity}: ${args.body.to}`);
    });
    this.add('prepare_message', 'Prepare a message review card showing exact text and the authorized conversation. Does not send.', z.strictObject({ conversationId: z.uuid(), body: z.string().trim().min(1).max(2000) }), async (args, ctx) => {
      const conversation = await services.conversations.get(ctx.userId, args.conversationId);
      if (conversation.closed) throw new HttpError('CONFLICT', 'This conversation is closed');
      return this.propose(ctx, { kind: 'send_message', ...args }, conversation.listingTitle ?? 'Neighbour conversation');
    });
    this.add('draft_listing', 'Create or update the current private listing draft after clarifying unknown quantity and condition with the user. Do not infer those from photos or invent defaults. If you need an answer first, use ask_questions instead. Supply only changed fields. Null means unknown. If the user has nothing to add to the description, set description to an empty string. When the user asks to post or publish, call this with any remaining facts; a complete draft then shows the publication review card. Photos from this turn attach automatically; earlier draft photos are preserved. includePhotos=false removes draft photos. It cannot publish. Surplus food (cooked meals, bread, produce to rescue before it spoils): set foodRescue true; it is a free groceries donation that needs a collect-by deadline. Prefer collectWithinHours for a relative deadline; use collectBy only with an explicit time-zone offset the user confirmed. foodPreparedAt, foodStorage and foodAllergens only when the user stated them; unknown stays null, never inferred from a photo.', AskListingDraftDataSchema.omit({ attachmentIds: true }).partial().extend({ includePhotos: z.boolean().optional(), collectWithinHours: z.number().min(0.25).max(FOOD_RESCUE_LIMITS.maxHoursAhead).optional() }), async ({ includePhotos, collectWithinHours, ...args }, ctx) => {
      const previous = await db.askDraft.findUnique({ where: { sessionId_kind: { sessionId: ctx.sessionId, kind: 'listing' } } });
      const latest = await db.askMessage.findFirst({ where: { sessionId: ctx.sessionId, role: 'user' }, orderBy: { sequence: 'desc' } });
      const earlierPhoto = (!previous || !Object.hasOwn(previous.data as object, 'attachmentIds')) && !latest?.attachmentIds.length ? await db.askMessage.findFirst({ where: { sessionId: ctx.sessionId, role: 'user', attachmentIds: { isEmpty: false }, ...(previous ? { createdAt: { lte: previous.updatedAt } } : {}) }, orderBy: { sequence: 'desc' } }) : null;
      const history = await db.askMessage.findMany({ where: { sessionId: ctx.sessionId }, orderBy: { sequence: 'asc' }, select: { role: true, text: true } });
      if (args.quantity != null && !quantityWasStated(history, args.quantity)) args.quantity = null;
      if (collectWithinHours !== undefined) args.collectBy = new Date(Date.now() + collectWithinHours * 3_600_000).toISOString();
      guardFoodFacts(args, history);
      if (args.description?.trim().replace(/[.!]+$/, '').toLowerCase() === NO_DESCRIPTION_OPTION.toLowerCase()) args.description = '';
      const data = AskListingDraftDataSchema.parse({ title: null, category: null, mode: null, condition: null, quantity: null, description: null, ...(previous?.data as object ?? {}), ...args, ...(includePhotos === false ? { attachmentIds: [] } : latest?.attachmentIds.length ? { attachmentIds: latest.attachmentIds } : earlierPhoto ? { attachmentIds: earlierPhoto.attachmentIds } : {}) });
      // The server asked this optional question, so it records an explicit "nothing to add".
      if (data.description === null && descriptionDeclined(history)) data.description = '';
      if (data.foodRescue) { data.mode = 'donate'; data.category = 'groceries'; data.maxLoanDays = null; }
      // A deadline that has already passed is not a usable answer.
      if (data.collectBy && Date.parse(data.collectBy) <= Date.now()) data.collectBy = null;
      const row = await db.askDraft.upsert({ where: { sessionId_kind: { sessionId: ctx.sessionId, kind: 'listing' } }, create: { sessionId: ctx.sessionId, kind: 'listing', data }, update: { data } });
      const attachments = await db.askAttachment.findMany({ where: { sessionId: ctx.sessionId, id: { in: data.attachmentIds } } });
      const draft = AskListingDraftSchema.parse({ ...row, attachments, updatedAt: row.updatedAt.toISOString() });
      // Persist every confirmed fact before handing control back. Incomplete drafts
      // must not strand the resident at a review card with unanswered fields.
      const missing: AskPart | undefined = !attachments.length
        ? { kind: 'input_request', input: 'photo', prompt: 'Please add a clear photo of the item. A photo is required to publish.' }
        : !data.mode ? { kind: 'questions', questions: [{ question: 'Would you like to give this away or lend it out?', options: ['Give it away', 'Lend it out'] }] }
        : !data.condition ? { kind: 'questions', questions: [{ question: 'What condition is it in?', options: ['New', 'Like new', 'Good', 'Fair', 'Needs repair'] }] }
        : data.quantity === null ? { kind: 'questions', questions: [{ question: 'How many items are you sharing?', options: ['1', '2', '3'] }] }
        : data.foodRescue && !data.collectBy ? { kind: 'questions', questions: [{ question: FOOD_DEADLINE_QUESTION, options: ['Within 2 hours', 'Within 4 hours', 'Within 8 hours'] }] }
        : data.mode === 'lend' && !data.maxLoanDays ? { kind: 'questions', questions: [{ question: 'For how many days can a neighbour borrow it?', options: ['3 days', '7 days', '14 days'] }] }
        : !data.title ? { kind: 'questions', questions: [{ question: 'What would you like to call this item?', options: [] }] }
        : !data.category ? { kind: 'questions', questions: [{ question: 'Which category fits this item best?', options: ['Groceries', 'Clothing', 'Books', 'Household', 'Appliances', 'Mobility aids'] }] }
        : data.description === null ? { kind: 'questions', questions: [{ question: DESCRIPTION_QUESTION, options: [NO_DESCRIPTION_OPTION] }] }
        : undefined;
      // An explicit publish request on a complete draft goes straight to the review card.
      // The card still requires the resident's Confirm press before anything is published.
      const publish = this.tools.get('prepare_publish_listing');
      if (!missing && publish && latest && wantsToPublish(latest.text)) {
        const prepared = await publish.execute({ useSavedLocation: true }, ctx);
        const card = prepared.parts.some(part => part.kind === 'action');
        return { ...prepared, result: { draft, publication: prepared.result }, ...(card ? { reply: 'Here is your listing for review. Press Confirm to publish it.' } : {}) };
      }
      return { result: { draft, publicationAvailable: Boolean(services.marketplace), waitingForUser: Boolean(missing) }, parts: missing ? [missing] : [{ kind: 'listing_draft', draft }] };
    });
    if (services.marketplace) this.add('prepare_publish_listing', 'Prepare publication of the current complete private draft using the caller’s saved Profile pickup location. Ask user to choose saved location first. Requires confirmed condition, quantity, offering and maximum loan days for lending. Preserves draft photos. Creates a confirmation card only, never publishes until user presses Confirm. Custom pickup details use the secure draft form.', z.strictObject({ useSavedLocation: z.literal(true) }), async (_args, ctx) => {
      const row = await db.askDraft.findUnique({ where: { sessionId_kind: { sessionId: ctx.sessionId, kind: 'listing' } } });
      if (!row) throw new HttpError('VALIDATION_FAILED', 'Prepare a listing draft first');
      const draft = AskListingDraftDataSchema.parse(row.data);
      const history = await db.askMessage.findMany({ where: { sessionId: ctx.sessionId }, orderBy: { sequence: 'asc' }, select: { role: true, text: true } });
      if (draft.description === null && descriptionDeclined(history)) {
        draft.description = '';
        await db.askDraft.update({ where: { id: row.id }, data: { data: { ...(row.data as object), description: '' } } });
      }
      if (draft.quantity === null || !quantityWasStated(history, draft.quantity)) return { result: { waitingForUser: true, missingFact: 'quantity', committed: false }, parts: [{ kind: 'questions', questions: [{ question: 'How many items are you sharing?', options: ['1', '2', '3'] }] }] };
      if (!Object.hasOwn(row.data as object, 'attachmentIds')) draft.attachmentIds = (await db.askMessage.findFirst({ where: { sessionId: ctx.sessionId, role: 'user', attachmentIds: { isEmpty: false }, createdAt: { lte: row.updatedAt } }, orderBy: { sequence: 'desc' } }))?.attachmentIds.slice(0, 2) ?? [];
      if (!draft.attachmentIds.length) return { result: { waitingForUser: true, requiredInput: 'photo', committed: false }, parts: [{ kind: 'input_request', input: 'photo', prompt: 'Please add a photo of the item before publishing.' }] };
      if (draft.foodRescue && (!draft.collectBy || Date.parse(draft.collectBy) <= Date.now())) return { result: { waitingForUser: true, missingFact: 'collectBy', committed: false }, parts: [{ kind: 'questions', questions: [{ question: FOOD_DEADLINE_QUESTION, options: ['Within 2 hours', 'Within 4 hours', 'Within 8 hours'] }] }] };
      if (!draft.title || !draft.category || !draft.mode || !draft.condition || !draft.quantity || draft.description === null || (draft.mode === 'lend' && !draft.maxLoanDays)) throw new HttpError('VALIDATION_FAILED', 'Ask for missing listing facts before preparing publication');
      const user = await db.user.findUniqueOrThrow({ where: { id: ctx.userId } });
      if (user.homeLat === null || user.homeLng === null || !user.areaLabel?.trim()) return { result: { waitingForUser: true, requiredInput: 'profile_location', coordinatesSet: user.homeLat !== null && user.homeLng !== null, publicAreaSet: Boolean(user.areaLabel?.trim()), note: 'Use the real location form. A missing public area is not missing coordinates.' }, parts: [{ kind: 'input_request', input: 'profile_location', prompt: user.homeLat !== null && user.homeLng !== null ? 'Your location is set. Add a public neighbourhood or city label to continue.' : 'Choose your pickup location and public area to continue.' }] };
      const action = MarketplaceActionSchema.parse({ operation: 'listing_publish', attachmentIds: draft.attachmentIds, body: { title: draft.title, category: draft.category, mode: draft.mode, condition: draft.condition, quantity: draft.quantity, description: draft.description, areaLabel: user.areaLabel, exactLocation: { lat: user.homeLat, lng: user.homeLng }, pickupInstructions: 'Message in the app to agree on a pickup meeting point.', collection: { method: 'owner_location', communityPointId: null }, food: draft.foodRescue ? { collectBy: draft.collectBy!, preparedAt: draft.foodPreparedAt, storage: draft.foodStorage || null, allergens: draft.foodAllergens || null } : null, lending: draft.mode === 'lend' ? { maxLoanDays: draft.maxLoanDays, depositRequired: false, notes: null } : null, appliance: draft.category === 'appliances' ? { workingStatus: 'unknown', brand: null, model: null, approxWeightKg: null, dimensionsCm: null, powerRequirement: null, access: { floorLevel: null, elevatorAvailable: null, requiresDismantling: null, requiresInstallation: null, suggestedHelpers: null, notes: null } } : null } });
      return this.propose(ctx, { kind: 'marketplace', action }, `Publish ${draft.title} × ${draft.quantity}`.slice(0, 300));
    });
  }

  declarations() { return [...this.tools.values()].map((t) => t.declaration); }
  async execute(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    ctx.signal.throwIfAborted();
    const tool = this.tools.get(name);
    if (!tool) throw new HttpError('BAD_REQUEST', 'Unknown assistant tool');
    const run = await this.db.askRun.findFirst({ where: { id: ctx.runId, attemptId: ctx.attemptId, status: 'running', session: { userId: ctx.userId, deletedAt: null } } });
    if (!run) throw new HttpError('CONFLICT', 'This assistant turn is no longer active');
    return tool.execute(args, ctx);
  }

  private add<T extends z.ZodType>(name: string, description: string, schema: T, handler: (args: z.infer<T>, ctx: ToolContext) => Promise<ToolResult>) {
    const json = z.toJSONSchema(schema, { target: 'draft-7' });
    delete json.$schema;
    this.tools.set(name, {
      declaration: { name, description, parametersJsonSchema: json },
      execute: (args, ctx) => {
        const parsed = schema.safeParse(args);
        if (!parsed.success) throw new HttpError('VALIDATION_FAILED', `Correct these tool fields: ${parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`.slice(0, 600));
        return handler(parsed.data, ctx);
      },
    });
  }

  private async propose(ctx: ToolContext, payload: AskActionPayload, summary: string): Promise<ToolResult> {
    const parsed = AskActionPayloadSchema.parse(payload);
    const pending = await this.db.askAction.findMany({ where: { sessionId: ctx.sessionId, status: 'pending', expiresAt: { gt: new Date() } } });
    const matching = pending.find(row => isDeepStrictEqual(AskActionPayloadSchema.parse(row.payload), parsed));
    if (matching) {
      const action = actionDto(matching);
      return { result: { action: modelSafe(action), requiresConfirmation: true, committed: false, alreadyPrepared: true }, parts: [{ kind: 'action', action }] };
    }
    // Supersede only a draft for the same target, preserving independent actions.
    const target = payload.kind === 'transition_request' ? { path: ['requestId'], equals: payload.requestId }
      : payload.kind === 'send_message' ? { path: ['conversationId'], equals: payload.conversationId }
      : payload.kind === 'request_item' ? { path: ['body', 'listingId'], equals: payload.body.listingId } : null;
    await this.db.askAction.updateMany({ where: { sessionId: ctx.sessionId, status: 'pending', AND: [
      { payload: { path: ['kind'], equals: payload.kind } }, ...(target ? [{ payload: target }] : payload.kind === 'marketplace' ? [{ payload: { path: ['action', 'operation'], equals: payload.action.operation } }] : []),
    ] }, data: { status: 'cancelled' } });
    const row = await this.db.askAction.create({ data: { sessionId: ctx.sessionId, runId: ctx.runId, payload: parsed, summary, expiresAt: new Date(Date.now() + ASK_LIMITS.proposalMs) } });
    const action = actionDto(row);
    return { result: { action: modelSafe(action), requiresConfirmation: true, committed: false }, parts: [{ kind: 'action', action }] };
  }
}
