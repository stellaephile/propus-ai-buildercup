# Propus web — the pitch frontend

Next.js (App Router, TS) + MapLibre + Framer Motion, built to `CLAUDE.md` / `TASKS.md`.
The landing **is** the instrument: a real muted Delhi basemap, real stops twinkling in, and a
zero-cut morph into the app on the first query — the map instance never remounts.

## Run it

```bash
# repo root
npm install
npm run fixtures   # full 10,559-stop fixture from data/raw GTFS (recommended)
npm run wards      # real MCD ward polygons (DataMeet, see ATTRIBUTION.md)
npm run dev        # http://localhost:3000
```

Without the two fixture scripts the app still runs honestly: a committed 232-stop **real**
sample (labelled as such on the map) and an explicit "ward geometry not loaded" notice —
never invented polygons.

## Modes

- **demo** (default): the five headline queries replay typed SSE event sequences built from
  recorded real data. No backend, no model — an outage cannot kill the pitch (CLAUDE.md §5.2).
- **live**: set `NEXT_PUBLIC_MODE=live` and `NEXT_PUBLIC_API_URL` once the FastAPI agent
  emits the typed contract (TASKS.md B2). The frontend consumes identical events either way.

## Where the numbers come from (§3: provenance or nothing)

| Surface | Source | Evidence |
|---|---|---|
| Worst/best ward table, comparison, bar chart | `status/day2_summary.md` — recorded `compute.py` output vs `derived.ward_metrics`, 2026-03-29 | Calculated |
| Stop/station coordinates, proof strip counts | raw GTFS in `data/raw/` (OTD Delhi, DMRC) | Observed |
| Catchment + scenario stop counts | computed in-browser from real coordinates (haversine; server version is PostGIS in EPSG:32643) | Calculated |
| Population figures | **not shown** — require WorldPop on the backend; rendered as "—" with a note | — |

Query #2 compares **Kashmere Gate vs Sangam Vihar** (both have real recorded metrics) instead
of Dwarka vs Seemapuri, whose per-ward numbers aren't in the repo. Swap back when F0 records
live streams.

## Structure

```
packages/contract        PropusResult + PropusEvent — single source of truth (§6, §6a)
apps/web/lib/tokens.ts   design + motion tokens — the only place a hex or spring lives
apps/web/lib/demo/       query builders + typed-event replay (demo insurance)
apps/web/lib/map/        useMapConductor — flyTo → moveend → gated layer fade (§6b)
apps/web/components/     results/ (one renderer per kind), map/ (view, layers, inspector)
apps/web/app/            page (landing+app, zero-cut) · /kit (design system, A5)
```

## Definition-of-done checkpoints (§11)

- Tokens referenced everywhere; zero hardcoded hexes outside `lib/tokens.ts`.
- Amber = underserved data points + failure chips only.
- `prefers-reduced-motion`: map jumps, numbers snap, ghost text static, fades remain.
- Keyboard: all controls are native buttons/inputs with visible focus rings; table sort is
  aria-sorted; map furniture has labels.
- Every figure carries an evidence tag; methodology drawer states formula, CRS
  (EPSG:32643 measure / EPSG:4326 display), and ATTRIBUTION.md sources.
