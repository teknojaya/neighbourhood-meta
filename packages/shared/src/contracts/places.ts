import { z } from 'zod';
import { LatLngSchema } from '../common.js';
import { UiLanguageSchema } from '../enums.js';
import { distanceKm } from '../geo.js';

/**
 * Place search for the public pickup/search area. Results are named areas
 * (neighbourhoods, cities, regions), never street addresses or buildings.
 */
export const PLACE_QUERY_MIN_LENGTH = 2;
export const PLACE_QUERY_MAX_LENGTH = 100;
export const PlaceQuerySchema = z.object({
  q: z.string().trim().min(PLACE_QUERY_MIN_LENGTH).max(PLACE_QUERY_MAX_LENGTH),
  lang: UiLanguageSchema.default('en'),
});

export const PlaceKindSchema = z.enum(['neighbourhood', 'city', 'region']);
export type PlaceKind = z.infer<typeof PlaceKindSchema>;

export const PlaceSuggestionSchema = z.object({
  id: z.string().min(1).max(200),
  kind: PlaceKindSchema,
  /** Becomes the public area label, for example "Tebet, South Jakarta". */
  label: z.string().min(1).max(120),
  name: z.string().min(1).max(120),
  city: z.string().max(120).nullable(),
  region: z.string().max(120).nullable(),
  country: z.string().max(120).nullable(),
  /** Provider's representative point for the area: a starting pin, not a pickup point. */
  location: LatLngSchema,
});
export type PlaceSuggestion = z.infer<typeof PlaceSuggestionSchema>;

export const PlaceSuggestionsSchema = z.object({ items: z.array(PlaceSuggestionSchema).max(10) });

/** Device coordinates are rounded (~110 m) before the area is looked up. */
export const PlaceReverseQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  lang: UiLanguageSchema.default('en'),
});
export const PlaceReverseSchema = z.object({ item: PlaceSuggestionSchema.nullable() });

/**
 * How far the confirmed pin may sit from the chosen area's point before the
 * label stops describing it. Regions are large and irregular, so they only
 * guard against a pin in a different part of the world.
 */
export const PLACE_MAX_PIN_DISTANCE_KM: Record<PlaceKind, number> = { neighbourhood: 8, city: 40, region: 400 };

export function pinMatchesArea(area: { kind: PlaceKind; location: { lat: number; lng: number } }, pin: { lat: number; lng: number }) {
  return distanceKm(area.location, pin) <= PLACE_MAX_PIN_DISTANCE_KM[area.kind];
}
