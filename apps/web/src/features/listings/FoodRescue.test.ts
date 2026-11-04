import { describe, expect, it } from 'vitest';
import { countdownText, fromLocalInput, isFoodExpired, toLocalInput } from './FoodRescue';

describe('food rescue display helpers', () => {
  const now = Date.parse('2030-01-01T10:00:00Z');
  it('formats a countdown and reports a passed deadline', () => {
    expect(countdownText('2030-01-01T12:30:00Z', now)).toBe('2 h 30 min left');
    expect(countdownText('2030-01-03T11:00:00Z', now)).toBe('2 d 1 h left');
    expect(countdownText('2030-01-01T09:59:00Z', now)).toBe('Collect-by time has passed');
  });
  it('treats an offer as closed once its deadline passes, even before the server marks it', () => {
    expect(isFoodExpired({ collectBy: '2030-01-01T09:00:00Z', preparedAt: null, storage: null, allergens: null, expired: false }, now)).toBe(true);
    expect(isFoodExpired(null, now)).toBe(false);
  });
  it('round-trips local input values', () => {
    const iso = '2030-01-01T10:15:00.000Z';
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
  });
});
