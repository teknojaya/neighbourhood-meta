import { type LatLng, type PlaceKind, type PlaceSuggestion, PLACE_QUERY_MIN_LENGTH, pinMatchesArea } from '@neighbourhood/shared';

/** The area whose label will be public, with the point it was found at. */
export interface DraftArea { kind: PlaceKind; label: string; location: LatLng; source: 'search' | 'device' | 'saved' }
export interface LocationDraft { text: string; area: DraftArea | null; pin: LatLng | null; confirmed: boolean }

export type DraftAction =
  | { type: 'typed'; text: string }
  | { type: 'selected'; place: PlaceSuggestion }
  | { type: 'device'; point: LatLng; place: PlaceSuggestion | null }
  | { type: 'pin'; point: LatLng }
  | { type: 'confirm'; value: boolean };

export function initialDraft(saved: { areaLabel: string | null; homeLocation: LatLng | null }): LocationDraft {
  const label = saved.areaLabel?.trim() ?? '';
  // A saved location was already confirmed; it stays as-is until the user changes it.
  if (label && saved.homeLocation) return { text: label, area: { kind: 'city', label, location: saved.homeLocation, source: 'saved' }, pin: saved.homeLocation, confirmed: true };
  return { text: label, area: null, pin: saved.homeLocation, confirmed: false };
}

/** Any change to the label or the pin needs a fresh confirmation. */
export function draftReducer(state: LocationDraft, action: DraftAction): LocationDraft {
  switch (action.type) {
    case 'typed': return action.text === state.text ? state : { ...state, text: action.text, area: null, confirmed: false };
    case 'selected': return { text: action.place.label, area: { kind: action.place.kind, label: action.place.label, location: action.place.location, source: 'search' }, pin: action.place.location, confirmed: false };
    case 'device': return { text: action.place?.label ?? '', area: action.place ? { kind: action.place.kind, label: action.place.label, location: action.place.location, source: 'device' } : null, pin: action.point, confirmed: false };
    case 'pin': return { ...state, pin: action.point, confirmed: false };
    case 'confirm': return { ...state, confirmed: action.value };
  }
}

export type DraftProblem = 'no_area' | 'no_pin' | 'pin_outside_area' | 'unconfirmed';

/** What may be saved: the label and pin only together, and only once confirmed. */
export function saveableLocation(state: LocationDraft): { ok: true; areaLabel: string; homeLocation: LatLng } | { ok: false; problem: DraftProblem } {
  if (!state.area) return { ok: false, problem: 'no_area' };
  if (!state.pin) return { ok: false, problem: 'no_pin' };
  if (!pinMatchesArea(state.area, state.pin)) return { ok: false, problem: 'pin_outside_area' };
  if (!state.confirmed) return { ok: false, problem: 'unconfirmed' };
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return { ok: true, areaLabel: state.area.label, homeLocation: { lat: round(state.pin.lat), lng: round(state.pin.lng) } };
}

export type SuggestionState =
  | { status: 'idle' }
  | { status: 'loading'; query: string }
  | { status: 'ready'; query: string; items: PlaceSuggestion[] }
  | { status: 'error'; query: string; error: unknown };

/**
 * Debounces typing, aborts the previous request and ignores any response that
 * arrives after a newer query, so suggestions always belong to the current text.
 */
export function createSuggestionLoader(fetcher: (query: string, signal: AbortSignal) => Promise<PlaceSuggestion[]>, onChange: (state: SuggestionState) => void, debounceMs = 300) {
  let timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined, seq = 0;
  const cancel = () => { clearTimeout(timer); controller?.abort(); controller = undefined; seq++; };
  return {
    search(text: string) {
      cancel();
      const query = text.trim();
      if (query.length < PLACE_QUERY_MIN_LENGTH) { onChange({ status: 'idle' }); return; }
      const id = seq;
      timer = setTimeout(() => {
        const current = controller = new AbortController();
        onChange({ status: 'loading', query });
        fetcher(query, current.signal).then(
          items => { if (id === seq) onChange({ status: 'ready', query, items }); },
          (error: unknown) => { if (id === seq && !current.signal.aborted) onChange({ status: 'error', query, error }); },
        );
      }, debounceMs);
    },
    clear() { cancel(); onChange({ status: 'idle' }); },
    dispose: cancel,
  };
}
