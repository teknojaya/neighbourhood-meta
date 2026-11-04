import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema, pageOf } from '../common.js';
import { NeedsExtractionSchema } from '../ai/contracts.js';
import { ListingPublicSchema } from './listings.js';

/** The user confirms the AI draft before it becomes a saved, private need. */
export const SaveNeedBodySchema = z.strictObject({ extraction: NeedsExtractionSchema });
export type SaveNeedBody = z.infer<typeof SaveNeedBodySchema>;

export const SavedNeedSchema = z.object({
  id: IdSchema,
  extraction: NeedsExtractionSchema,
  createdAt: IsoDateTimeSchema,
});
export type SavedNeed = z.infer<typeof SavedNeedSchema>;
export const SavedNeedPageSchema = pageOf(SavedNeedSchema);
export const NeedMatchesSchema = z.object({ items: z.array(z.object({ listing: ListingPublicSchema, fit: z.enum(['strong', 'partial', 'weak']), reason: z.string(), missingInfo: z.array(z.string()) })), explanationSource: z.enum(['filters', 'model']) });
