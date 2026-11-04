import { FOOD_RESCUE_LIMITS, FoodRescuePublicSchema, type FoodRescueInput } from '@neighbourhood/shared';
import { HttpError } from '../../lib/http.js';

/** Server-side deadline rules, applied at the moment an action happens. */
export function assertFutureCollectBy(collectBy: Date, now = new Date()) {
  if (Number.isNaN(collectBy.getTime()) || collectBy.getTime() <= now.getTime()) throw new HttpError('VALIDATION_FAILED', 'Collect-by time must be in the future');
  if (collectBy.getTime() > now.getTime() + FOOD_RESCUE_LIMITS.maxHoursAhead * 3_600_000) throw new HttpError('VALIDATION_FAILED', `Collect-by time must be within ${FOOD_RESCUE_LIMITS.maxHoursAhead / 24} days`);
}

export function assertPreparedNotInFuture(preparedAt: Date | null, now = new Date()) {
  // A small allowance for device clock skew; preparation is a past fact.
  if (preparedAt && preparedAt.getTime() > now.getTime() + 5 * 60_000) throw new HttpError('VALIDATION_FAILED', 'Preparation time cannot be in the future');
}

export function foodCreateData(food: FoodRescueInput | null, now = new Date()) {
  if (!food) return {};
  const collectBy = new Date(food.collectBy), preparedAt = food.preparedAt ? new Date(food.preparedAt) : null;
  assertFutureCollectBy(collectBy, now);
  assertPreparedNotInFuture(preparedAt, now);
  return { foodRescue: true, collectBy, foodPreparedAt: preparedAt, foodStorage: food.storage, foodAllergens: food.allergens };
}

export const foodExpired = (row: { foodRescue: boolean; collectBy: Date | null }, now = new Date()) =>
  row.foodRescue && (!row.collectBy || row.collectBy.getTime() <= now.getTime());

export function foodPublic(row: { foodRescue: boolean; collectBy: Date | null; foodPreparedAt: Date | null; foodStorage: string | null; foodAllergens: string | null }, now = new Date()) {
  if (!row.foodRescue || !row.collectBy) return null;
  return FoodRescuePublicSchema.parse({ collectBy: row.collectBy.toISOString(), preparedAt: row.foodPreparedAt?.toISOString() ?? null,
    storage: row.foodStorage, allergens: row.foodAllergens, expired: foodExpired(row, now) });
}
