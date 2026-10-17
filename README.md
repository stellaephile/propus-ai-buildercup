# Propus: ask Delhi's transit data a question

Propus answers plain-English questions about Delhi's bus and metro network. You type a
question; it returns a table, a chart or a map layer, and every figure carries a tag that says
where it came from. Built for the Google Cloud AI Builder Cup 2026.

**Live demo: https://propus-web-wkpfu3pb7q-el.a.run.app**

Code is visible for judging. All rights reserved.

## Try it in two minutes

Open the live demo and click an example, or paste any question below. Figures were computed on
the data loaded on 17 October 2026.

| # | Question | What you should see |
|---|---|---|
| 1 | Which wards have the worst transit access? | A ranked table, a shaded map, summary cards and a scatter chart |
| 2 | Compare transit access in Kashmere Gate vs Sangam Vihar | The two areas side by side, with how much better one is served |
| 3 | Show the 500m catchment for Kashmere Gate | The 500 m walking zone on the map, with counts |
| 4 | Rank the best-served wards by bus stops | A ranked bar chart |
| 5 | If a metro station is added in Sangam Vihar, how many more people fall within 800m? | A table of people newly covered, and the share left without access before and after |
| 6 | What share of Delhi's population lives more than 500 m from any bus or metro stop? | 18.7% (3.60 million of 19.29 million people), plus the ten largest gaps on the map |
| 7 | Show the 10 biggest areas without a metro station within 1 km. | 49.6% of people (9.57 million) are beyond 1 km of a metro station; ten ranked clusters |
| 8 | Which busy stops are on the hottest surfaces in Delhi? | 705 stops at or above 43.0 °C (the city average plus one standard deviation), carrying 12.8% of daily trips |
| 9 | What share of daily bus trips stop at places hotter than 45 °C? | 80 stops, 0.8% of trips. Few stops are that hot, so question 8 is the more informative one |
| 10 | What is the air quality at Kashmere Gate? | A refusal: "I do not have data on air quality." This is the guardrail check |

Questions 6 to 10 use the tools added for the hackathon (below). Questions 6, 7 and 9 need
the live agent, because each asks for a specific distance or temperature. If the live agent is
ever unavailable, the app replays recorded answers for questions 1 to 5, 8 and 10, and for
"Where do people live far from any bus stop or metro station?". They are clearly labelled
"Recorded answer, captured <date>", and the top bar reads "Recorded demo".

New to Delhi or to transport planning? The **How to read this** button in the app explains the
terms (ward, catchment, transit access score, surface temperature) and the four evidence tags
(Observed, Calculated, Estimated, Modelled).

## What is new for the hackathon

Propus began as a prototype before this contest (the first commit is the baseline). Added
during the hackathon:

- **`coverage_gap` tool:** population beyond walking distance of transit, from WorldPop
  population cells and the bus and metro timetables.
- **`stop_heat_exposure` tool:** land surface temperature at each stop from Landsat 8/9 via
  Google Earth Engine, weighted by how many trips call at the stop.
- **Grounding guardrails:** every number comes from a tool result, never from the model; a
  question the data cannot answer gets a typed refusal card instead of a guess.
- **Google Cloud deployment:** two Cloud Run services (web and API), Gemini on Vertex AI
  through the Agent Development Kit, a Firestore query log, Secret Manager for the database
  credential, and a raised request timeout for streaming.
- **Reliability:** recorded answers as a fallback, a golden-question check, a keep-warm and
  alarm workflow, and a latency fix (median answer time 5.0 s down to 2.7 s).
- **Plain-language interface:** a help dialog and glossary, example questions, evidence tags
  explained in words, and accessibility work (keyboard, focus, screen-reader labels, reduced
  motion).

## How it works

```
Browser ──▶ propus-web (Cloud Run) ──SSE──▶ propus-api (Cloud Run) ──▶ Supabase PostGIS
                                                │                       (read-only role)
                                                ├──▶ Gemini on Vertex AI
                                                └──▶ Firestore (query log)
```

- The model never writes SQL. It picks one of 18 tools; each tool calls a parametrised
  PostGIS function (`db/functions.sql`) that does the spatial maths in a projected coordinate
  system (EPSG:32643).
- The API returns **typed results** (table, chart, cards, map layer) over a streamed event
  channel, so the screen can show the answer's shape immediately and fill it in. The shared
  contract is in `packages/contract`.
- Heat and population are **precomputed offline** into PostGIS, so a question is a quick
  lookup, not a satellite job.

## Guardrails

- **Numbers only from tools.** Cards and tables are built from tool output by code, not from
  the model's text.
- **Refusals are typed.** Air quality, ridership and income have no tool, and the app shows a
  "Not available in Propus data" card with no number.
- **Read-only database role** with a 5 second statement timeout. It can run the analysis
  functions and cannot insert, update or delete.
- **Request validation.** Questions are limited to 500 characters; blank text and malformed ids
  are rejected. CORS allows only the web app's own address.
- **Honest labels.** Heat is always called "land surface temperature". Recorded answers say
  they are recorded. A failure shows a plain message, never a raw error.
- **Secrets are not in the repo.** `.env` is ignored, the database credential lives in Secret
  Manager, and `gitleaks detect` is clean.

## Reliability and latency

`python scripts/golden.py <api-url>` runs ten questions against the API (`fixtures/golden.json`)
and checks, for each: the stream finishes without an error, the right tools run in the right
order, the expected result types come back, it finishes within 8 s, and a refusal contains no
number. It cannot check the model's own prose, because that text is never shown to the user.

Latest run against the live API (18 October 2026):

| Question | Result | Time (ms) |
|---|---|---|
| worst_wards | over budget | 8694 |
| compare | pass | 3331 |
| catchment | pass | 7056 |
| rank_bus_stops | pass | 2562 |
| scenario | pass | 5483 |
| heat | pass | 2292 |
| coverage_gap | pass | 2492 |
| refusal_air_quality | pass | 2025 |
| worst_wards_rephrased | pass | 2442 |
| heat_rephrased | pass | 4007 |

Over five runs (50 questions) after the latency fix, 49 finished within 8 s. Across 40 logged
requests the median was 2.7 s and the 90th percentile 4.9 s. The slowest requests were the
model's first call, so the remaining spread is Gemini latency. Before the fix the median was
5.0 s with occasional 20 to 30 s answers.

Both services run with one instance always on, and a scheduled GitHub workflow checks them every
10 minutes and fails (and emails the owner) if either stays down.

## Data sources

Open data only. Full licences and attribution are in [ATTRIBUTION.md](ATTRIBUTION.md).

- Bus timetables (GTFS): Delhi Open Transit Data. Metro timetables: DMRC.
- OpenStreetMap, for the basemap and street data.
- Ward boundaries: OpenCity and DataMeet.
- Population: WorldPop, India 2020, 100 m cells.
- Heat: Landsat 8/9 Collection 2 land surface temperature (USGS) through Google Earth Engine,
  April to June scenes from 2023 to 2025.

## Known limits

- **Distances are straight lines**, not walking routes. Walls, rail lines and rivers are
  ignored, so access is overstated in places. The defaults are 500 m for a bus stop and 800 m
  for a metro station.
- **Heat is land surface temperature**, a relative indicator of how hot the ground is. It is
  not air temperature or how hot it feels. It is a median over one season, within 100 m of each
  stop. "Hot" means above the city average by a chosen number of standard deviations (1 by
  default).
- **Trips are from the timetable**, not ridership. A stop with many scheduled trips is not
  necessarily a stop with many passengers.
- **Population is modelled** (WorldPop), and ward totals are shares of it, so they are
  estimates.
- **The ward table holds 290 areas**: 272 numbered MCD wards, 9 NDMC and 8 Cantonment charge
  areas, and 1 other. The 272 wards are the delimitation from before 2022 (the 2022 one has
  250), so names and boundaries may differ from today's.
- **Delhi only.** 250 of the 4,650 stop points (174 bus, 76 metro) fall outside every ward
  polygon. Some are beyond the Delhi border (metro stations reach about 77.54° E); others may
  sit in gaps between polygons. Ward-level figures leave them out; the coverage-gap measure
  still counts them when judging who is far from a stop.
- **The metro-station scenario** returns a table in the live app, without a drawn map zone.
- **Each question stands alone.** Propus does not remember earlier questions in the same session.
- **Recorded answers are dated** and do not update.
- **Landmarks and street addresses** are not looked up: the Google place search is not enabled
  in the deployed service, so questions should name wards, stops or stations.

## Run it yourself

Local setup is in [docs/RUNNING.md](docs/RUNNING.md). In short, from the repository root:

```bash
cp .env.example .env            # fill in the names listed there; never commit .env
pip install -r apps/api/requirements.txt
uvicorn apps.api.main:app --port 8010
cd apps/web && npm install && npm run dev
```

With no API address configured, the web app replays the recorded answers, so you can explore
the interface with no credentials at all.

## Deploy

`deploy/cloudrun.sh <project-id> [region]` builds both images with Cloud Build and deploys them
to Cloud Run. Prerequisites and the secrets it expects are in
[docs/DEPLOY_GCP.md](docs/DEPLOY_GCP.md).

## Repository layout

| Path | What it holds |
|---|---|
| `apps/web/` | Next.js interface: map, results, help dialog |
| `apps/api/` | FastAPI service and the Gemini agent with its tools |
| `packages/contract/` | The shared result and event types |
| `db/` | Schema, the analysis SQL functions, and the read-only role |
| `pipeline/` | Offline jobs: timetable ingest, ward metrics, population and heat |
| `scripts/`, `fixtures/` | Golden-question check and the demo recorder |
| `deploy/`, `.github/` | Cloud Run deployment and the keep-warm workflow |
| `docs/` | Running, deployment and design-decision notes |

Folders `cloud-run/`, `frontend/`, `agent/`, `api/` and `mcp_server/` are the earlier Streamlit
prototype. The deployed app does not use them. [ARCHITECTURE.md](ARCHITECTURE.md) describes
the design in more depth.
