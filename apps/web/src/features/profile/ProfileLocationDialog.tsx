import { lazy, Suspense, useReducer, useState } from 'react';
import { type PlaceKind, PlaceReverseSchema } from '@neighbourhood/shared';
import { useMe, useSaveProfile } from '../../auth/useMe';
import { Alert, Button, Dialog, Skeleton, TextField } from '../../components/ui';
import { CloseIcon } from '../../components/icons';
import { api } from '../../lib/api';
import { useOnline } from '../../lib/useOnline';
import { featureError } from '../activity/feature-errors';
import { draftReducer, initialDraft, saveableLocation } from './locationDraft';
import { PlaceSearchField } from './PlaceSearchField';

const LocationPickerMap = lazy(() => import('./LocationPickerMap'));
const ZOOM: Record<PlaceKind, number> = { neighbourhood: 14, city: 12, region: 9 };

/** Saves only through the authenticated Profile endpoint; private coordinates stay out of chat. */
export function ProfileLocationDialog({ onClose, onSaved }: { onClose(): void; onSaved(): void }) {
  const me = useMe();
  return <Dialog label="Set Profile location" onClose={onClose}><div className="mb-4 flex items-center justify-between gap-2"><h2 className="text-xl font-bold">Your pickup area</h2><Button variant="ghost" aria-label="Close location form" onClick={onClose}><CloseIcon /></Button></div><p className="mb-4 text-sm text-stone-600">Saved to Profile for nearby discovery and your listings. Only the area name is public; your pin stays private.</p>{me.isPending && <Skeleton cards={1} />}{me.isError && <Alert tone="error">{featureError(me.error)} <Button variant="ghost" onClick={() => void me.refetch()}>Try again</Button></Alert>}{me.data && <LocationForm profile={me.data.profile} onSaved={onSaved} onCancel={onClose} />}</Dialog>;
}

type Geo = { state: 'idle' | 'locating' } | { state: 'denied' | 'unavailable' | 'unnamed'; detail?: string };

function LocationForm({ profile, onSaved, onCancel }: { profile: NonNullable<ReturnType<typeof useMe>['data']>['profile']; onSaved(): void; onCancel(): void }) {
  const save = useSaveProfile(), online = useOnline();
  const [name, setName] = useState(profile.displayName ?? '');
  const [draft, dispatch] = useReducer(draftReducer, profile, initialDraft);
  const [focusKey, setFocusKey] = useState('initial');
  const [geo, setGeo] = useState<Geo>({ state: 'idle' });
  const [tried, setTried] = useState(false);
  const result = saveableLocation(draft);

  function locate() {
    if (!navigator.geolocation) { setGeo({ state: 'unavailable' }); return; }
    setGeo({ state: 'locating' });
    navigator.geolocation.getCurrentPosition(async position => {
      const point = { lat: Math.round(position.coords.latitude * 1e6) / 1e6, lng: Math.round(position.coords.longitude * 1e6) / 1e6 };
      const named = await api(`/api/v1/places/reverse?${new URLSearchParams({ lat: String(point.lat), lng: String(point.lng), lang: profile.preferredLanguage })}`, { schema: PlaceReverseSchema }).then(r => r.item, (error: unknown) => { setGeo({ state: 'unnamed', detail: featureError(error) }); return undefined; });
      dispatch({ type: 'device', point, place: named ?? null });
      setFocusKey(`device:${point.lat},${point.lng}`);
      if (named) setGeo({ state: 'idle' }); else if (named === null) setGeo({ state: 'unnamed' });
    }, error => setGeo({ state: error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable' }), { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  }

  const problem = !result.ok ? result.problem : null;
  const problemText = problem === 'no_area' ? (draft.pin ? 'Choose a neighbourhood, city or region from the search results to name your public area.' : 'Search for your area or use device location.')
    : problem === 'pin_outside_area' ? `The pin is too far from ${draft.area?.label}. Move it back, or search for the area where the pin is.`
    : problem === 'unconfirmed' ? 'Check the pin and confirm it marks your pickup / search area.' : problem === 'no_pin' ? 'Place the pin on the map.' : '';
  const approximate = draft.area && draft.area.source === 'search' && draft.pin && draft.pin.lat === draft.area.location.lat && draft.pin.lng === draft.area.location.lng;

  return <form className="space-y-4" noValidate onSubmit={event => {
    event.preventDefault(); setTried(true);
    if (!result.ok || (!profile.displayName && name.trim().length < 2)) return;
    save.mutate({ displayName: (profile.displayName ?? name).trim(), areaLabel: result.areaLabel, homeLocation: result.homeLocation, searchRadiusKm: profile.searchRadiusKm, preferredLanguage: profile.preferredLanguage }, { onSuccess: onSaved });
  }}>
    {!profile.displayName && <TextField label="Display name" required minLength={2} maxLength={60} value={name} onChange={event => setName(event.target.value)} />}
    {profile.homeLocation && profile.areaLabel && <p className="text-sm text-stone-600">Current: <span className="font-semibold text-stone-900">{profile.areaLabel}</span>. It stays saved unless you confirm a new location.</p>}
    <PlaceSearchField value={draft.text} lang={profile.preferredLanguage} onTextChange={text => dispatch({ type: 'typed', text })} onSelect={place => { dispatch({ type: 'selected', place }); setFocusKey(`place:${place.id}`); setGeo({ state: 'idle' }); }} />
    <Button type="button" variant="secondary" disabled={geo.state === 'locating' || save.isPending} onClick={locate}>{geo.state === 'locating' ? 'Finding your location…' : 'Use device location'}</Button>
    {geo.state === 'denied' && <Alert tone="warning">Location access is blocked. Allow it in your browser’s site settings, or search for your area instead.</Alert>}
    {geo.state === 'unavailable' && <Alert tone="warning">Your device couldn’t find a location. Search for your area instead.</Alert>}
    {geo.state === 'unnamed' && <Alert tone="warning">The pin is at your device location, but we couldn’t name the area{geo.detail ? ` (${geo.detail})` : ''}. Search for your neighbourhood or city to set the public label.</Alert>}

    {draft.pin && <div className="space-y-2">
      {draft.area && <p className="text-sm">Public area: <span className="font-semibold">{draft.area.label}</span></p>}
      {approximate && <p className="text-sm text-brand-800">The pin starts at the centre of this {draft.area!.kind}. Move it to roughly where you hand over items or search from.</p>}
      <Suspense fallback={<div role="status" className="flex h-56 animate-pulse items-center justify-center rounded-xl bg-stone-100 text-sm text-stone-600">Loading map…</div>}>
        <LocationPickerMap pin={draft.pin} zoom={draft.area ? ZOOM[draft.area.kind] : 14} focusKey={focusKey} onPinChange={point => dispatch({ type: 'pin', point })} />
      </Suspense>
      {draft.area && <label className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-brand-700" checked={draft.confirmed} onChange={event => dispatch({ type: 'confirm', value: event.target.checked })} /><span>The pin marks my pickup / search area in {draft.area.label}. Only the area name is shown to others.</span></label>}
    </div>}

    <details className="rounded-xl border border-stone-200 px-3 py-2">
      <summary className="cursor-pointer py-2 text-sm font-semibold text-brand-800">Advanced: pin coordinates</summary>
      <Coordinates key={draft.pin ? `${draft.pin.lat},${draft.pin.lng}` : 'none'} pin={draft.pin} onChange={point => { dispatch({ type: 'pin', point }); setFocusKey(`manual:${point.lat},${point.lng}`); }} />
    </details>

    {(tried || problem === 'pin_outside_area') && problemText && <Alert tone={problem === 'pin_outside_area' ? 'warning' : 'info'}>{problemText}</Alert>}
    {save.isError && <Alert tone="error">{featureError(save.error)} Your previously saved location is unchanged.</Alert>}
    {!online && <Alert tone="warning">Reconnect to save your location.</Alert>}
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <Button type="button" variant="secondary" onClick={onCancel} disabled={save.isPending}>Cancel</Button>
      <Button type="submit" disabled={!online || save.isPending || geo.state === 'locating' || (tried && !result.ok)}>{save.isPending ? 'Saving…' : 'Save location'}</Button>
    </div>
  </form>;
}

/** Manual entry moves the same pin, so the label check and confirmation still apply. */
function Coordinates({ pin, onChange }: { pin: { lat: number; lng: number } | null; onChange(point: { lat: number; lng: number }): void }) {
  const [lat, setLat] = useState(pin ? String(pin.lat) : ''), [lng, setLng] = useState(pin ? String(pin.lng) : '');
  const valid = lat.trim() !== '' && lng.trim() !== '' && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lng)) <= 180 && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));
  return <div className="space-y-2 pb-2">
    <p className="text-xs text-stone-600">Private. Used only for distance; never shown to other people.</p>
    <div className="grid grid-cols-2 gap-3"><TextField label="Latitude" inputMode="decimal" value={lat} onChange={event => setLat(event.target.value)} /><TextField label="Longitude" inputMode="decimal" value={lng} onChange={event => setLng(event.target.value)} /></div>
    <Button type="button" variant="secondary" disabled={!valid} onClick={() => onChange({ lat: Number(lat), lng: Number(lng) })}>Move pin to these coordinates</Button>
  </div>;
}
