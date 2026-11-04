import type { ItemCategory, ItemCondition, ListingMode } from '@neighbourhood/shared';
import type { createRetryKey } from '../activity/retry-key';

export interface ShareDraft {
  mode: ListingMode; category: ItemCategory; title: string; description: string; condition: ItemCondition; quantity: number;
  pickupInstructions: string; bestBefore: string; applianceModel: string; powerRequirement: string; maxLoanDays: number;
  applianceStatus: 'working' | 'partially_working' | 'not_working' | 'unknown'; applianceBrand: string; applianceWeight: string;
  dimensions: { width: string; height: string; depth: string }; floor: string; elevator: boolean | null; dismantling: boolean | null;
  installation: boolean | null; helpers: string; accessNotes: string; photoFile: File | null;
  foodRescue?: boolean; collectBy?: string; foodPreparedAt?: string; foodStorage?: string; foodAllergens?: string;
  retryKeys: ReturnType<typeof createRetryKey>; photoKey: string;
}
// Browser memory only, scoped to the authenticated identity; no private form or File is written to storage.
const drafts = new Map<string, ShareDraft>();
export const getShareDraft = (userId: string) => drafts.get(userId);
export const saveShareDraft = (userId: string, draft: ShareDraft) => { drafts.set(userId, draft); };
export const removeShareDraft = (userId: string) => { drafts.delete(userId); };
export const clearShareDrafts = () => { drafts.clear(); };
