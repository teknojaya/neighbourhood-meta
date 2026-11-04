import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { CharityEventSummary } from '@neighbourhood/shared';
import { useMe } from '../../auth/useMe';
import { Alert, Card, PageHeading, Skeleton } from '../../components/ui';
import { PublicArea } from '../listings/ListingCard';
import { formatLocalDateTime } from '../listings/FoodRescue';
import { fetchMyEvents, fetchNearbyEvents } from './eventsApi';

export function EventCard({ event }: { event: CharityEventSummary }) {
  const goods = event.needs.reduce((n, need) => n + Math.max(0, need.quantity - need.pledged), 0);
  const places = event.slots.reduce((n, slot) => n + Math.max(0, slot.capacity - slot.taken), 0);
  return <Link to={`/events/${event.id}`} className="block rounded-2xl border border-stone-200 bg-white p-4">
    <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">{event.status === 'cancelled' ? <span className="rounded-full bg-stone-200 px-2 py-0.5 text-stone-700">Cancelled</span> : <span className="rounded-full bg-brand-50 px-2 py-0.5 text-brand-800">Charity event</span>}{event.isOrganizer && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-900">You organise</span>}</div>
    <h3 className="mt-2 break-words text-base font-semibold">{event.title}</h3>
    <p className="text-sm text-stone-600"><time dateTime={event.startsAt}>{formatLocalDateTime(event.startsAt)}</time> · <PublicArea {...event.location} /></p>
    <p className="mt-1 text-sm">{goods > 0 ? `${goods} items still needed` : event.needs.length ? 'All goods pledged' : ''}{goods > 0 && places > 0 ? ' · ' : ''}{places > 0 ? `${places} volunteer places open` : ''}</p>
  </Link>;
}

export function EventsPage() {
  const me = useMe(); const home = me.data?.profile?.homeLocation; const radiusKm = me.data?.profile?.searchRadiusKm ?? 3;
  const nearby = useQuery({ queryKey: ['events', 'nearby', home, radiusKm], enabled: Boolean(home), queryFn: ({ signal }) => fetchNearbyEvents({ ...home!, radiusKm }, signal) });
  const mine = useQuery({ queryKey: ['events', 'mine'], queryFn: ({ signal }) => fetchMyEvents(signal) });
  return <div className="space-y-6">
    <PageHeading title="Charity events" action={<Link to="/events/new" className="inline-flex min-h-11 items-center rounded-xl bg-brand-700 px-4 text-sm font-semibold text-white">Organise</Link>}>Neighbours pledge goods or volunteer time. No money is collected here.</PageHeading>
    <section className="space-y-3"><h2 className="text-lg font-semibold">Your events and contributions</h2>
      {mine.isPending ? <Skeleton cards={1} /> : mine.isError ? <Alert tone="error">Couldn’t load your events.</Alert> : mine.data.items.length ? mine.data.items.map(e => <EventCard key={e.id} event={e} />) : <p className="text-sm text-stone-600">You haven’t organised or joined an event yet.</p>}
    </section>
    <section className="space-y-3"><h2 className="text-lg font-semibold">Upcoming near you{home ? ` (within ${radiusKm} km)` : ''}</h2>
      {!home ? <Card><p className="text-sm">Set your location in <Link className="font-semibold underline" to="/profile">Profile</Link> to see events nearby.</p></Card>
        : nearby.isPending ? <Skeleton cards={2} /> : nearby.isError ? <Alert tone="error">Couldn’t load nearby events.</Alert>
        : nearby.data.items.length ? nearby.data.items.map(e => <EventCard key={e.id} event={e} />) : <p className="text-sm text-stone-600">No upcoming events within {radiusKm} km right now.</p>}
    </section>
  </div>;
}
