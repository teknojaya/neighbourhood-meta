import { describe, expect, it } from 'vitest';
import { groundEventDraft } from './events.ai.js';

describe('groundEventDraft', () => {
  it('keeps organizer-stated items and quantities and demotes unverified claims to AI ideas', () => {
    const input = 'Back-to-school drive on Saturday. We need 40 notebooks and 2 helpers to sort donations.';
    const draft = groundEventDraft({ title: 'Drive', purpose: 'Help kids', startsAtText: 'Saturday',
      suggestedSupplies: [
        { title: 'Notebooks', category: 'books', quantity: 40, statedByOrganizer: true, reason: '' },
        { title: 'Pencils', category: 'books', quantity: 50, statedByOrganizer: true, reason: 'Pairs with notebooks' },
        { title: 'Notebooks', category: 'books', quantity: 99, statedByOrganizer: true, reason: '' },
      ],
      suggestedSlots: [{ title: 'Sorting helpers', capacity: 2, statedByOrganizer: true }, { title: 'Greeters', capacity: 5, statedByOrganizer: false }],
      outOfScope: [] }, input);
    expect(draft.suggestedSupplies.map(s => [s.statedByOrganizer, s.quantity])).toEqual([[true, 40], [false, 50], [true, null]]);
    expect(draft.suggestedSlots.map(s => [s.statedByOrganizer, s.capacity])).toEqual([[true, 2], [false, null]]);
    expect(draft.startsAtText).toBe('Saturday');
    expect(groundEventDraft({ ...draft, startsAtText: 'Next Monday 9am' }, input).startsAtText).toBeNull();
  });
});
