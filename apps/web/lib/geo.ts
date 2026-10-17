/**
 * Client-side geodesic helpers for the demo. These are honest approximations
 * for display; authoritative measurement runs server-side in EPSG:32643
 * (UTM 43N) via PostGIS (CLAUDE.md §3.5). Methodology drawers state which
 * one produced a number.
 */

const R = 6371008.8; // mean Earth radius, metres

export function haversineM(
  [lon1, lat1]: [number, number],
  [lon2, lat2]: [number, number]
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Geodesic circle polygon around [lon, lat], radius in metres. */
export function circlePolygon(
  center: [number, number],
  radiusM: number,
  steps = 96
): GeoJSON.Feature<GeoJSON.Polygon> {
  const [lon, lat] = center;
  const latR = (lat * Math.PI) / 180;
  const dLat = (radiusM / R) * (180 / Math.PI);
  const dLon = dLat / Math.cos(latR);
  const coords: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    coords.push([lon + dLon * Math.cos(t), lat + dLat * Math.sin(t)]);
  }
  return {
    type: "Feature",
    properties: { radius_m: radiusM },
    geometry: { type: "Polygon", coordinates: [coords] },
  };
}

export function countWithin(
  points: [number, number][],
  center: [number, number],
  radiusM: number
): number {
  let n = 0;
  for (const p of points) if (haversineM(p, center) <= radiusM) n++;
  return n;
}

/** [west, south, east, north] over every coordinate in a FeatureCollection. */
export function bboxOf(
  fc: GeoJSON.FeatureCollection
): [number, number, number, number] | null {
  let w = Infinity,
    s = Infinity,
    e = -Infinity,
    n = -Infinity;
  const visit = (coords: unknown): void => {
    if (typeof (coords as number[])[0] === "number") {
      const [lon, lat] = coords as [number, number];
      if (lon < w) w = lon;
      if (lon > e) e = lon;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
      return;
    }
    for (const c of coords as unknown[]) visit(c);
  };
  for (const f of fc.features) if (f.geometry && "coordinates" in f.geometry) visit(f.geometry.coordinates);
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

/** Delhi bounds from validated GTFS bbox (status/gtfs_overview.md) */
export const DELHI_BBOX = { west: 76.84, south: 28.4, east: 77.35, north: 28.88 };
export const DELHI_CENTER: [number, number] = [77.1025, 28.6139];
