import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { ListingPublicSchema } from '@neighbourhood/shared';
import { useMe } from '../../auth/useMe';
import { Alert, Button, Card, LocationRequired, ModeTabs, pillActionClass, Skeleton } from '../../components/ui';
import { ArrowIcon, BookmarkIcon, PinIcon, PlusIcon, SparkIcon } from '../../components/icons';
import { api } from '../../lib/api';
import { ListingCard } from '../listings/ListingCard';
import { CategoryFilter } from '../listings/CategoryFilter';
export function HomePage() {
  const me = useMe(); const [mode, setMode] = useState(''); const [category, setCategory] = useState(''); const location = me.data?.profile.homeLocation; const radius = me.data?.profile.searchRadiusKm ?? 3;
  const exploreParams = new URLSearchParams(); if (mode) exploreParams.set('mode', mode); if (category) exploreParams.set('category', category);
  const items = useQuery({ queryKey: ['home-items', location, radius, mode, category], enabled: Boolean(location), queryFn: ({ signal }) => {
    const q = new URLSearchParams({ lat: String(location!.lat), lng: String(location!.lng), radiusKm: String(radius), limit: '8' }); if (mode) q.set('mode', mode); if (category) q.set('category', category);
    return api('/api/v1/listings?' + q, { schema: z.object({ items: z.array(ListingPublicSchema), total: z.number() }), signal });
  } });
  return <div className="discovery-page space-y-5">
    <div className="flex items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-2 text-sm text-stone-600"><PinIcon /><p className="min-w-0 break-words"><span className="font-semibold text-stone-900">{me.data?.profile.areaLabel || 'Your neighbourhood'}</span><span className="block text-xs">Within {radius} km</span></p></div><Link to="/profile" className="inline-flex min-h-11 items-center text-sm font-semibold text-brand-800 underline">Change area</Link></div>
    <div className="grid gap-3 sm:grid-cols-[1fr_auto]"><Link to="/needs" className="flex items-center gap-3 rounded-2xl bg-brand-700 p-4 text-white hover:bg-brand-800"><SparkIcon /><div className="min-w-0 flex-1"><h1 className="text-lg font-semibold">What do you need?</h1><p className="text-sm text-brand-50">Ask to find, borrow or share nearby.</p></div><ArrowIcon /></Link><Link to="/share" className="flex min-h-14 items-center justify-center gap-2 rounded-xl border border-brand-700 bg-white px-5 py-3 font-semibold text-brand-800 hover:bg-brand-50"><PlusIcon />Donate / Share</Link></div>
    <div className="flex flex-wrap gap-2" aria-label="Neighbourhood shortcuts"><Link className={pillActionClass} to="/communities"><PinIcon />Community points</Link><Link className={pillActionClass} to="/needs/saved"><BookmarkIcon />Saved needs</Link><Link className={pillActionClass} to="/events"><PlusIcon />Charity events</Link></div>
    <section className="space-y-3" aria-label="Nearby items"><div className="flex items-center justify-between"><h2 className="text-xl font-bold tracking-tight">Nearby items</h2><Link to={`/explore${exploreParams.size ? '?' + exploreParams : ''}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-brand-800 underline">View all</Link></div><div className="max-w-lg"><ModeTabs value={mode} onChange={setMode} /></div><CategoryFilter value={category} onChange={setCategory} />
      {me.isPending || (location && items.isPending) ? <Skeleton grid cards={4} /> : me.data && !location ? <LocationRequired /> : null}{me.isError && <Alert tone="error">Couldn’t load your profile. <Button variant="ghost" onClick={() => void me.refetch()}>Try again</Button></Alert>}{items.isError && <Alert tone="error">Couldn’t load nearby items. <Button variant="ghost" onClick={() => void items.refetch()}>Try again</Button></Alert>}
      {items.data?.items.length === 0 && <Card className="space-y-3"><h3 className="font-semibold">Nothing shared here yet</h3><p className="text-sm text-stone-600">Try a wider area in Explore, save what you need in Ask, or be the first to share.</p><Link to="/share" className="inline-flex min-h-11 items-center font-semibold text-brand-800 underline">Donate / Share an item</Link></Card>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">{items.data?.items.map(item => <ListingCard key={item.id} item={item} />)}</div>
    </section>
  </div>;
}
