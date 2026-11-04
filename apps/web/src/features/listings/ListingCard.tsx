import { useState } from 'react';
import { Link } from 'react-router';
import type { ListingPublic } from '@neighbourhood/shared';
import { BoxIcon } from '../../components/icons';
import { SaveItemButton } from './SaveItemButton';
import { CollectByBadge } from './FoodRescue';

export function PublicArea({ areaLabel, distanceKm }: { areaLabel: string; distanceKm?: number }) {
  return <span>{areaLabel || 'Nearby area'}{distanceKm !== undefined && <span> · {distanceKm < 0.1 ? '<0.1' : Number(distanceKm.toFixed(1))} km</span>}</span>;
}

export function ListingCard({ item }: { item: ListingPublic }) {
  const [broken, setBroken] = useState(false);
  const photo = item.photos[0]?.url;
  return <div className="relative min-w-0"><Link to={`/listings/${item.id}`} className="item-card block min-w-0 overflow-hidden rounded-2xl border border-stone-200 bg-white">
    {photo && !broken ? <img src={photo} alt={item.title} loading="lazy" onError={() => setBroken(true)} className="aspect-[4/3] w-full bg-stone-100 object-cover" /> : <div className="flex aspect-[4/3] flex-col items-center justify-center gap-2 bg-stone-100 text-stone-600"><BoxIcon /><span className="text-xs">No photo yet</span></div>}
    <div className="space-y-1.5 p-3"><span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${item.mode === 'donate' ? 'bg-brand-50 text-brand-800' : 'bg-amber-50 text-amber-900'}`}>{item.mode === 'donate' ? 'Free to keep' : 'Borrow & return'}</span>{item.food && <> <CollectByBadge food={item.food} /></>}<h3 className="break-words text-base font-semibold leading-snug">{item.title}</h3><p className="break-words text-sm leading-snug text-stone-600"><PublicArea {...item.location} /></p></div>
  </Link><div className="absolute right-2 top-2"><SaveItemButton id={item.id} title={item.title} compact /></div></div>;
}
