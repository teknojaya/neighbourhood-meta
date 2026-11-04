import { describe, expect, it } from 'vitest';
import { guardFoodFacts } from './ask.presentation.js';

describe('guardFoodFacts', () => {
  it('drops food safety facts the resident never stated', () => {
    const args = { foodAllergens: 'Contains peanuts', foodStorage: 'Refrigerated', foodPreparedAt: '2030-01-01T10:00:00Z', collectBy: '2030-01-01T12:00:00Z' };
    guardFoodFacts(args, [{ role: 'user', text: 'I have leftover satay to give away' }, { role: 'assistant', text: 'It may contain peanuts and should be refrigerated' }]);
    expect(args).toEqual({ foodAllergens: null, foodStorage: null, foodPreparedAt: null, collectBy: null });
  });
  it('keeps facts the resident typed', () => {
    const args = { foodAllergens: 'Peanuts', foodStorage: 'In the fridge', foodPreparedAt: '2030-01-01T10:00:00Z', collectBy: '2030-01-01T12:00:00Z' };
    guardFoodFacts(args, [{ role: 'user', text: 'Cooked at noon, has peanuts, kept in the fridge. Pick up within 3 hours' }]);
    expect(args.foodAllergens).toBe('Peanuts');
    expect(args.foodStorage).toBe('In the fridge');
    expect(args.foodPreparedAt).not.toBeNull();
    expect(args.collectBy).not.toBeNull();
  });
});
