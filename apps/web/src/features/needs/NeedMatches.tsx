import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import { NeedMatchesSchema } from '@neighbourhood/shared';
import { api } from '../../lib/api';
import { Alert, Button, Skeleton } from '../../components/ui';
import { featureError } from '../activity/feature-errors';

type NeedMatchesResult = z.infer<typeof NeedMatchesSchema>;
type Match = NeedMatchesResult['items'][number];

/** Facts read from the listing itself, never from the AI explanation. */
function verifiedFacts({ listing }: Match) {
  const available = listing.stock.total - listing.stock.reserved - listing.stock.collected;
  return [listing.condition.replaceAll('_', ' '), listing.mode === 'donate' ? `${available} available` : 'Borrow & return · choose dates',
    listing.location.distanceKm !== undefined ? `about ${listing.location.distanceKm} km` : listing.location.areaLabel].join(' · ');
}

/** Older Ask cards have no recorded source, so their notes get a neutral label. */
export function MatchList({ items, explanationSource }: { items: Match[]; explanationSource?: NeedMatchesResult['explanationSource'] }) {
  const ai = explanationSource === 'model';
  return <div className="space-y-1">
    {explanationSource === 'filters' && items.length > 0 && <p className="text-xs text-stone-600">Found by item name, category and distance. These results are not ranked or explained by AI.</p>}
    {items.map(item => <Link key={item.listing.id} to={'/listings/' + item.listing.id} className="block space-y-1 border-t py-3">
      <strong>{item.listing.title}</strong>
      <p className="text-sm text-stone-700">{verifiedFacts(item)}</p>
      {explanationSource !== 'filters' ? <div className="rounded-lg bg-stone-50 p-2 text-sm">
        <p className="text-xs font-semibold text-stone-600">{ai ? `AI explanation · ${item.fit} fit · may be incomplete, check the listing` : 'Match note · source not recorded, check the listing'}</p>
        <p>{item.reason}</p>
        {item.missingInfo.length > 0 && <p className="text-xs text-stone-600">Not confirmed: {item.missingInfo.join('; ')}</p>}
      </div> : <p className="text-sm text-stone-600">{item.reason}</p>}
    </Link>)}
  </div>;
}

export function NeedMatches({ id }: { id: string }) {
  const [enabled, setEnabled] = useState(false);
  const matches = useQuery({ queryKey: ['need-matches', id], queryFn: () => api(`/api/v1/needs/${id}/matches`, { schema: NeedMatchesSchema }), enabled, retry: false });
  return <div className="space-y-3"><Button variant="secondary" onClick={() => { setEnabled(true); if (enabled) void matches.refetch(); }} disabled={matches.isFetching}>{matches.isFetching ? 'Finding matches…' : 'Find nearby matches'}</Button>
    {matches.isFetching && <Skeleton cards={1} />}
    {matches.isError && <Alert tone="error">{featureError(matches.error)}</Alert>}
    {!matches.isError && matches.data && (matches.data.items.length === 0 ? <p>No matching items nearby yet.</p> : <MatchList items={matches.data.items} explanationSource={matches.data.explanationSource} />)}
  </div>;
}
