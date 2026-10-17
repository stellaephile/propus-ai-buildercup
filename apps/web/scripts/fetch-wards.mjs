#!/usr/bin/env node
/**
 * Fetch REAL Delhi ward boundaries (DataMeet Municipal_Spatial_Data — the
 * backup source listed in ATTRIBUTION.md, CC BY-SA 2.5 IN) and write
 * apps/web/public/fixtures/wards.geojson with 5-decimal coordinates.
 *
 * Primary source (OpenCity 2022 MCD delimitation) requires a manual download;
 * if you have it, convert to GeoJSON (WGS84) and drop it at the same path —
 * the app reads whatever is there and matches wards by name.
 *
 * Usage (repo root):  npm run wards
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CANDIDATES = [
  // DataMeet Delhi municipal wards (see ATTRIBUTION.md #5)
  "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Delhi/Delhi_Wards.geojson",
  "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Delhi/delhi_wards.geojson",
];

const outDir = join(dirname(fileURLToPath(import.meta.url)), "../public/fixtures");
const out = join(outDir, "wards.geojson");

function round(coords) {
  if (typeof coords[0] === "number")
    return coords.map((c) => Math.round(c * 1e5) / 1e5);
  return coords.map(round);
}

let gj = null;
for (const url of CANDIDATES) {
  try {
    console.log(`Trying ${url} …`);
    const res = await fetch(url);
    if (!res.ok) continue;
    gj = await res.json();
    if (gj?.type === "FeatureCollection") break;
    gj = null;
  } catch {
    /* try next */
  }
}

if (!gj) {
  console.error(
    "Could not fetch ward geometry. Download manually per ATTRIBUTION.md (#4 OpenCity or #5 DataMeet),\n" +
      "convert to WGS84 GeoJSON, and save as apps/web/public/fixtures/wards.geojson.\n" +
      "The app renders an honest empty state until then — it will NOT invent polygons."
  );
  process.exit(1);
}

for (const f of gj.features) {
  if (f.geometry?.coordinates) f.geometry.coordinates = round(f.geometry.coordinates);
}
gj.provenance =
  "© DataMeet India Community (CC BY-SA 2.5 IN) — see ATTRIBUTION.md; coordinates rounded to 5 decimals";

mkdirSync(outDir, { recursive: true });
writeFileSync(out, JSON.stringify(gj));
console.log(`Wrote ${gj.features.length} ward polygons → ${out}`);
if (gj.features.length !== 290)
  console.warn(
    `Note: expected 290 wards (2022 MCD delimitation); this source has ${gj.features.length}. Names may also differ from derived.ward_metrics — the app matches what it can and says so.`
  );
