import { lazy, Suspense, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ITEM_CATEGORIES, type CreateEventBody, type EventDraft, type ItemCategory, type LatLng } from '@neighbourhood/shared';
import { useMe } from '../../auth/useMe';
import { Alert, Button, Card, PageHeading, Skeleton, TextField } from '../../components/ui';
import { ApiError } from '../../lib/api';
import { createRetryKey } from '../activity/retry-key';
import { PlaceSearchField } from '../profile/PlaceSearchField';
import { formatLocalDateTime, fromLocalInput } from '../listings/FoodRescue';
import { createEvent, draftEvent } from './eventsApi';

const LocationPickerMap = lazy(() => import('../profile/LocationPickerMap'));
type NeedRow = { title: string; category: ItemCategory; quantity: string };
type SlotRow = { title: string; capacity: string };
const label = (c: string) => c.replaceAll('_', ' ').replace(/^./, l => l.toUpperCase());
const selectClass = 'block min-h-11 w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-base';

export function CreateEventPage() {
  const me = useMe(); const navigate = useNavigate(); const qc = useQueryClient(); const keys = useRef(createRetryKey());
  const profile = me.data?.profile;
  const [prompt, setPrompt] = useState(''); const [drafting, setDrafting] = useState(false); const [draft, setDraft] = useState<EventDraft | null>(null);
  const [title, setTitle] = useState(''); const [purpose, setPurpose] = useState('');
  const [startsAt, setStartsAt] = useState(''); const [endsAt, setEndsAt] = useState('');
  const [areaLabel, setAreaLabel] = useState<string | null>(null); const [placeText, setPlaceText] = useState('');
  const [pin, setPin] = useState<LatLng | null>(null); const [focusKey, setFocusKey] = useState('saved');
  const [privateNote, setPrivateNote] = useState('');
  const [needs, setNeeds] = useState<NeedRow[]>([]); const [slots, setSlots] = useState<SlotRow[]>([]);
  const [review, setReview] = useState<CreateEventBody | null>(null); const [error, setError] = useState<string | null>(null); const [saving, setSaving] = useState(false);
  if (me.isPending) return <Skeleton cards={2} />;
  const location = pin ?? profile?.homeLocation ?? null; const area = areaLabel ?? profile?.areaLabel ?? '';

  async function runDraft() {
    setError(null); setDrafting(true);
    try {
      const { draft: next } = await draftEvent(prompt);
      setDraft(next);
      if (!title.trim() && next.title) setTitle(next.title);
      if (!purpose.trim() && next.purpose) setPurpose(next.purpose);
    } catch (e) { setError(e instanceof Error ? e.message : 'AI drafting failed. Fill in the form yourself.'); } finally { setDrafting(false); }
  }
  function prepare() {
    setError(null);
    const start = fromLocalInput(startsAt);
    if (!start || Date.parse(start) <= Date.now()) return setError('Choose a start date and time in the future.');
    if (!location) return setError('Choose the event location on the map, or set your location in Profile.');
    const confirmedNeeds = needs.map(n => ({ title: n.title.trim(), category: n.category, quantity: Number(n.quantity) }));
    if (confirmedNeeds.some(n => n.title.length < 2 || !Number.isInteger(n.quantity) || n.quantity < 1)) return setError('Each confirmed need needs a name and a whole-number quantity.');
    const confirmedSlots = slots.map(s => ({ title: s.title.trim(), capacity: Number(s.capacity) }));
    if (confirmedSlots.some(s => s.title.length < 2 || !Number.isInteger(s.capacity) || s.capacity < 1)) return setError('Each volunteer slot needs a name and how many people.');
    if (!confirmedNeeds.length && !confirmedSlots.length) return setError('Add at least one confirmed need or volunteer slot.');
    if (title.trim().length < 3 || purpose.trim().length < 10) return setError('Add a title and a purpose of at least 10 characters.');
    if (area.trim().length < 2) return setError('Add a public area such as a neighbourhood name.');
    setReview({ title: title.trim(), purpose: purpose.trim(), startsAt: start, endsAt: fromLocalInput(endsAt), areaLabel: area.trim(), location, privateNote: privateNote.trim(), needs: confirmedNeeds, slots: confirmedSlots });
  }
  async function confirm() {
    if (!review) return;
    setSaving(true); setError(null);
    try {
      const created = await createEvent(review, keys.current.forPayload(review));
      await qc.invalidateQueries({ queryKey: ['events'] });
      navigate(`/events/${created.id}`, { replace: true });
    } catch (e) { setError(e instanceof ApiError && e.details?.length ? `${e.message}: ${e.details.map(d => d.message).join(', ')}` : e instanceof Error ? e.message : 'Could not create the event.'); } finally { setSaving(false); }
  }

  if (review) return <div className="space-y-5">
    <PageHeading title="Review your event">Nothing is published until you press Create event.</PageHeading>
    {error && <Alert tone="error">{error}</Alert>}
    <Card className="space-y-3">
      <h2 className="break-words text-xl font-bold">{review.title}</h2>
      <p className="whitespace-pre-wrap break-words text-sm">{review.purpose}</p>
      <p className="text-sm"><span className="font-semibold">Starts:</span> {formatLocalDateTime(review.startsAt)}{review.endsAt ? ` · ends ${formatLocalDateTime(review.endsAt)}` : ''}</p>
      <p className="text-sm"><span className="font-semibold">Public area:</span> {review.areaLabel}. The exact point{review.privateNote ? ' and drop-off note' : ''} are shown only to you and contributors you accept.</p>
      {review.needs.length > 0 && <div><h3 className="font-semibold">Confirmed needs</h3><ul className="list-disc pl-5 text-sm">{review.needs.map((n, i) => <li key={i}>{n.quantity} × {n.title} ({label(n.category)})</li>)}</ul></div>}
      {review.slots.length > 0 && <div><h3 className="font-semibold">Volunteer slots</h3><ul className="list-disc pl-5 text-sm">{review.slots.map((s, i) => <li key={i}>{s.title}: {s.capacity} {s.capacity === 1 ? 'person' : 'people'}</li>)}</ul></div>}
      <p className="text-xs text-stone-600">No money, payments, tax receipts or deliveries are handled. Contributors bring goods or time themselves.</p>
    </Card>
    <div className="flex flex-wrap gap-2"><Button disabled={saving} onClick={() => void confirm()}>{saving ? 'Creating…' : 'Create event'}</Button><Button variant="ghost" disabled={saving} onClick={() => setReview(null)}>Back to edit</Button></div>
  </div>;

  return <div className="space-y-5">
    <PageHeading title="Organise a charity event">Ask neighbours for goods and volunteer time. No money is collected.</PageHeading>
    {error && <Alert tone="error">{error}</Alert>}
    <Card className="space-y-3">
      <h2 className="font-semibold">Draft with AI (optional)</h2>
      <label className="block text-sm font-medium" htmlFor="event-prompt">Describe your event in your own words</label>
      <textarea id="event-prompt" rows={3} maxLength={2000} value={prompt} onChange={e => setPrompt(e.target.value)} className="block w-full rounded-xl border border-stone-300 p-3 text-base" placeholder="e.g. Back-to-school drive on Saturday morning at the RT hall. We need 40 notebooks and some helpers to sort donations." />
      <Button variant="secondary" disabled={drafting || prompt.trim().length < 10} onClick={() => void runDraft()}>{drafting ? 'Drafting…' : 'Draft with AI'}</Button>
      <p className="text-xs text-stone-600">The AI only suggests. You choose what to keep, and you confirm everything before the event is created.</p>
      {draft && <div className="space-y-3 border-t border-stone-200 pt-3" aria-label="AI suggestions">
        {draft.startsAtText && <Alert>You mentioned “{draft.startsAtText}”. Set the exact start time below.</Alert>}
        {draft.outOfScope.length > 0 && <Alert tone="warning">Not handled here: {draft.outOfScope.join('; ')}</Alert>}
        {draft.suggestedSupplies.length > 0 && <div><h3 className="text-sm font-semibold">Suggested supply checklist — not added yet</h3><ul className="mt-2 space-y-2">{draft.suggestedSupplies.map((s, i) => <li key={i} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-stone-300 p-2 text-sm">
          <span className="min-w-0"><span className="font-medium">{s.title}</span>{s.quantity ? ` · ${s.quantity}` : ''} <span className={`ml-1 rounded-full px-2 py-0.5 text-xs ${s.statedByOrganizer ? 'bg-brand-50 text-brand-800' : 'bg-violet-50 text-violet-900'}`}>{s.statedByOrganizer ? 'You mentioned' : 'AI idea'}</span>{s.reason && <span className="block text-xs text-stone-600">{s.reason}</span>}</span>
          <Button variant="ghost" onClick={() => { setNeeds(old => [...old, { title: s.title, category: s.category, quantity: s.quantity ? String(s.quantity) : '' }]); setDraft(d => d && { ...d, suggestedSupplies: d.suggestedSupplies.filter((_, j) => j !== i) }); }}>Add to needs</Button></li>)}</ul></div>}
        {draft.suggestedSlots.length > 0 && <div><h3 className="text-sm font-semibold">Suggested volunteer roles — not added yet</h3><ul className="mt-2 space-y-2">{draft.suggestedSlots.map((s, i) => <li key={i} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-stone-300 p-2 text-sm">
          <span><span className="font-medium">{s.title}</span>{s.capacity ? ` · ${s.capacity} people` : ''} <span className={`ml-1 rounded-full px-2 py-0.5 text-xs ${s.statedByOrganizer ? 'bg-brand-50 text-brand-800' : 'bg-violet-50 text-violet-900'}`}>{s.statedByOrganizer ? 'You mentioned' : 'AI idea'}</span></span>
          <Button variant="ghost" onClick={() => { setSlots(old => [...old, { title: s.title, capacity: s.capacity ? String(s.capacity) : '' }]); setDraft(d => d && { ...d, suggestedSlots: d.suggestedSlots.filter((_, j) => j !== i) }); }}>Add slot</Button></li>)}</ul></div>}
      </div>}
    </Card>

    <Card className="space-y-3">
      <h2 className="font-semibold">Event details</h2>
      <TextField label="Title *" maxLength={100} value={title} onChange={e => setTitle(e.target.value)} />
      <div><label className="block text-sm font-medium text-stone-800" htmlFor="event-purpose">Purpose *</label><textarea id="event-purpose" rows={3} maxLength={2000} value={purpose} onChange={e => setPurpose(e.target.value)} className="mt-1 block w-full rounded-xl border border-stone-300 p-3 text-base" /></div>
      <div className="grid gap-3 sm:grid-cols-2"><TextField label="Starts (your local time) *" type="datetime-local" value={startsAt} onChange={e => setStartsAt(e.target.value)} /><TextField label="Ends, optional" type="datetime-local" value={endsAt} onChange={e => setEndsAt(e.target.value)} /></div>
    </Card>

    <Card className="space-y-3">
      <h2 className="font-semibold">Where</h2>
      <TextField label="Public area shown to neighbours *" maxLength={120} value={area} onChange={e => setAreaLabel(e.target.value)} hint="A neighbourhood or city name, never a street address." />
      <PlaceSearchField value={placeText} lang={profile?.preferredLanguage ?? 'en'} onTextChange={setPlaceText} onSelect={place => { setPin(place.location); setAreaLabel(place.name); setPlaceText(place.name); setFocusKey(`place:${place.id}`); }} />
      {location ? <Suspense fallback={<div role="status" className="h-56 animate-pulse rounded-xl bg-stone-100" />}><LocationPickerMap pin={location} zoom={15} focusKey={focusKey} onPinChange={setPin} /></Suspense>
        : <Alert>Search for a place or <Link className="font-semibold underline" to="/profile">set your location in Profile</Link> to place the event pin.</Alert>}
      <p className="text-xs text-stone-600">{pin ? 'Using the pin you placed.' : 'Using your saved Profile location.'} The exact pin stays private.</p>
      <div><label className="block text-sm font-medium text-stone-800" htmlFor="event-note">Private drop-off note</label><textarea id="event-note" rows={2} maxLength={1000} value={privateNote} onChange={e => setPrivateNote(e.target.value)} className="mt-1 block w-full rounded-xl border border-stone-300 p-3 text-base" placeholder="Shown only to contributors you accept, e.g. hall entrance" /></div>
    </Card>

    <Card className="space-y-3">
      <h2 className="font-semibold">Confirmed needs</h2>
      {needs.length === 0 && <p className="text-sm text-stone-600">No goods requested yet.</p>}
      {needs.map((n, i) => <div key={i} className="grid grid-cols-[1fr_auto] gap-2 rounded-xl border border-stone-200 p-2" aria-label={`Need ${i + 1}`}>
        <TextField label="Item" maxLength={100} value={n.title} onChange={e => setNeeds(rows => rows.map((r, j) => j === i ? { ...r, title: e.target.value } : r))} />
        <TextField label="Quantity" type="number" min={1} max={10000} value={n.quantity} onChange={e => setNeeds(rows => rows.map((r, j) => j === i ? { ...r, quantity: e.target.value } : r))} />
        <label className="text-sm">Category<select className={selectClass} value={n.category} onChange={e => setNeeds(rows => rows.map((r, j) => j === i ? { ...r, category: e.target.value as ItemCategory } : r))}>{ITEM_CATEGORIES.map(c => <option key={c} value={c}>{label(c)}</option>)}</select></label>
        <Button variant="ghost" className="self-end" onClick={() => setNeeds(rows => rows.filter((_, j) => j !== i))}>Remove</Button>
      </div>)}
      <Button variant="secondary" onClick={() => setNeeds(rows => [...rows, { title: '', category: 'groceries', quantity: '' }])}>Add need</Button>
    </Card>

    <Card className="space-y-3">
      <h2 className="font-semibold">Volunteer slots</h2>
      {slots.length === 0 && <p className="text-sm text-stone-600">No volunteer roles yet.</p>}
      {slots.map((s, i) => <div key={i} className="grid grid-cols-[1fr_auto] items-end gap-2 rounded-xl border border-stone-200 p-2" aria-label={`Slot ${i + 1}`}>
        <TextField label="Role" maxLength={100} value={s.title} onChange={e => setSlots(rows => rows.map((r, j) => j === i ? { ...r, title: e.target.value } : r))} />
        <TextField label="People" type="number" min={1} max={500} value={s.capacity} onChange={e => setSlots(rows => rows.map((r, j) => j === i ? { ...r, capacity: e.target.value } : r))} />
        <Button variant="ghost" onClick={() => setSlots(rows => rows.filter((_, j) => j !== i))}>Remove</Button>
      </div>)}
      <Button variant="secondary" onClick={() => setSlots(rows => [...rows, { title: '', capacity: '' }])}>Add volunteer slot</Button>
    </Card>
    <div className="flex flex-wrap gap-2"><Button onClick={prepare}>Review event</Button><Button variant="ghost" onClick={() => navigate('/events')}>Cancel</Button></div>
  </div>;
}
