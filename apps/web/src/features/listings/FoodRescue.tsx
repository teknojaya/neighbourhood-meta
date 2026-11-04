import { useEffect, useState } from 'react';
import type { FoodRescuePublic } from '@neighbourhood/shared';

/** Local date/time in the viewer's own time zone, with the zone name so it is never ambiguous. */
export function formatLocalDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
}

export function countdownText(iso: string, now = Date.now()) {
  const ms = Date.parse(iso) - now;
  if (ms <= 0) return 'Collect-by time has passed';
  const minutes = Math.floor(ms / 60_000), days = Math.floor(minutes / 1440), h = Math.floor((minutes % 1440) / 60), m = minutes % 60;
  if (days > 0) return `${days} d ${h} h left`;
  if (h > 0) return `${h} h ${m} min left`;
  return minutes > 0 ? `${m} min left` : 'Less than a minute left';
}

/** datetime-local value (no zone) ↔ ISO instant, both in the browser's zone. */
export const toLocalInput = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso); const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fromLocalInput = (value: string) => (value ? new Date(value).toISOString() : null);

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), intervalMs); return () => window.clearInterval(timer); }, [intervalMs]);
  return now;
}

export function isFoodExpired(food: FoodRescuePublic | null | undefined, now = Date.now()) {
  return Boolean(food && (food.expired || Date.parse(food.collectBy) <= now));
}

export function CollectByBadge({ food }: { food: FoodRescuePublic }) {
  const now = useNow();
  const expired = isFoodExpired(food, now);
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${expired ? 'bg-stone-200 text-stone-700' : 'bg-orange-50 text-orange-900'}`}>
    {expired ? 'Food offer closed' : `Food rescue · ${countdownText(food.collectBy, now)}`}
  </span>;
}

const unknown = 'Unknown — ask the giver';
export function FoodRescueDetails({ food }: { food: FoodRescuePublic }) {
  const now = useNow();
  const expired = isFoodExpired(food, now);
  return <section aria-label="Food rescue details" className={`space-y-3 rounded-2xl border p-4 ${expired ? 'border-stone-300 bg-stone-50' : 'border-orange-200 bg-orange-50/60'}`}>
    <div>
      <p className="text-sm font-semibold text-stone-700">Collect by</p>
      <p className="text-lg font-bold"><time dateTime={food.collectBy}>{formatLocalDateTime(food.collectBy)}</time></p>
      <p role="status" className={`text-sm font-medium ${expired ? 'text-stone-700' : 'text-orange-900'}`}>{countdownText(food.collectBy, now)}</p>
    </div>
    <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
      <div><dt className="text-stone-600">Prepared</dt><dd className="font-medium">{food.preparedAt ? formatLocalDateTime(food.preparedAt) : unknown}</dd></div>
      <div><dt className="text-stone-600">Storage</dt><dd className="break-words font-medium">{food.storage ?? unknown}</dd></div>
      <div><dt className="text-stone-600">Allergens</dt><dd className="break-words font-medium">{food.allergens ?? unknown}</dd></div>
    </dl>
    <p className="text-xs text-stone-600">Details come from the giver and are not checked by NeighbourHood. Use your own judgement about freshness and allergens.</p>
  </section>;
}
