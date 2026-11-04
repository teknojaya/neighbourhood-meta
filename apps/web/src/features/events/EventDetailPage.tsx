import { useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CharityEventDetail } from '@neighbourhood/shared';
import { Alert, Button, Card, Skeleton, TextField } from '../../components/ui';
import { useOnline } from '../../lib/useOnline';
import { createRetryKey } from '../activity/retry-key';
import { PublicArea } from '../listings/ListingCard';
import { formatLocalDateTime } from '../listings/FoodRescue';
import { cancelEvent, fetchEvent, movePledge, moveSignup, pledge, signup } from './eventsApi';

const pledgeLabel = { pledged: 'Pledged — awaiting organizer', accepted: 'Accepted — bring it to the event', received: 'Received by organizer', cancelled: 'Cancelled' } as const;
const signupLabel = { pending: 'Awaiting organizer', accepted: 'Accepted', cancelled: 'Cancelled' } as const;
const actionLabel = { accepted: 'Accept', received: 'Mark received', cancelled: 'Cancel' } as const;
type Pending = { kind: 'pledge'; needId: string; title: string; quantity: number; note: string } | { kind: 'signup'; slotId: string; title: string } | { kind: 'cancel' };

export function EventDetailPage() {
  const { id } = useParams<{ id: string }>(); const navigate = useNavigate(); const qc = useQueryClient(); const online = useOnline(); const keys = useRef(createRetryKey());
  const detail = useQuery({ queryKey: ['events', 'detail', id], queryFn: ({ signal }) => fetchEvent(id!, signal), enabled: Boolean(id) });
  const [form, setForm] = useState<{ needId: string; quantity: string; note: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const done = (data: CharityEventDetail) => { keys.current.clear(); setPending(null); setForm(null); qc.setQueryData(['events', 'detail', id], data); void qc.invalidateQueries({ queryKey: ['events'] }); };
  const commit = useMutation({ mutationFn: (p: Pending) => {
    const key = keys.current.forPayload(p);
    return p.kind === 'pledge' ? pledge(id!, { needId: p.needId, quantity: p.quantity, note: p.note }, key) : p.kind === 'signup' ? signup(id!, p.slotId, key) : cancelEvent(id!, key);
  }, onSuccess: done });
  const move = useMutation({ mutationFn: (m: { type: 'pledge' | 'signup'; id: string; to: 'accepted' | 'received' | 'cancelled' }) => m.type === 'pledge' ? movePledge(m.id, m.to, keys.current.forPayload(m)) : moveSignup(m.id, m.to as 'accepted' | 'cancelled', keys.current.forPayload(m)), onSuccess: done });

  if (detail.isPending) return <Skeleton cards={3} />;
  if (detail.isError) return <div className="space-y-3"><Alert tone="error">Couldn’t load this event.</Alert><Button variant="secondary" onClick={() => navigate('/events')}>Back to events</Button></div>;
  const e = detail.data; const open = e.status === 'published' && Date.parse(e.startsAt) > Date.now(); const busy = commit.isPending || move.isPending || !online;
  const error = commit.error ?? move.error;

  return <div className="space-y-5">
    <Button variant="ghost" onClick={() => navigate('/events')}>Back</Button>
    <div className="space-y-2">
      <span className={`inline-block rounded-full px-3 py-1 text-sm font-semibold ${e.status === 'cancelled' ? 'bg-stone-200 text-stone-700' : 'bg-brand-50 text-brand-800'}`}>{e.status === 'cancelled' ? 'Cancelled' : open ? 'Charity event' : 'Started'}</span>
      <h1 className="break-words text-3xl font-bold tracking-tight">{e.title}</h1>
      <p className="text-sm text-stone-600"><time dateTime={e.startsAt}>{formatLocalDateTime(e.startsAt)}</time>{e.endsAt ? ` – ${formatLocalDateTime(e.endsAt)}` : ''}</p>
      <p className="text-sm text-stone-600"><PublicArea {...e.location} /> · organised by {e.isOrganizer ? 'you' : e.organizerName}</p>
      <p className="whitespace-pre-wrap break-words leading-relaxed">{e.purpose}</p>
    </div>
    {e.status === 'cancelled' && <Alert>This event was cancelled. Open pledges and sign-ups were cancelled.</Alert>}
    {error && <Alert tone="error">{error.message}</Alert>}

    {e.privateLocation ? <Card className="space-y-1"><h2 className="font-semibold">Private drop-off details</h2>
      <p className="whitespace-pre-wrap text-sm">{e.privateLocation.note || 'No drop-off note added.'}</p>
      <a className="inline-flex min-h-11 items-center text-sm font-semibold text-brand-800 underline" target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${e.privateLocation.exactLocation.lat}&mlon=${e.privateLocation.exactLocation.lng}#map=18/${e.privateLocation.exactLocation.lat}/${e.privateLocation.exactLocation.lng}`}>Open exact point in map</a>
      <p className="text-xs text-stone-600">{e.isOrganizer ? 'Shown to contributors after you accept them.' : 'Shared with you because the organizer accepted your contribution.'}</p></Card>
      : !e.isOrganizer && <p className="text-sm text-stone-600">The exact drop-off point is shared once the organizer accepts your pledge or sign-up.</p>}

    {e.needs.length > 0 && <section className="space-y-2"><h2 className="text-lg font-semibold">Goods needed</h2>
      {e.needs.map(n => { const left = n.quantity - n.pledged; return <Card key={n.id} className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2"><p className="font-semibold">{n.title}</p><p className="text-sm">{n.pledged} of {n.quantity} pledged · {n.received} received</p></div>
        <div className="h-2 overflow-hidden rounded-full bg-stone-100" aria-hidden="true"><div className="h-full bg-brand-700" style={{ width: `${Math.min(100, (n.pledged / n.quantity) * 100)}%` }} /></div>
        {!e.isOrganizer && open && left > 0 && (form?.needId === n.id
          ? <div className="space-y-2"><TextField label={`How many? (up to ${left})`} type="number" min={1} max={left} value={form.quantity} onChange={ev => setForm({ ...form, quantity: ev.target.value })} /><TextField label="Note for the organizer, optional" maxLength={300} value={form.note} onChange={ev => setForm({ ...form, note: ev.target.value })} />
            <div className="flex gap-2"><Button disabled={!(Number(form.quantity) >= 1 && Number(form.quantity) <= left && Number.isInteger(Number(form.quantity)))} onClick={() => setPending({ kind: 'pledge', needId: n.id, title: n.title, quantity: Number(form.quantity), note: form.note.trim() })}>Review pledge</Button><Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button></div></div>
          : <Button variant="secondary" onClick={() => setForm({ needId: n.id, quantity: '1', note: '' })}>Pledge {n.title}</Button>)}
        {left <= 0 && <p className="text-sm text-stone-600">Fully pledged.</p>}
      </Card>; })}
    </section>}

    {e.slots.length > 0 && <section className="space-y-2"><h2 className="text-lg font-semibold">Volunteers</h2>
      {e.slots.map(s => { const mine = e.signups.some(x => x.mine && x.slotId === s.id && x.status !== 'cancelled'); return <Card key={s.id} className="flex flex-wrap items-center justify-between gap-2">
        <div><p className="font-semibold">{s.title}</p><p className="text-sm">{s.taken} of {s.capacity} places taken · {s.accepted} accepted</p></div>
        {!e.isOrganizer && open && !mine && s.taken < s.capacity && <Button variant="secondary" onClick={() => setPending({ kind: 'signup', slotId: s.id, title: s.title })}>Volunteer</Button>}
        {mine && <span className="text-sm font-medium text-brand-800">You signed up</span>}
      </Card>; })}
    </section>}

    {pending && <Card className="space-y-3 border-2 border-brand-700" aria-label="Confirm action">
      <h2 className="font-semibold">{pending.kind === 'cancel' ? 'Cancel this event?' : 'Review before confirming'}</h2>
      <p className="text-sm">{pending.kind === 'pledge' ? `You promise to bring ${pending.quantity} × ${pending.title}. The organizer accepts it, then marks it received when it arrives — a pledge alone is not proof of delivery.`
        : pending.kind === 'signup' ? `You offer to help with “${pending.title}”. The organizer reviews sign-ups.`
        : 'Open pledges and volunteer sign-ups will be cancelled and contributors notified. Goods already received stay recorded. This cannot be undone.'}</p>
      {pending.kind === 'pledge' && pending.note && <p className="text-sm text-stone-600">Note: {pending.note}</p>}
      <div className="flex gap-2"><Button disabled={busy} onClick={() => commit.mutate(pending)}>{commit.isPending ? 'Saving…' : pending.kind === 'cancel' ? 'Yes, cancel event' : 'Confirm'}</Button><Button variant="ghost" disabled={commit.isPending} onClick={() => setPending(null)}>Back</Button></div>
    </Card>}

    {(e.pledges.length > 0 || e.signups.length > 0) && <section className="space-y-2"><h2 className="text-lg font-semibold">{e.isOrganizer ? 'Contributions' : 'Your contributions'}</h2>
      {e.pledges.map(p => <Card key={p.id} className="space-y-2"><p className="text-sm"><span className="font-semibold">{p.quantity} × {p.needTitle}</span>{p.contributorName ? ` · ${p.contributorName}` : ''}</p><p className="text-sm text-stone-600">{pledgeLabel[p.status]}{p.note ? ` · “${p.note}”` : ''}</p>
        {p.allowedActions.length > 0 && <div className="flex flex-wrap gap-2">{p.allowedActions.map(to => <Button key={to} variant={to === 'cancelled' ? 'ghost' : 'secondary'} disabled={busy} onClick={() => move.mutate({ type: 'pledge', id: p.id, to })}>{actionLabel[to]}</Button>)}</div>}</Card>)}
      {e.signups.map(s => <Card key={s.id} className="space-y-2"><p className="text-sm"><span className="font-semibold">{s.slotTitle}</span>{s.contributorName ? ` · ${s.contributorName}` : ''}</p><p className="text-sm text-stone-600">Volunteer: {signupLabel[s.status]}</p>
        {s.allowedActions.length > 0 && <div className="flex flex-wrap gap-2">{s.allowedActions.map(to => <Button key={to} variant={to === 'cancelled' ? 'ghost' : 'secondary'} disabled={busy} onClick={() => move.mutate({ type: 'signup', id: s.id, to })}>{to === 'accepted' ? 'Accept' : 'Cancel'}</Button>)}</div>}</Card>)}
    </section>}

    {e.isOrganizer && e.status === 'published' && !pending && <Button variant="ghost" onClick={() => setPending({ kind: 'cancel' })}>Cancel event</Button>}
  </div>;
}
