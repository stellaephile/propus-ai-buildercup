# DECISIONS.md — Propus AI Builder Cup 2026 prototype

Decisions for the hackathon build only. Newest last. Each entry: decision, reason, consequence.
Tasks that act on these live in `docs/TASKS.md`.

---

**D1 — Separate public repo, fresh history** (2026-10-17)
Submit from `propus-ai-buildercup`, a copy of the private Propus repo with no git history.
Reason: no old commit can leak a key or internal data. Consequence: commit 1 is the
pre-hackathon baseline; every later commit is one hackathon feature, so the log shows what
was built during the event.

**D2 — No licence file** (2026-10-17)
Code is visible to judges; all rights reserved. Never add `LICENSE`.

**D3 — Internal docs stay out of the public repo** (2026-10-17)
`propus_sustainability.md`, `.claude/`, and working docs (`docs/TASKS.md`, `docs/DESIGN.md`,
etc.) are gitignored.

**D4 — Cloud Run hosts both frontend and API** (2026-10-17)
The submitted URL must be on Cloud Run or Firebase. Both `apps/web` and `apps/api` deploy to
Cloud Run. Supabase stays the database (not restricted by the rules, already loaded).
Vercel/Render are not used for the submission.

**D5 — Gemini only for reasoning** (2026-10-17)
Leave `GROQ_API_KEY` unset in the deployed service. The existing router then sends every
query to the Gemini chain, with no code change. Reason: the rules require Gemini for
reasoning; mixing in another provider weakens that claim.

**D6 — New tools are PostGIS functions, not inline SQL** (2026-10-17)
`coverage_gap` and `stop_heat_exposure` are `fn_coverage_gap` / `fn_stop_heat_exposure` in
`db/functions.sql`, executed by the read-only `propus_agent_ro` role (5 s timeout). This
deviates from the f-string SQL sketch in `propus_sustainability.md` §4. Reason: `CLAUDE.md` §5
deterministic geo layer; injection-proof; parameter clamping lives in one place.

**D7 — Precompute everything; no runtime Earth Engine calls** (2026-10-17)
WorldPop distances and Landsat LST are computed offline once and stored in PostGIS. Reason:
tool calls must return in < 1 s and the live app must not depend on Earth Engine auth or quota.

**D8 — Physical bus stops, not `stop_id`** (2026-10-17)
Bus distances and heat use `derived.stop_clusters` physical stops (10,559 `stop_id` rows
collapse to 6,880 poles and ~4,388 stop locations). Reason: counting `stop_id` double-counts
boarding points. Physical stops plus metro stations live in `derived.transit_points`, shared
by both tools.

**D9 — Population from WorldPop 100 m cell centres** (2026-10-17)
WorldPop India 2020 constrained 100 m, one point per cell, straight-line distance to the
nearest stop in EPSG:32643. Kept separate from the areal-weighted ward method used by
`fn_pop_walk_access`; each result states its own method. Known limit: straight-line, not
network walking distance. Evidence class: `Estimated` (WorldPop is modelled population).

**D10 — Trips/day from `derived.stop_hourly_frequency`** (2026-10-17)
Raw bus `stop_times` is not in Supabase (free-tier budget). Daily trips per stop =
`SUM(trip_count)` over hours. Known limit: scheduled trips from GTFS, not ridership.

**D11 — Heat is Landsat land surface temperature** (2026-10-17)
Landsat 8/9 Collection 2 L2 `ST_B10`, April–June 2023–25, cloud/shadow-masked median, mean in
a 100 m buffer per stop. Reported as a relative exposure indicator, never as air temperature.
Evidence class: `Estimated`. If LST cannot be computed in time, the heat tool is dropped and
listed as a known limit — no placeholder values.

**D12 — Results use the typed contract** (2026-10-17)
Both tools return `PropusResult[]` (`stat_cards`, `data_table`, `map_layer(points)`) through
the existing SSE stream. No frontend changes beyond what existing renderers already support.

**D13 — Demo mode is the safety net** (2026-10-17)
The 5 sustainability questions are recorded as demo-mode streams. Live Gemini is used for the
judged URL, but a model outage must not kill the video or the pitch.

**D14 — Post-deadline freeze** (2026-10-17)
After 18 October 2026: critical fixes only, no new features, never break the live URL.

**D15 — Walk radii: 500 m bus, 800 m metro** (2026-10-17)
`coverage_gap` takes separate radii per mode, defaulting to 500 m (bus) and 800 m (metro),
the same defaults as `fn_pop_walk_access`. Basis: India's National TOD Policy (MoHUA) sets
the station influence zone at 500–800 m / 10–12 min walk; ITDP's TOD Standard prefers
< 500 m. A 2015 DMRC rider survey (Ann, Jiang & Yamamoto, JTLU) found median metro access
walks of 600 m and 85th percentile of 1,000–1,500 m, so 1 km is offered as a sensitivity
value, not a default. Radii are clamped to 200–1,500 m.

**D16 — Heat threshold is relative: city mean + 1 SD** (2026-10-17)
`stop_heat_exposure` defaults to stops whose LST ≥ mean + 1 standard deviation of all
transit-point LST (currently 41.3 + 1.7, rounded to 43.0 °C: 705 stops, 12.8% of daily trips). A fixed
°C threshold remains an optional argument (clamped 30–60). Basis: thermal-stress thresholds
in the literature (e.g. UTCI 26 / 32 °C bands for active travel) are defined on felt-heat
indices, not satellite LST, and the LST–air temperature relationship varies with urban form
and season, so no absolute LST value can be called "dangerous". Surface-UHI studies zone
heat relative to the city's own mean and SD. Wording rule: "among the hottest surfaces in
Delhi", never "extreme heat". The plan's 45 °C default caught only 81 stops (0.8% of trips).
