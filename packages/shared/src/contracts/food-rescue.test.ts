import { describe, expect, it } from 'vitest';
import { CreateListingBodySchema, ListingPublicSchema } from './listings.js';
import { AskListingDraftDataSchema } from './ask.js';

const base = { mode: 'donate', category: 'groceries', title: 'Surplus rice boxes', description: '', condition: 'new', quantity: 4, areaLabel: 'Tebet',
  exactLocation: { lat: -6.2, lng: 106.8 }, pickupInstructions: 'Gate', collection: { method: 'owner_location', communityPointId: null } };

describe('food rescue contracts', () => {
  it('keeps unstated food details unknown', () => {
    const body = CreateListingBodySchema.parse({ ...base, food: { collectBy: '2030-01-01T12:00:00Z' } });
    expect(body.food).toEqual({ collectBy: '2030-01-01T12:00:00Z', preparedAt: null, storage: null, allergens: null });
  });
  it('limits food rescue to owner-collected grocery donations', () => {
    const food = { collectBy: '2030-01-01T12:00:00Z' };
    expect(CreateListingBodySchema.safeParse({ ...base, category: 'household', food }).success).toBe(false);
    expect(CreateListingBodySchema.safeParse({ ...base, mode: 'lend', quantity: 1, lending: { maxLoanDays: 3, notes: null }, food }).success).toBe(false);
    expect(CreateListingBodySchema.safeParse({ ...base, collection: { method: 'community_point', communityPointId: '00000000-0000-4000-8000-000000000000' }, food }).success).toBe(false);
    expect(CreateListingBodySchema.safeParse({ ...base, food: { ...food, preparedAt: '2030-01-02T00:00:00Z' } }).success).toBe(false);
  });
  it('parses stored payloads whose deadline has passed and older listings without food', () => {
    // Time rules belong to the server action, so an expired review card still renders.
    expect(CreateListingBodySchema.safeParse({ ...base, food: { collectBy: '2001-01-01T00:00:00Z' } }).success).toBe(true);
    expect(AskListingDraftDataSchema.parse({ title: null, category: null, mode: null, condition: null, quantity: null, description: null })).toMatchObject({ foodRescue: null, collectBy: null, foodAllergens: null });
    expect(ListingPublicSchema.shape.food.parse(undefined)).toBeNull();
  });
});
