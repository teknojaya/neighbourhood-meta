import { useEffect, useRef, useState } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { LatLng } from '@neighbourhood/shared';
import { Alert, Button } from '../../components/ui';

const PIN = '<svg viewBox="0 0 40 48" aria-hidden="true"><path d="M20 2C10 2 2 10 2 20c0 12 18 26 18 26s18-14 18-26C38 10 30 2 20 2Z" fill="currentColor" stroke="white" stroke-width="2.5"/><circle cx="20" cy="19" r="6" fill="white"/></svg>';

/**
 * Adjustable pin for the private pickup/search point. `focusKey` changes when a
 * new place or device location is chosen, which recentres the map on the pin;
 * dragging the pin never recentres it.
 */
export default function LocationPickerMap({ pin, zoom, focusKey, onPinChange }: { pin: LatLng; zoom: number; focusKey: string; onPinChange(point: LatLng): void }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null), marker = useRef<L.Marker | null>(null);
  const change = useRef(onPinChange); change.current = onPinChange;
  const [tiles, setTiles] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);
  const round = (p: L.LatLng) => ({ lat: Math.round(p.lat * 1e6) / 1e6, lng: Math.round(p.lng * 1e6) / 1e6 });

  useEffect(() => {
    if (!container.current) return;
    setTiles('loading');
    const instance = L.map(container.current, { center: [pin.lat, pin.lng], zoom, scrollWheelZoom: false, attributionControl: true });
    map.current = instance;
    const m = L.marker([pin.lat, pin.lng], { draggable: true, keyboard: true, autoPan: true, title: 'Your pickup / search pin. Drag to adjust.', alt: 'Pickup / search pin',
      icon: L.divIcon({ className: 'product-map-pin', html: PIN, iconSize: [36, 44], iconAnchor: [18, 42] }) }).addTo(instance);
    marker.current = m;
    m.on('dragend', () => change.current(round(m.getLatLng())));
    instance.on('click', (event: L.LeafletMouseEvent) => { m.setLatLng(event.latlng); change.current(round(event.latlng)); });
    let loaded = 0, failed = 0, disposed = false;
    const layer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, minZoom: 3, updateWhenIdle: true, keepBuffer: 0, referrerPolicy: 'strict-origin-when-cross-origin',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' });
    layer.on('tileload', () => { loaded++; }); layer.on('tileerror', () => { failed++; });
    layer.on('load', () => { if (!disposed) setTiles(loaded > 0 && failed === 0 ? 'ready' : 'failed'); });
    layer.addTo(instance);
    const timeout = window.setTimeout(() => { if (!disposed && loaded === 0) setTiles('failed'); }, 12000);
    const observer = new ResizeObserver(() => instance.invalidateSize()); observer.observe(container.current);
    return () => { disposed = true; window.clearTimeout(timeout); observer.disconnect(); map.current = null; marker.current = null; instance.remove(); };
    // The map is built once per attempt; pin and zoom updates are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  useEffect(() => { marker.current?.setLatLng([pin.lat, pin.lng]); }, [pin.lat, pin.lng]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { map.current?.setView([pin.lat, pin.lng], zoom, { animate: false }); }, [focusKey, attempt]);

  return <div className="overflow-hidden rounded-xl border border-stone-200">
    {tiles === 'failed' && <div className="p-2"><Alert tone="warning">Map tiles couldn’t load. You can still adjust the pin under Advanced. <Button type="button" variant="ghost" onClick={() => setAttempt(attempt + 1)}>Retry map</Button></Alert></div>}
    <div className="relative isolate">
      <div ref={container} className="search-map h-56 w-full bg-stone-100 sm:h-64" role="region" tabIndex={0} aria-label="Map for your pickup / search pin. Use arrow keys to pan, then choose Move pin to map centre." />
      {tiles === 'loading' && <div role="status" aria-label="Loading map tiles" className="pointer-events-none absolute inset-0 z-[1000] flex animate-pulse items-center justify-center bg-stone-100 text-sm text-stone-600">Loading map…</div>}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
      <p className="text-xs text-stone-600">Drag the pin or tap the map.</p>
      <Button type="button" variant="ghost" onClick={() => { const centre = map.current?.getCenter(); if (centre) { marker.current?.setLatLng(centre); change.current(round(centre)); } }}>Move pin to map centre</Button>
    </div>
  </div>;
}
