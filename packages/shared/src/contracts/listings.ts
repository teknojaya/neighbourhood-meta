import { z } from 'zod';
import { ApproximateLocationSchema, IdSchema, IsoDateTimeSchema, LatLngSchema, pageOf } from '../common.js';
import { CollectionMethodSchema, ItemCategorySchema, ItemConditionSchema, ListingModeSchema } from '../enums.js';
import { RadiusKmSchema } from '../geo.js';
import { ListingStatusSchema } from '../domain/machines.js';
import { StockSchema } from '../domain/stock.js';

/** Unknown facts stay `null` — never guessed by UI or AI. */
export const ApplianceDetailsSchema = z.object({
  workingStatus: z.enum(['working', 'partially_working', 'not_working', 'unknown']),
  brand: z.string().max(80).nullable(),
  model: z.string().max(80).nullable(),
  dimensionsCm: z
    .object({
      width: z.number().positive().max(1000),
      height: z.number().positive().max(1000),
      depth: z.number().positive().max(1000),
    })
    .nullable(),
  approxWeightKg: z.number().positive().max(2000).nullable(),
  powerRequirement: z.string().max(80).nullable(),
  /** Access at the pickup location; recipients arrange helpers/transport. */
  access: z.object({
    floorLevel: z.number().int().min(-5).max(100).nullable(),
    elevatorAvailable: z.boolean().nullable(),
    requiresDismantling: z.boolean().nullable(),
    requiresInstallation: z.boolean().nullable(),
    suggestedHelpers: z.number().int().min(1).max(6).nullable(),
    notes: z.string().max(500).nullable(),
  }),
});
export type ApplianceDetails = z.infer<typeof ApplianceDetailsSchema>;

/**
 * Surplus-food rescue details. `null` means the giver did not state it:
 * unknown stays unknown and is never inferred from a photo or by AI.
 * Time-relative rules ("collect-by must be in the future") are enforced by the
 * server when an action happens, never here, so stored review cards still parse.
 */
export const FOOD_RESCUE_LIMITS = { maxHoursAhead: 14 * 24, textMax: 300 } as const;
export const FoodRescueInputSchema = z.strictObject({
  collectBy: IsoDateTimeSchema,
  preparedAt: IsoDateTimeSchema.nullable().default(null),
  storage: z.string().trim().min(1).max(FOOD_RESCUE_LIMITS.textMax).nullable().default(null),
  allergens: z.string().trim().min(1).max(FOOD_RESCUE_LIMITS.textMax).nullable().default(null),
}).refine((f) => f.preparedAt === null || Date.parse(f.preparedAt) <= Date.parse(f.collectBy), {
  message: 'Preparation time must be before the collect-by time', path: ['preparedAt'],
});
export type FoodRescueInput = z.infer<typeof FoodRescueInputSchema>;
export const FoodRescuePublicSchema = z.object({
  collectBy: IsoDateTimeSchema,
  preparedAt: IsoDateTimeSchema.nullable(),
  storage: z.string().nullable(),
  allergens: z.string().nullable(),
  /** Derived from collectBy at read time. */
  expired: z.boolean(),
});
export type FoodRescuePublic = z.infer<typeof FoodRescuePublicSchema>;
/** Partial edit; collectBy may move but never below an approved pickup deadline. */
export const FoodRescueEditSchema = z.strictObject({
  collectBy: IsoDateTimeSchema.optional(),
  preparedAt: IsoDateTimeSchema.nullable().optional(),
  storage: z.string().trim().min(1).max(FOOD_RESCUE_LIMITS.textMax).nullable().optional(),
  allergens: z.string().trim().min(1).max(FOOD_RESCUE_LIMITS.textMax).nullable().optional(),
});

export const ListingPhotoSchema = z.object({
  id: z.uuid().optional(),
  /** Cloud Storage object path under listings/{listingId}/. */
  path: z.string().max(300),
  /** Short-lived signed URL produced server-side or local storage endpoint. */
  url: z.string().optional(),
});

export const LendingTermsSchema = z.object({
  maxLoanDays: z.number().int().min(1).max(90),
  depositRequired: z.literal(false).default(false),
  notes: z.string().max(500).nullable(),
});

/** Public DTO: no exact coordinates or pickup instructions. */
export const ListingPublicSchema = z.object({
  id: IdSchema,
  ownerId: z.string(),
  ownerDisplayName: z.string(),
  status: ListingStatusSchema,
  mode: ListingModeSchema,
  category: ItemCategorySchema,
  title: z.string().max(100),
  description: z.string().max(2000),
  condition: ItemConditionSchema,
  stock: StockSchema,
  photos: z.array(ListingPhotoSchema).max(6),
  location: ApproximateLocationSchema,
  collection: z.object({
    method: CollectionMethodSchema,
    communityPointId: IdSchema.nullable(),
  }),
  appliance: ApplianceDetailsSchema.nullable(),
  lending: LendingTermsSchema.nullable(),
  /** Grocery best-before date if relevant. */
  bestBefore: z.iso.date().nullable(),
  /** Present only for surplus-food rescue offers. Optional for older cached clients. */
  food: FoodRescuePublicSchema.nullable().default(null),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type ListingPublic = z.infer<typeof ListingPublicSchema>;

/**
 * Stored in `listingPrivate/{listingId}`. Returned only to the owner and to
 * requesters/borrowers whose request or loan is approved or checked out.
 */
export const ListingPrivateSchema = z.object({
  listingId: IdSchema,
  exactLocation: LatLngSchema,
  geohash: z.string(),
  pickupInstructions: z.string().max(1000),
  contactNote: z.string().max(300).nullable(),
});
export type ListingPrivate = z.infer<typeof ListingPrivateSchema>;

export const CreateListingBodySchema = z
  .strictObject({
    pointInventoryItemId: z.uuid().nullable().optional().default(null),
    mode: ListingModeSchema,
    category: ItemCategorySchema,
    title: z.string().trim().min(3).max(100),
    description: z.string().trim().max(2000),
    condition: ItemConditionSchema,
    quantity: z.number().int().min(1).max(1000),
    areaLabel: z.string().trim().min(2).max(120),
    exactLocation: LatLngSchema,
    pickupInstructions: z.string().trim().max(1000),
    collection: z.object({ method: CollectionMethodSchema, communityPointId: IdSchema.nullable() }),
    appliance: ApplianceDetailsSchema.nullable().default(null),
    lending: LendingTermsSchema.nullable().default(null),
    bestBefore: z.iso.date().nullable().default(null),
    food: FoodRescueInputSchema.nullable().default(null),
  })
  .refine((b) => b.food === null || (b.mode === 'donate' && b.category === 'groceries'), {
    message: 'Food rescue is for free food donations in the groceries category',
    path: ['food'],
  })
  .refine((b) => b.food === null || (b.collection.method === 'owner_location' && !b.pointInventoryItemId), {
    message: 'Food rescue offers are collected from the giver',
    path: ['food'],
  })
  .refine((b) => b.mode !== 'lend' || b.quantity === 1, {
    message: 'Lending is single-unit: quantity must be 1',
    path: ['quantity'],
  })
  .refine((b) => b.mode !== 'lend' || b.lending !== null, {
    message: 'Lending terms are required for lend listings',
    path: ['lending'],
  })
  .refine((b) => b.category !== 'appliances' || b.appliance !== null, {
    message: 'Appliance details are required for appliances',
    path: ['appliance'],
  })
  .refine((b) => (b.collection.method === 'community_point') === (b.collection.communityPointId !== null), {
    message: 'communityPointId is required only for community_point collection',
    path: ['collection'],
  });
export type CreateListingBody = z.infer<typeof CreateListingBodySchema>;

export const UpdateListingBodySchema = z.strictObject({
  title: z.string().trim().min(3).max(100).optional(),
  description: z.string().trim().max(2000).optional(),
  condition: ItemConditionSchema.optional(),
  quantity: z.number().int().min(1).max(1000).optional(),
  areaLabel: z.string().trim().min(2).max(120).optional(),
  pickupInstructions: z.string().trim().max(1000).optional(),
  appliance: ApplianceDetailsSchema.nullable().optional(),
  lending: LendingTermsSchema.nullable().optional(),
  bestBefore: z.iso.date().nullable().optional(),
  /** Only for listings created as food rescue offers. */
  food: FoodRescueEditSchema.optional(),
});
export type UpdateListingBody = z.infer<typeof UpdateListingBodySchema>;

export const CreateListingPhotoBodySchema = z.strictObject({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});
export type CreateListingPhotoBody = z.infer<typeof CreateListingPhotoBodySchema>;

export const ListingTransitionBodySchema = z.strictObject({
  to: ListingStatusSchema,
});

export const SearchListingsQuerySchema = z.object({
  query: z.string().trim().max(100).optional(),
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusKm: RadiusKmSchema,
  category: ItemCategorySchema.optional(),
  mode: ListingModeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchListingsQuery = z.infer<typeof SearchListingsQuerySchema>;

export const ListingPageSchema = pageOf(ListingPublicSchema);
