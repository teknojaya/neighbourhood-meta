import { z } from 'zod';
import { ApproximateLocationSchema, IdSchema, IsoDateTimeSchema, LatLngSchema } from '../common.js';
import { ItemCategorySchema } from '../enums.js';
import { RadiusKmSchema } from '../geo.js';

/**
 * Charity events: organizers ask neighbours for goods and volunteer time.
 * No money collection, payments, tax receipts or delivery booking.
 * A pledge is a promise; only the organizer marks goods as received.
 */
export const EventPledgeStatusSchema = z.enum(['pledged', 'accepted', 'received', 'cancelled']);
export type EventPledgeStatus = z.infer<typeof EventPledgeStatusSchema>;
export const VolunteerSignupStatusSchema = z.enum(['pending', 'accepted', 'cancelled']);
export type VolunteerSignupStatus = z.infer<typeof VolunteerSignupStatusSchema>;
export const CharityEventStatusSchema = z.enum(['published', 'cancelled']);

export const EVENT_LIMITS = { needs: 20, slots: 10, maxDaysAhead: 180 } as const;

export const EventNeedInputSchema = z.strictObject({
  title: z.string().trim().min(2).max(100),
  category: ItemCategorySchema,
  quantity: z.number().int().min(1).max(10_000),
});
export const VolunteerSlotInputSchema = z.strictObject({
  title: z.string().trim().min(2).max(100),
  capacity: z.number().int().min(1).max(500),
});
/** Time rules (start in the future) are checked by the server at creation. */
export const CreateEventBodySchema = z.strictObject({
  title: z.string().trim().min(3).max(100),
  purpose: z.string().trim().min(10).max(2000),
  startsAt: IsoDateTimeSchema,
  endsAt: IsoDateTimeSchema.nullable().default(null),
  areaLabel: z.string().trim().min(2).max(120),
  /** Exact point from the location picker or saved Profile location; private. */
  location: LatLngSchema,
  privateNote: z.string().trim().max(1000).default(''),
  needs: z.array(EventNeedInputSchema).max(EVENT_LIMITS.needs),
  slots: z.array(VolunteerSlotInputSchema).max(EVENT_LIMITS.slots),
}).refine(b => b.needs.length + b.slots.length > 0, { message: 'Add at least one confirmed need or volunteer slot', path: ['needs'] })
  .refine(b => b.endsAt === null || Date.parse(b.endsAt) >= Date.parse(b.startsAt), { message: 'End must be after start', path: ['endsAt'] });
export type CreateEventBody = z.infer<typeof CreateEventBodySchema>;

export const EventPledgeSchema = z.object({
  id: IdSchema, needId: IdSchema, needTitle: z.string(), quantity: z.number().int(), note: z.string(), status: EventPledgeStatusSchema,
  /** Shown to the organizer only. */
  contributorName: z.string().nullable(), mine: z.boolean(),
  allowedActions: z.array(EventPledgeStatusSchema.exclude(['pledged'])), createdAt: IsoDateTimeSchema,
});
export type EventPledge = z.infer<typeof EventPledgeSchema>;
export const VolunteerSignupSchema = z.object({
  id: IdSchema, slotId: IdSchema, slotTitle: z.string(), status: VolunteerSignupStatusSchema,
  contributorName: z.string().nullable(), mine: z.boolean(),
  allowedActions: z.array(VolunteerSignupStatusSchema.exclude(['pending'])), createdAt: IsoDateTimeSchema,
});
export type VolunteerSignup = z.infer<typeof VolunteerSignupSchema>;

export const EventNeedSchema = z.object({
  id: IdSchema, title: z.string(), category: ItemCategorySchema, quantity: z.number().int(),
  /** Units in live pledges (pledged + accepted + received) and in received pledges. */
  pledged: z.number().int(), received: z.number().int(),
});
export const VolunteerSlotSchema = z.object({ id: IdSchema, title: z.string(), capacity: z.number().int(), taken: z.number().int(), accepted: z.number().int() });

export const CharityEventSummarySchema = z.object({
  id: IdSchema, title: z.string(), purpose: z.string(), status: CharityEventStatusSchema,
  startsAt: IsoDateTimeSchema, endsAt: IsoDateTimeSchema.nullable(), location: ApproximateLocationSchema,
  organizerId: IdSchema, organizerName: z.string(), isOrganizer: z.boolean(),
  needs: z.array(EventNeedSchema), slots: z.array(VolunteerSlotSchema),
});
export type CharityEventSummary = z.infer<typeof CharityEventSummarySchema>;
export const CharityEventDetailSchema = CharityEventSummarySchema.extend({
  /** Organizer sees all contributions; others see only their own. */
  pledges: z.array(EventPledgeSchema), signups: z.array(VolunteerSignupSchema),
  /** Present only for the organizer and contributors whose pledge or signup was accepted. */
  privateLocation: z.object({ exactLocation: LatLngSchema, note: z.string() }).nullable(),
});
export type CharityEventDetail = z.infer<typeof CharityEventDetailSchema>;
export const CharityEventListSchema = z.object({ items: z.array(CharityEventSummarySchema) });

export const SearchEventsQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180), radiusKm: RadiusKmSchema,
});
export const CreatePledgeBodySchema = z.strictObject({ needId: IdSchema, quantity: z.number().int().min(1).max(10_000), note: z.string().trim().max(300).default('') });
export const PledgeTransitionBodySchema = z.strictObject({ to: EventPledgeStatusSchema.exclude(['pledged']) });
export const SignupTransitionBodySchema = z.strictObject({ to: VolunteerSignupStatusSchema.exclude(['pending']) });

/** AI output: an editable draft. Everything in it is a suggestion until the organizer confirms. */
export const EventDraftBodySchema = z.strictObject({ text: z.string().trim().min(10).max(2000) });
export const EventDraftSchema = z.object({
  title: z.string().trim().max(100).nullable(),
  purpose: z.string().trim().max(2000).nullable(),
  /** Only when the organizer stated it; never invented. */
  startsAtText: z.string().trim().max(120).nullable(),
  suggestedSupplies: z.array(z.object({
    title: z.string().trim().min(1).max(100), category: ItemCategorySchema,
    quantity: z.number().int().min(1).max(10_000).nullable(),
    /** True when the organizer named this item; false for an AI idea. */
    statedByOrganizer: z.boolean(), reason: z.string().trim().max(200),
  })).max(15),
  suggestedSlots: z.array(z.object({ title: z.string().trim().min(1).max(100), capacity: z.number().int().min(1).max(500).nullable(), statedByOrganizer: z.boolean() })).max(8),
  outOfScope: z.array(z.string().trim().max(200)).max(5),
});
export type EventDraft = z.infer<typeof EventDraftSchema>;
export const EventDraftResponseSchema = z.object({ draft: EventDraftSchema, requiresUserReview: z.literal(true) });
