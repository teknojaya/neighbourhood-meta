import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlaceSuggestion } from '@neighbourhood/shared';
import { createSuggestionLoader, draftReducer, initialDraft, saveableLocation, type SuggestionState } from './locationDraft';

const place = (label: string, lat: number, lng: number, kind: PlaceSuggestion['kind'] = 'city'): PlaceSuggestion => ({ id: label, kind, label, name: label.split(',')[0]!, city: null, region: 'West Java', country: 'Indonesia', location: { lat, lng } });
const bandung = place('Bandung, West Java', -6.917, 107.619);
const tebet = place('Tebet, South Jakarta', -6.226, 106.858, 'neighbourhood');
const saved = { areaLabel: 'Menteng, Central Jakarta', homeLocation: { lat: -6.195, lng: 106.83 } };

describe('location draft', () => {
  it('sets the public label and coordinates together from one selected place', () => {
    const s = draftReducer(draftReducer(initialDraft(saved), { type: 'selected', place: bandung }), { type: 'confirm', value: true });
    expect(saveableLocation(s)).toEqual({ ok: true, areaLabel: 'Bandung, West Java', homeLocation: { lat: -6.917, lng: 107.619 } });
  });

  it('invalidates the selected candidate as soon as the search text is edited', () => {
    let s = draftReducer(initialDraft(saved), { type: 'selected', place: bandung });
    s = draftReducer(draftReducer(s, { type: 'confirm', value: true }), { type: 'typed', text: 'Bandung, West Jav' });
    expect(s.area).toBeNull();
    expect(saveableLocation(s)).toEqual({ ok: false, problem: 'no_area' });
    // Editing the text of a saved location also stops it being saved under a new label.
    expect(saveableLocation(draftReducer(initialDraft(saved), { type: 'typed', text: 'Somewhere else' }))).toEqual({ ok: false, problem: 'no_area' });
  });

  it('requires a fresh confirmation after the pin moves, and keeps the pin within the chosen area', () => {
    let s = draftReducer(draftReducer(initialDraft(saved), { type: 'selected', place: tebet }), { type: 'confirm', value: true });
    s = draftReducer(s, { type: 'pin', point: { lat: -6.24, lng: 106.86 } });
    expect(saveableLocation(s)).toEqual({ ok: false, problem: 'unconfirmed' });
    s = draftReducer(s, { type: 'confirm', value: true });
    expect(saveableLocation(s)).toMatchObject({ ok: true, areaLabel: 'Tebet, South Jakarta', homeLocation: { lat: -6.24, lng: 106.86 } });
    // Dragging the pin to Bandung while the label still says Tebet is refused.
    s = draftReducer(draftReducer(s, { type: 'pin', point: bandung.location }), { type: 'confirm', value: true });
    expect(saveableLocation(s)).toEqual({ ok: false, problem: 'pin_outside_area' });
  });

  it('keeps the existing saved location unchanged until something new is confirmed', () => {
    expect(saveableLocation(initialDraft(saved))).toEqual({ ok: true, ...saved });
    const unnamedDevice = draftReducer(initialDraft(saved), { type: 'device', point: { lat: -6.9, lng: 107.6 }, place: null });
    expect(saveableLocation(draftReducer(unnamedDevice, { type: 'confirm', value: true }))).toEqual({ ok: false, problem: 'no_area' });
    expect(saveableLocation(initialDraft({ areaLabel: null, homeLocation: saved.homeLocation }))).toEqual({ ok: false, problem: 'no_area' });
  });
});

describe('suggestion loader', () => {
  afterEach(() => { vi.useRealTimers(); });
  function setup() {
    vi.useFakeTimers();
    const calls: Array<{ query: string; signal: AbortSignal; resolve(items: PlaceSuggestion[]): void; reject(e: unknown): void }> = [];
    const states: SuggestionState[] = [];
    const loader = createSuggestionLoader((query, signal) => new Promise((resolve, reject) => calls.push({ query, signal, resolve, reject })), s => states.push(s), 300);
    return { calls, states, loader, last: () => states.at(-1) };
  }

  it('debounces keystrokes into one request and skips too-short text', () => {
    const { calls, loader, last } = setup();
    loader.search('B'); vi.advanceTimersByTime(500);
    expect(calls).toHaveLength(0); expect(last()).toEqual({ status: 'idle' });
    loader.search('Ba'); vi.advanceTimersByTime(100); loader.search('Ban'); vi.advanceTimersByTime(100); loader.search('Band'); vi.advanceTimersByTime(300);
    expect(calls.map(c => c.query)).toEqual(['Band']);
  });

  it('aborts and ignores a slower earlier response once newer text is searched', async () => {
    const { calls, loader, last } = setup();
    loader.search('Teb'); vi.advanceTimersByTime(300);
    loader.search('Bandung'); vi.advanceTimersByTime(300);
    expect(calls[0]!.signal.aborted).toBe(true);
    calls[1]!.resolve([bandung]); await Promise.resolve();
    calls[0]!.resolve([tebet]); await Promise.resolve();
    expect(last()).toEqual({ status: 'ready', query: 'Bandung', items: [bandung] });
    calls[0]!.reject(new Error('late failure')); await Promise.resolve();
    expect(last()).toMatchObject({ status: 'ready', query: 'Bandung' });
  });

  it('drops in-flight results when the field is cleared or a place is chosen', async () => {
    const { calls, loader, last } = setup();
    loader.search('Tebet'); vi.advanceTimersByTime(300);
    loader.clear(); calls[0]!.resolve([tebet]); await Promise.resolve();
    expect(last()).toEqual({ status: 'idle' });
  });

  it('reports a provider error for the current query only', async () => {
    const { calls, loader, last } = setup();
    loader.search('Tebet'); vi.advanceTimersByTime(300);
    calls[0]!.reject(new Error('unavailable')); await Promise.resolve();
    expect(last()).toMatchObject({ status: 'error', query: 'Tebet' });
  });
});
