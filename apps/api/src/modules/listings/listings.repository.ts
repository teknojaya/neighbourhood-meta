import { geohashRanges, type ItemCategory, type LatLng, type ListingMode } from '@neighbourhood/shared';
import type { Db } from '../../lib/db.js';
import { Prisma } from '../../lib/db.js';

/** Earth mean radius used by geofire-common, so SQL and JS distances agree. */
const EARTH_RADIUS_KM = 6371;

export interface NearbyListingRow {
  id: string;
  ownerId: string;
  title: string;
  category: ItemCategory;
  mode: ListingMode;
  condition: string;
  areaLabel: string;
  stockTotal: number;
  stockReserved: number;
  stockCollected: number;
  /** Exact distance — round with roundDistanceForDisplay() before exposing. */
  distanceKm: number;
  /** Exact coordinates — map with approximateLocation() before exposing. */
  lat: number;
  lng: number;
}

export interface NearbySearch {
  query?: string;
  center: LatLng;
  radiusKm: number;
  category?: ItemCategory;
  mode?: ListingMode;
  /** Hide the searcher's own listings. */
  excludeOwnerId?: string;
  limit: number;
}

/**
 * Radius search in one SQL statement:
 *  1. geohash candidate ranges (btree on geohash COLLATE "C", partial on active),
 *  2. exact haversine distance filter,
 *  3. ordered by distance, bounded by LIMIT.
 * Never loads the table into memory.
 */
export async function searchNearbyListings(db: Db, q: NearbySearch): Promise<NearbyListingRow[]> {
  const ranges = geohashRanges(q.center, q.radiusKm);
  const rangeSql = Prisma.join(
    ranges.map(([s, e]) => Prisma.sql`(l.geohash COLLATE "C" >= ${s} AND l.geohash COLLATE "C" <= ${e})`),
    ' OR ',
  );
  const filters: Prisma.Sql[] = [Prisma.sql`(l.mode = 'lend' OR l.stock_total - l.stock_reserved - l.stock_collected > 0)`, Prisma.sql`(l.best_before IS NULL OR l.best_before >= CURRENT_DATE)`, Prisma.sql`(NOT l.food_rescue OR l.collect_by > now())`, Prisma.sql`l.status = 'active'`, Prisma.sql`(${rangeSql})`];
  if (q.query?.trim()) {
    const terms = q.query.trim().split(/\s+/).slice(0, 8);
    for (const term of terms) { const pattern = `%${term.replace(/[\\%_]/g, value => `\\${value}`)}%`; filters.push(Prisma.sql`(l.title ILIKE ${pattern} OR l.description ILIKE ${pattern})`); }
  }
  filters.push(Prisma.sql`(l.community_point_id IS NULL OR EXISTS (SELECT 1 FROM community_points p WHERE p.id = l.community_point_id AND p.active))`);
  if (q.category) filters.push(Prisma.sql`l.category = ${q.category}::"ItemCategory"`);
  if (q.mode) filters.push(Prisma.sql`l.mode = ${q.mode}::"ListingMode"`);
  if (q.excludeOwnerId) filters.push(Prisma.sql`l.owner_id <> ${q.excludeOwnerId}::uuid`);

  return db.$queryRaw<NearbyListingRow[]>`
    SELECT * FROM (
      SELECT l.id, l.owner_id AS "ownerId", l.title, l.category, l.mode, l.condition,
             l.area_label AS "areaLabel", l.stock_total AS "stockTotal",
             l.stock_reserved AS "stockReserved", l.stock_collected AS "stockCollected",
             l.lat, l.lng,
             ${EARTH_RADIUS_KM} * 2 * asin(sqrt(
               power(sin(radians(l.lat - ${q.center.lat}) / 2), 2) +
               cos(radians(${q.center.lat})) * cos(radians(l.lat)) *
               power(sin(radians(l.lng - ${q.center.lng}) / 2), 2)
             )) AS "distanceKm"
      FROM listings l
      WHERE ${Prisma.join(filters, ' AND ')}
    ) c
    WHERE c."distanceKm" <= ${q.radiusKm}
    ORDER BY c."distanceKm", c.id
    LIMIT ${q.limit}`;
}
