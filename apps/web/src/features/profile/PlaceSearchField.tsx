import { useEffect, useId, useMemo, useState } from 'react';
import { type PlaceSuggestion, type UiLanguage, PlaceSuggestionsSchema } from '@neighbourhood/shared';
import { api, ApiError } from '../../lib/api';
import { featureError } from '../activity/feature-errors';
import { createSuggestionLoader, type SuggestionState } from './locationDraft';

/** City, province and country, so places with the same name can be told apart. */
export function placeContext(place: PlaceSuggestion) {
  return [...new Set([place.city, place.region, place.country].filter((part): part is string => Boolean(part) && part !== place.name))].join(', ');
}

const KIND_LABEL = { neighbourhood: 'Neighbourhood', city: 'City', region: 'Region' } as const;

export function PlaceSearchField({ value, lang, onTextChange, onSelect }: { value: string; lang: UiLanguage; onTextChange(text: string): void; onSelect(place: PlaceSuggestion): void }) {
  const id = useId();
  const [state, setState] = useState<SuggestionState>({ status: 'idle' });
  const [open, setOpen] = useState(false), [active, setActive] = useState(-1);
  const loader = useMemo(() => createSuggestionLoader((q, signal) => api(`/api/v1/places/autocomplete?${new URLSearchParams({ q, lang })}`, { schema: PlaceSuggestionsSchema, signal }).then(r => r.items), next => { setState(next); setActive(-1); }), [lang]);
  useEffect(() => () => loader.dispose(), [loader]);
  const items = state.status === 'ready' ? state.items : [];
  const expanded = open && items.length > 0;
  function choose(place: PlaceSuggestion) { loader.clear(); setOpen(false); onSelect(place); }
  const notConfigured = state.status === 'error' && state.error instanceof ApiError && state.error.code === 'GEOCODING_NOT_CONFIGURED';

  return <div className="space-y-1">
    <label htmlFor={id} className="block text-sm font-medium text-stone-800">Search neighbourhood, city or region</label>
    <div className="relative">
      <input id={id} type="search" role="combobox" autoComplete="off" spellCheck={false} maxLength={100} enterKeyHint="search"
        aria-autocomplete="list" aria-expanded={expanded} aria-controls={`${id}-list`} aria-describedby={`${id}-status`}
        aria-activedescendant={expanded && active >= 0 ? `${id}-opt-${active}` : undefined}
        className="block min-h-11 w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-base focus:border-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-700/20"
        placeholder="For example: Tebet or Bandung" value={value}
        onChange={event => { onTextChange(event.target.value); setOpen(true); loader.search(event.target.value); }}
        onBlur={() => setOpen(false)} onFocus={() => setOpen(true)}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' && items.length) { event.preventDefault(); setOpen(true); setActive((active + 1) % items.length); }
          else if (event.key === 'ArrowUp' && items.length) { event.preventDefault(); setOpen(true); setActive(active <= 0 ? items.length - 1 : active - 1); }
          else if (event.key === 'Enter' && expanded) { event.preventDefault(); const pick = items[active >= 0 ? active : 0]; if (pick) choose(pick); }
          else if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
        }} />
      {expanded && <ul id={`${id}-list`} role="listbox" aria-label="Matching places" className="absolute inset-x-0 top-full z-[1100] mt-1 max-h-72 overflow-y-auto rounded-xl border border-stone-200 bg-white py-1 shadow-lg">
        {items.map((place, index) => <li key={place.id} id={`${id}-opt-${index}`} role="option" aria-selected={index === active}
          className={`cursor-pointer px-3 py-2 ${index === active ? 'bg-brand-50' : 'hover:bg-stone-50'}`}
          // mousedown keeps focus in the input so the choice lands before blur closes the list.
          onMouseDown={event => { event.preventDefault(); choose(place); }}>
          <span className="block font-semibold">{place.name}</span>
          <span className="block text-sm text-stone-600">{[KIND_LABEL[place.kind], placeContext(place)].filter(Boolean).join(' · ')}</span>
        </li>)}
      </ul>}
    </div>
    <p id={`${id}-status`} role="status" className="min-h-5 text-sm text-stone-600">
      {state.status === 'loading' ? 'Searching places…'
        : state.status === 'ready' && !items.length ? `No neighbourhood, city or region matches “${state.query}”. Check the spelling or try a nearby city.`
        : state.status === 'error' ? <span className="text-red-800">{notConfigured ? 'Place search isn’t available on this server. Use device location, or enter coordinates under Advanced.' : featureError(state.error)}</span>
        : expanded ? `${items.length} ${items.length === 1 ? 'place' : 'places'} found. Use the arrow keys and Enter to choose.` : ''}
    </p>
    <p className="text-xs text-stone-500">Place search powered by <a className="underline" href="https://www.geoapify.com/" target="_blank" rel="noreferrer">Geoapify</a> · data © <a className="underline" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors</p>
  </div>;
}
