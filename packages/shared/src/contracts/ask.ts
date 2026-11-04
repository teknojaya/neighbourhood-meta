import { z } from 'zod';
import { ApiErrorCodeSchema, IdSchema, IsoDateTimeSchema, pageOf } from '../common.js';
import { AI_LIMITS, NeedsExtractionSchema } from '../ai/contracts.js';
import { DonationRequestSchema, CreateDonationRequestBodySchema, DonationRequestTransitionBodySchema } from './requests-loans.js';
import { ConversationSchema, MessageSchema, NotificationSchema } from './messaging.js';
import { SavedNeedSchema } from './needs.js';
import { ItemCategorySchema, ItemConditionSchema, ListingModeSchema } from '../enums.js';
import { MarketplaceActionSchema } from './marketplace-actions.js';
import { ListingPublicSchema } from './listings.js';
import { LoanSchema } from './requests-loans.js';
import { CommunitySchema, CommunityPointSchema, PointInventoryItemSchema, DepositSchema, MembershipSchema, StockAdjustmentSchema } from './communities.js';
import { NeedMatchesSchema } from './needs.js';
import { RadiusKmSchema } from '../geo.js';

export const AskSearchScopeSchema = z.object({
  radiusKm: RadiusKmSchema, broaderRadiusKm: RadiusKmSchema.nullable(),
  query: z.string().max(100).optional(), category: ItemCategorySchema.optional(), mode: ListingModeSchema.optional(),
  fartherItems: z.array(ListingPublicSchema).max(10),
});

export const ASK_LIMITS = { textChars: 2000, attachmentsPerMessage: 2, historyMessages: 30, modelRounds: 4, toolCalls: 6, turnMs: 45_000, proposalMs: 10 * 60_000 } as const;
export const AskSessionSchema = z.object({ id: IdSchema, title: z.string().max(80), createdAt: IsoDateTimeSchema, updatedAt: IsoDateTimeSchema });
export type AskSession = z.infer<typeof AskSessionSchema>;
export const AskSessionPageSchema = pageOf(AskSessionSchema);
export const AskCreateSessionBodySchema = z.strictObject({ clientId: z.uuid() });
export const AskAttachmentSchema = z.object({ id: IdSchema, name: z.string().max(120), mimeType: z.enum(AI_LIMITS.imageMimeTypes), size: z.number().int().positive().max(AI_LIMITS.imageMaxBytes) });
export type AskAttachment = z.infer<typeof AskAttachmentSchema>;
export const AskSendBodySchema = z.strictObject({
  clientMessageId: z.uuid(), text: z.string().trim().max(ASK_LIMITS.textChars),
  attachmentIds: z.array(z.uuid()).max(ASK_LIMITS.attachmentsPerMessage).default([]),
}).refine((v) => v.text.length > 0 || v.attachmentIds.length > 0, { message: 'Add a message or photo' });
export type AskSendBody = z.infer<typeof AskSendBodySchema>;
export const AskActionPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('marketplace'), action: MarketplaceActionSchema }),
  z.strictObject({ kind: z.literal('save_need'), extraction: NeedsExtractionSchema }),
  z.strictObject({ kind: z.literal('request_item'), body: CreateDonationRequestBodySchema }),
  z.strictObject({ kind: z.literal('transition_request'), requestId: z.uuid(), body: DonationRequestTransitionBodySchema }),
  z.strictObject({ kind: z.literal('send_message'), conversationId: z.uuid(), body: z.string().trim().min(1).max(2000) }),
]);
export type AskActionPayload = z.infer<typeof AskActionPayloadSchema>;
export const AskActionSchema = z.object({
  id: IdSchema, revision: z.number().int().nonnegative(), payload: AskActionPayloadSchema,
  summary: z.string().max(300), status: z.enum(['pending', 'executing', 'completed', 'cancelled', 'expired']),
  expiresAt: IsoDateTimeSchema, errorCode: ApiErrorCodeSchema.nullable(),
  receipt: z.object({ message: z.string(), link: z.string().startsWith('/').nullable() }).nullable(),
});
export type AskAction = z.infer<typeof AskActionSchema>;
export const AskConfirmBodySchema = z.strictObject({ revision: z.number().int().nonnegative() });
export const AskEditNeedBodySchema = z.strictObject({ revision: z.number().int().nonnegative(), extraction: NeedsExtractionSchema });
export const AskListingDraftDataSchema = z.strictObject({
  title: z.string().trim().max(100).nullable(), category: ItemCategorySchema.nullable(),
  mode: ListingModeSchema.nullable(), condition: ItemConditionSchema.nullable(),
  quantity: z.number().int().min(1).max(1000).nullable(), description: z.string().max(2000).nullable(),
  maxLoanDays: z.number().int().min(1).max(90).nullable().default(null),
  attachmentIds: z.array(z.uuid()).max(2).default([]),
});
export const AskListingDraftSchema = z.object({ id: IdSchema, data: AskListingDraftDataSchema, attachments: z.array(AskAttachmentSchema).max(2).default([]), updatedAt: IsoDateTimeSchema });
export type AskListingDraft = z.infer<typeof AskListingDraftSchema>;
export const AskInputSchema = z.enum(['photo', 'profile_location', 'listing_pickup']);
export type AskInput = z.infer<typeof AskInputSchema>;
export const AskPartSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('input_request'), input: AskInputSchema, prompt: z.string().trim().min(1).max(300) }),
  z.object({ kind: z.literal('questions'), questions: z.array(z.object({ question: z.string().trim().min(1).max(240), options: z.array(z.string().trim().min(1).max(100)).max(6).default([]) })).min(1).max(4) }),
  z.object({ kind: z.literal('matches'), items: NeedMatchesSchema.shape.items, explanationSource: NeedMatchesSchema.shape.explanationSource.optional() }),
  z.object({ kind: z.literal('listings'), items: z.array(ListingPublicSchema), search: AskSearchScopeSchema.optional() }),
  z.object({ kind: z.literal('loans'), items: z.array(LoanSchema) }),
  z.object({ kind: z.literal('communities'), items: z.array(CommunitySchema) }),
  z.object({ kind: z.literal('points'), items: z.array(CommunityPointSchema) }),
  z.object({ kind: z.literal('inventory'), items: z.array(PointInventoryItemSchema) }),
  z.object({ kind: z.literal('deposits'), items: z.array(DepositSchema) }),
  z.object({ kind: z.literal('members'), items: z.array(MembershipSchema) }),
  z.object({ kind: z.literal('stock_audit'), items: z.array(StockAdjustmentSchema) }),
  z.object({ kind: z.literal('action'), action: AskActionSchema }),
  z.object({ kind: z.literal('listing_draft'), draft: AskListingDraftSchema }),
  z.object({ kind: z.literal('saved_needs'), items: z.array(SavedNeedSchema) }),
  z.object({ kind: z.literal('requests'), items: z.array(DonationRequestSchema) }),
  z.object({ kind: z.literal('conversations'), items: z.array(ConversationSchema) }),
  z.object({ kind: z.literal('messages'), items: z.array(MessageSchema) }),
  z.object({ kind: z.literal('notifications'), items: z.array(NotificationSchema) }),
]);
export type AskPart = z.infer<typeof AskPartSchema>;
export const AskMessageSchema = z.object({ id: IdSchema, sequence: z.number().int(), role: z.enum(['user', 'assistant']), text: z.string(), parts: z.array(AskPartSchema), attachments: z.array(AskAttachmentSchema), createdAt: IsoDateTimeSchema });
export type AskMessage = z.infer<typeof AskMessageSchema>;
export const AskMessagePageSchema = z.object({ items: z.array(AskMessageSchema), beforeSequence: z.number().int().nullable() });
export const AskRunSchema = z.object({ id: IdSchema, clientMessageId: z.uuid(), status: z.enum(['running', 'completed', 'failed', 'cancelled']), progress: z.enum(['thinking','searching','reading','preparing','answering']).default('thinking'), partialText: z.string().max(8000).default(''), errorCode: ApiErrorCodeSchema.nullable(), createdAt: IsoDateTimeSchema });
export type AskRun = z.infer<typeof AskRunSchema>;
export const AskStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run'), run: AskRunSchema }),
  z.object({ type: z.literal('done'), run: AskRunSchema }),
]);
export type AskStreamEvent = z.infer<typeof AskStreamEventSchema>;
export const AskSessionDetailSchema = z.object({ session: AskSessionSchema, messages: AskMessagePageSchema, latestRun: AskRunSchema.nullable(), pendingAttachments: z.array(AskAttachmentSchema) });
export const AskStatusSchema = z.object({ available: z.boolean(), imagesAvailable: z.boolean() });
