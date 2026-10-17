#!/usr/bin/env node
/**
 * Build the FULL stops fixture from the raw GTFS already in this repo.
 * Reads data/raw/bus/stops.txt (10,559 real stops, © OTD Delhi) and writes
 * apps/web/public/fixtures/stops.json — [lon, lat] pairs + names, 5-decimal
 * precision (≈1 m), which keeps the payload well under the 1 MB budget.
 *
 * Also derives `w` per stop — the count of distinct routes serving it, from
 * trips.txt + stop_times.txt (streamed; the file is ~142 MB). `w` drives the
 * zoom-out declutter: only well-served stops render at overview zoom. If the
 * raw files are absent the fixture is still written without `w` and the map
 * falls back to showing everything (honest degradation, no invented weights).
 *
 * Usage (repo root):  npm run fixtures
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const src = join(root, "data/raw/bus/stops.txt");
const outDir = join(root, "apps/web/public/fixtures");
const out = join(outDir, "stops.json");

const text = readFileSync(src, "utf8");
const lines = text.split(/\r?\n/).filter(Boolean);
const header = lines[0].split(",");
const iLat = header.indexOf("stop_lat");
const iLon = header.indexOf("stop_lon");
const iName = header.indexOf("stop_name");
if (iLat < 0 || iLon < 0) throw new Error("stop_lat/stop_lon not found in header");

// Delhi bbox from the validated pipeline (status/gtfs_overview.md)
const BBOX = { w: 76.84, s: 28.4, e: 77.35, n: 28.88 };
const iStopId = header.indexOf("stop_id");
const points = [];
const names = [];
const stopIds = [];
let dropped = 0;

for (const line of lines.slice(1)) {
  // naive CSV split is fine here: names with commas are rare and we only
  // need lat/lon columns, which precede any commas in quoted names
  const cols = line.split(",");
  const lat = Number(cols[iLat]);
  const lon = Number(cols[iLon]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) { dropped++; continue; }
  if (lon < BBOX.w || lon > BBOX.e || lat < BBOX.s || lat > BBOX.n) { dropped++; continue; }
  points.push([Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5]);
  names.push(iName >= 0 ? cols[iName] : "");
  stopIds.push(iStopId >= 0 ? cols[iStopId] : "");
}

// ---- distinct routes per stop (streamed — stop_times.txt is ~3.7M rows) ----
async function routesPerStop() {
  const tripsPath = join(root, "data/raw/bus/trips.txt");
  const stPath = join(root, "data/raw/bus/stop_times.txt");
  if (!existsSync(tripsPath) || !existsSync(stPath)) return null;

  const tripRoute = new Map();
  {
    const tLines = readFileSync(tripsPath, "utf8").split(/\r?\n/).filter(Boolean);
    const th = tLines[0].split(",");
    const iRoute = th.indexOf("route_id");
    const iTrip = th.indexOf("trip_id");
    for (const l of tLines.slice(1)) {
      const c = l.split(",");
      tripRoute.set(c[iTrip], c[iRoute]);
    }
  }

  const perStop = new Map(); // stop_id -> Set(route_id)
  const rl = createInterface({ input: createReadStream(stPath), crlfDelay: Infinity });
  let ih = null;
  for await (const l of rl) {
    if (!ih) {
      const h = l.split(",");
      ih = { trip: h.indexOf("trip_id"), stop: h.indexOf("stop_id") };
      continue;
    }
    const c = l.split(",");
    const route = tripRoute.get(c[ih.trip]);
    if (!route) continue;
    const sid = c[ih.stop];
    let set = perStop.get(sid);
    if (!set) perStop.set(sid, (set = new Set()));
    set.add(route);
  }
  return perStop;
}

const perStop = await routesPerStop();

// ---- physical-stop crosswalk (pipeline/cluster_stops.py) --------------------
// Two collapses, kept separate because they have different evidence classes:
//
//   stop_id  -> stop_code          lossless, one row per POLE      [Observed]
//   stop_code-> physical_stop_id   40 m clustering, one per PLACE  [Estimated]
//
// The map shows physical stops when zoomed out (one dot per place) and expands
// to individual poles when zoomed in — so the two poles either side of a road
// are one dot at city scale and two dots at street scale. Both tiers are real
// records; nothing here is synthesised. If the crosswalk CSV is absent the
// fixture degrades to the flat stop list and the map skips the expand
// behaviour rather than inventing cluster membership.
function loadCrosswalk() {
  const path = join(root, "data/processed/derived/stop_clusters.csv");
  if (!existsSync(path)) return null;
  const rows = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  const h = rows[0].split(",");
  const i = {
    stopId: h.indexOf("stop_id"),
    code: h.indexOf("stop_code"),
    pid: h.indexOf("physical_stop_id"),
    lon: h.indexOf("centroid_lon"),
    lat: h.indexOf("centroid_lat"),
  };
  if (Object.values(i).some((v) => v < 0)) return null;
  // The crosswalk is built from data/processed (stop_ids feed-prefixed by
  // clean_gtfs.py: "bus_0"), while this script reads data/raw ("0"). Index
  // both spellings so the join works whichever side is regenerated first.
  const byStopId = new Map();
  for (const r of rows.slice(1)) {
    const c = r.split(",");
    const rec = {
      code: c[i.code],
      pid: c[i.pid],
      lon: Number(c[i.lon]),
      lat: Number(c[i.lat]),
    };
    const id = c[i.stopId];
    byStopId.set(id, rec);
    if (id.startsWith("bus_")) byStopId.set(id.slice(4), rec);
  }
  return byStopId;
}

const crosswalk = loadCrosswalk();

/** Union of distinct routes across a set of stop_ids (never a sum — the same
 *  route serving both poles of a pair must count once). */
const routesOf = (ids) => {
  if (!perStop) return 0;
  const u = new Set();
  for (const id of ids) for (const r of perStop.get(id) ?? []) u.add(r);
  return u.size;
};

let boarding = null;
let physical = null;

if (crosswalk) {
  // ---- tier 1: boarding points (distinct stop_code) ----
  const byCode = new Map();
  stopIds.forEach((sid, k) => {
    const x = crosswalk.get(sid);
    if (!x) return;
    if (!byCode.has(x.code)) byCode.set(x.code, { k, ids: [], pid: x.pid });
    byCode.get(x.code).ids.push(sid);
  });
  boarding = {
    points: [], names: [], w: [], pid: [],
  };
  const pidIndex = new Map();
  for (const [, v] of byCode) {
    boarding.points.push(points[v.k]);
    boarding.names.push(names[v.k]);
    boarding.w.push(routesOf(v.ids));
    if (!pidIndex.has(v.pid)) pidIndex.set(v.pid, { ids: [], k: v.k });
    pidIndex.get(v.pid).ids.push(...v.ids);
    boarding.pid.push(v.pid);
  }
  // remap pid strings to compact integer indices — the id itself is a
  // coordinate-derived string and would bloat the payload badly
  const pidOrder = [...pidIndex.keys()];
  const pidNum = new Map(pidOrder.map((p, n) => [p, n]));
  boarding.c = boarding.pid.map((p) => pidNum.get(p));
  delete boarding.pid;

  // ---- tier 2: physical stops (distinct physical_stop_id) ----
  // No names array here: a cluster's label is the name of its first boarding
  // point, which the client resolves through `boarding.c`. Storing it twice
  // cost ~90 KB of payload for zero extra information.
  physical = { points: [], w: [], m: [] };
  for (const pid of pidOrder) {
    const v = pidIndex.get(pid);
    const any = crosswalk.get(v.ids[0]);
    physical.points.push([
      Math.round(any.lon * 1e5) / 1e5,
      Math.round(any.lat * 1e5) / 1e5,
    ]);
    physical.w.push(routesOf(v.ids));
    // member_count = poles merged into this location; drives the "2" badge
    physical.m.push(new Set(v.ids.map((id) => crosswalk.get(id).code)).size);
  }
}

const w = perStop ? stopIds.map((sid) => perStop.get(sid)?.size ?? 0) : undefined;

mkdirSync(outDir, { recursive: true });

// When the crosswalk is available the top-level points array IS the boarding
// tier (one entry per physical pole, Observed) rather than the raw stop_id
// rows. Those raw rows list the same pole once per serving route, so plotting
// all 10,514 of them drew ~3,700 dots exactly on top of other dots: pure
// overdraw, no extra information, and a misleading "10,559 stops" read. The
// raw row count is still reported as raw_stop_rows for provenance.
const useTiers = Boolean(boarding && physical);
const payload = {
  provenance:
    "data/raw/bus/{stops,trips,stop_times}.txt — © Open Transit Data, Government of Delhi",
  generated: new Date().toISOString(),
  raw_stop_rows: points.length,
  count: useTiers ? boarding.points.length : points.length,
  dropped,
  points: useTiers ? boarding.points : points,
  names: useTiers ? boarding.names : names,
  ...(useTiers ? { w: boarding.w } : w ? { w } : {}),
};
if (useTiers) {
  payload.tiers = {
    // evidence classes travel WITH the data so the UI never has to guess
    method: "complete_linkage",
    threshold_m: 40,
    crs: "EPSG:32643",
    // cluster index per boarding point, parallel to points[]
    c: boarding.c,
    boarding: { count: boarding.points.length, evidence: "Observed" },
    physical: { ...physical, evidence: "Estimated" },
  };
}
writeFileSync(out, JSON.stringify(payload));

const kb = Math.round(
  Buffer.byteLength(JSON.stringify({ points: payload.points })) / 1024
);
if (payload.w) {
  // reported over what is actually emitted (boarding points when tiered), so
  // the percentiles describe the array the map filters on
  const pw = payload.w;
  const sorted = [...pw].sort((a, b) => b - a);
  console.log(
    `route counts: max ${sorted[0]}, p90 ${sorted[Math.floor(pw.length * 0.1)]}, ` +
      `p75 ${sorted[Math.floor(pw.length * 0.25)]}, median ${sorted[Math.floor(pw.length * 0.5)]}`
  );
} else {
  console.log("trips/stop_times not found — fixture written without route weights");
}
if (boarding && physical) {
  console.log(
    `tiers: ${points.length} stop_id rows -> ${boarding.points.length} boarding ` +
      `points [Observed] -> ${physical.points.length} physical stops [Estimated]`
  );
} else {
  console.log(
    "data/processed/derived/stop_clusters.csv not found — no tiers written " +
      "(run: python pipeline/cluster_stops.py --csv-only)"
  );
}
const totalKb = Math.round(Buffer.byteLength(JSON.stringify(payload)) / 1024);
console.log(
  `Wrote ${points.length} stops (${dropped} dropped) → ${out} ` +
    `(~${kb} KB points, ~${totalKb} KB total)`
);
