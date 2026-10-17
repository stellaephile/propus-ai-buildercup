"""
pipeline/process_metro_lines.py
--------------------------------
Curated metro-lines shapefile -> one slim, standardized frontend fixture.

Input:  data/processed/metro/metro_lines.shp — OSM railway=subway ways curated
        in QGIS (EPSG:4326), with `colour` filled on every segment. This file
        supersedes the raw QuickOSM geojson exports: it covers the full
        network (Red/Green/Grey/Aqua/Rapid/RRTS included).
Output: apps/web/public/fixtures/metro_lines.geojson
        One feature per line, MultiLineString, 5-decimal coords, properties
        standardized to exactly:
            { name, line, colour, evidence }
        `colour` is the curated per-line hex (majority vote across the line's
        segments) and is what the map paints with; `line` keys into
        metroLineTokens / METRO_STOP_LINES so station rings share the same
        colour; `name` is cleaned for the hover tooltip. All other columns
        (gauge, voltage, operator, bridge, ...) are dropped.

Honesty rules (§3.1):
  - construction / Phase-4 segments are excluded — unbuilt track never
    renders as an operating line;
  - unnamed segments are attributed by colour only when that colour maps to
    exactly one line; ambiguous ones are dropped and reported;
  - colour conflicts between lines are reported (and the Grey Line's blue
    curation slip is overridden to a neutral grey until fixed in the .shp).

Usage: .venv/bin/python pipeline/process_metro_lines.py
"""

from __future__ import annotations

import json
import math
import re
from collections import Counter, defaultdict
from pathlib import Path

import geopandas as gpd

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "processed" / "metro" / "metro_lines.shp"
OUT = ROOT / "apps" / "web" / "public" / "fixtures" / "metro_lines.geojson"

# name pattern -> (line key, clean display name). Keys match METRO_STOP_LINES
# (GTFS route_long_name prefixes) so station rings can share line colours.
LINE_PATTERNS: list[tuple[str, str, str]] = [
    (r"\bBlue Line\b", "BLUE", "Blue Line"),
    (r"\bYellow Line\b", "YELLOW", "Yellow Line"),
    (r"\bRed Line\b", "RED", "Red Line"),
    (r"\bGreen Line\b", "GREEN", "Green Line"),  # branch merges into the line
    (r"\bViolet Line\b", "VIOLET", "Violet Line"),
    (r"\bPink Line\b", "PINK", "Pink Line"),
    (r"\bMagenta Line\b", "MAGENTA", "Magenta Line"),
    (r"\bGr[ae]y Line\b", "GRAY", "Grey Line"),
    (r"\bAirport Express\b|\bOrange Line\b", "ORANGE/AIRPORT", "Airport Express Line"),
    (r"\bAqua Line\b", "AQUA", "Aqua Line"),
    (r"\bRapid Metro", "RAPID", "Rapid Metro (Gurgaon)"),
    (r"\bRRTS\b", "RRTS", "Delhi–Meerut RRTS"),
]
EXCLUDE = re.compile(r"Phase[- ]?4|under construction|proposed", re.IGNORECASE)

# curation overrides, applied loudly: Grey Line is tagged #1e90ff in the .shp —
# identical to the Blue Line, so the two would be indistinguishable on the map.
COLOUR_OVERRIDES = {"GRAY": "#6D6E71"}

GRID = 25 / 111_000  # ~25 m — segment-dedupe cell size
COVERED_FRACTION = 0.8


def line_of(name: str | None) -> tuple[str, str] | None:
    if not name or EXCLUDE.search(name):
        return None
    for pat, key, display in LINE_PATTERNS:
        if re.search(pat, name):
            return key, display
    return None


class Coverage:
    """Spatial hash of accepted points; ~25 m coverage test for dedupe."""

    def __init__(self) -> None:
        self.cells: dict[tuple[int, int], list[tuple[float, float]]] = {}

    def add(self, part: list[tuple[float, float]]) -> None:
        for lon, lat in part:
            self.cells.setdefault((round(lon / GRID), round(lat / GRID)), []).append((lon, lat))

    def near(self, lon: float, lat: float) -> bool:
        cx, cy = round(lon / GRID), round(lat / GRID)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for plon, plat in self.cells.get((cx + dx, cy + dy), ()):
                    if math.hypot(lon - plon, lat - plat) <= GRID:
                        return True
        return False

    def covered_fraction(self, part: list[tuple[float, float]]) -> float:
        if not part:
            return 1.0
        return sum(1 for lon, lat in part if self.near(lon, lat)) / len(part)


def main() -> int:
    gdf = gpd.read_file(SRC)
    assert str(gdf.crs).upper().endswith("4326"), f"expected EPSG:4326, got {gdf.crs}"

    # drop construction segments outright
    n0 = len(gdf)
    gdf = gdf[gdf["constructi"].isna()]
    print(f"{n0 - len(gdf)} construction-tagged segments dropped")

    # first pass — named segments: line assignment + colour census
    seg_line: list[str | None] = []
    colour_votes: dict[str, Counter] = defaultdict(Counter)
    colour_to_lines: dict[str, set[str]] = defaultdict(set)
    excluded_names: set[str] = set()
    for _, row in gdf.iterrows():
        hit = line_of(row["name"])
        key = hit[0] if hit else None
        seg_line.append(key)
        if key:
            colour = (row["colour"] or "").strip()
            if colour:
                colour_votes[key][colour] += 1
                colour_to_lines[colour].add(key)
        elif isinstance(row["name"], str) and row["name"].strip():
            excluded_names.add(row["name"])

    # second pass — attribute unnamed segments by unambiguous colour
    rescued = dropped_unnamed = 0
    for i, (_, row) in enumerate(gdf.iterrows()):
        if seg_line[i] is not None or (isinstance(row["name"], str) and row["name"].strip()):
            continue
        owners = colour_to_lines.get((row["colour"] or "").strip(), set())
        if len(owners) == 1:
            seg_line[i] = next(iter(owners))
            rescued += 1
        else:
            dropped_unnamed += 1

    # final line colour: majority vote, then loud overrides
    display = {key: disp for _, key, disp in LINE_PATTERNS}
    line_colour: dict[str, str] = {}
    for key, votes in colour_votes.items():
        line_colour[key] = votes.most_common(1)[0][0]
    for colour, owners in sorted(colour_to_lines.items()):
        if len(owners) > 1:
            print(f"WARNING: colour {colour} is shared by {sorted(owners)} in the .shp")
    for key, colour in COLOUR_OVERRIDES.items():
        if key in line_colour:
            print(f"WARNING: overriding {key} colour {line_colour[key]} -> {colour} "
                  f"(fix the colour in {SRC.name} to remove this override)")
            line_colour[key] = colour

    # build one MultiLineString per line, deduping parallel/duplicate segments
    features = []
    for key in sorted(line_colour):
        cov = Coverage()
        kept: list[list[list[float]]] = []
        skipped = 0
        parts = [
            [(x, y) for x, y in row.geometry.coords]
            for (_, row), k in zip(gdf.iterrows(), seg_line)
            if k == key
        ]
        parts.sort(key=len, reverse=True)  # longest first seeds coverage
        for part in parts:
            if cov.covered_fraction(part) >= COVERED_FRACTION:
                skipped += 1
                continue
            kept.append([[round(lon, 5), round(lat, 5)] for lon, lat in part])
            cov.add(part)
        features.append({
            "type": "Feature",
            "geometry": {"type": "MultiLineString", "coordinates": kept},
            "properties": {
                "name": display[key],
                "line": key,
                "colour": line_colour[key],
                "evidence": "Observed",
            },
        })
        pts = sum(len(p) for p in kept)
        print(f"{key:16} {line_colour[key]:8} {len(kept):3} parts, {pts:5} pts "
              f"({skipped} redundant dropped)")

    OUT.write_text(json.dumps(
        {"type": "FeatureCollection", "features": features}, separators=(",", ":")
    ))
    print(f"{len(features)} lines -> {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1024:.0f} KB); "
          f"{rescued} unnamed segments attributed by colour, {dropped_unnamed} dropped as ambiguous")
    for name in sorted(excluded_names):
        print(f"  excluded: {name!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
