"""
precompute_route_aggregates.py
-------------------------------
Builds derived.route_stops and derived.stop_hourly_frequency from the local,
raw GTFS CSVs — replacing two agent tools' (get_route_coverage,
get_frequency_at_stop) live dependency on gtfs_bus.stop_times, which is
deliberately NOT loaded into Supabase (~3.7M rows, see schema.sql).

Reads only local files (data/processed/{bus,metro}/{stop_times,trips}.csv) —
no GCP access needed. Writes to Supabase via DATABASE_URL.

Usage:
    python pipeline/precompute_route_aggregates.py

Requires:
    DATABASE_URL in .env
    schema.sql applied (derived.route_stops, derived.stop_hourly_frequency)
    data/processed/{bus,metro}/{stop_times,trips}.csv present locally
"""

import os
import logging
import pandas as pd
from sqlalchemy import create_engine, text
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger(__name__)

DATABASE_URL = os.environ["DATABASE_URL"]

FEEDS = {
    "bus":   "data/processed/bus",
    "metro": "data/processed/metro",
}


def _psql_copy_writer(table, conn, keys, data_iter):
    """pandas to_sql writer using COPY FROM STDIN (no bound-parameter limit)."""
    import io
    import csv
    raw = conn.connection
    with raw.cursor() as cur:
        buf = io.StringIO()
        writer = csv.writer(buf, quoting=csv.QUOTE_MINIMAL)
        writer.writerows(data_iter)
        buf.seek(0)
        cols = ", ".join(f'"{k}"' for k in keys)
        cur.copy_expert(
            f'COPY "{table.schema}"."{table.name}" ({cols}) FROM STDIN WITH (FORMAT CSV)',
            buf,
        )


def build_route_stops(feed_name: str) -> pd.DataFrame:
    """
    One representative trip per route_id, ordered by stop_sequence.
    Representative trip = the one with the most stops (best coverage of the
    route's full alignment); ties broken by trip_id for determinism.
    """
    st = pd.read_csv(
        f"{FEEDS[feed_name]}/stop_times.csv",
        usecols=["trip_id", "stop_id", "stop_sequence"],
        dtype={"trip_id": str, "stop_id": str, "stop_sequence": "int32"},
    )
    trips = pd.read_csv(
        f"{FEEDS[feed_name]}/trips.csv",
        usecols=["trip_id", "route_id"],
        dtype=str,
    )

    trip_lengths = st.groupby("trip_id").size().rename("n_stops")
    trip_route = trips.set_index("trip_id")["route_id"]

    candidates = trip_lengths.to_frame().join(trip_route, how="inner")
    candidates = candidates.reset_index().sort_values(
        ["route_id", "n_stops", "trip_id"], ascending=[True, False, True]
    )
    representative = candidates.drop_duplicates("route_id", keep="first")
    rep_trip_ids = set(representative["trip_id"])

    ordered = st[st["trip_id"].isin(rep_trip_ids)].merge(
        trip_route.rename("route_id"), left_on="trip_id", right_index=True
    )
    ordered = ordered.sort_values(["route_id", "stop_sequence"])

    out = ordered[["route_id", "stop_sequence", "stop_id"]].copy()
    out["feed"] = feed_name
    return out.reset_index(drop=True)


def build_stop_hourly_frequency(feed_name: str) -> pd.DataFrame:
    """
    Per-stop, per-hour-of-day scheduled trip counts (distinct trips).
    hour_of_day = arrival_seconds // 3600, extends past 23 for GTFS's
    overnight >24:00:00 times.
    """
    st = pd.read_csv(
        f"{FEEDS[feed_name]}/stop_times.csv",
        usecols=["trip_id", "stop_id", "arrival_seconds"],
        dtype={"trip_id": str, "stop_id": str},
    )
    st["arrival_seconds"] = pd.to_numeric(st["arrival_seconds"], errors="coerce")
    st = st.dropna(subset=["arrival_seconds"])
    st["hour_of_day"] = (st["arrival_seconds"] // 3600).astype("int32")

    grouped = (
        st.drop_duplicates(["trip_id", "stop_id", "hour_of_day"])
        .groupby(["stop_id", "hour_of_day"])
        .size()
        .rename("trip_count")
        .reset_index()
    )
    grouped["feed"] = feed_name
    return grouped[["stop_id", "feed", "hour_of_day", "trip_count"]]


def load_dataframe(engine, df: pd.DataFrame, schema: str, table: str, feed_name: str):
    with engine.connect() as conn:
        conn.execute(text(f'DELETE FROM {schema}."{table}" WHERE feed = :feed'), {"feed": feed_name})
        conn.commit()
    df.to_sql(table, engine, schema=schema, if_exists="append", index=False, method=_psql_copy_writer)
    log.info(f"  ✓ {schema}.{table} [{feed_name}]: {len(df):,} rows")


def verify(engine):
    log.info("\n── Verification ──")
    with engine.connect() as conn:
        for schema, table in [("derived", "route_stops"), ("derived", "stop_hourly_frequency")]:
            total = conn.execute(text(f"SELECT COUNT(*) FROM {schema}.{table}")).scalar()
            by_feed = conn.execute(text(f"SELECT feed, COUNT(*) FROM {schema}.{table} GROUP BY feed")).fetchall()
            log.info(f"  {schema}.{table}: {total:,} rows total — {dict(by_feed)}")

        joined = conn.execute(text("""
            SELECT COUNT(*) FROM derived.route_stops rs
            JOIN gtfs_bus.stops s ON s.stop_id = rs.stop_id
            WHERE rs.feed = 'bus'
        """)).scalar()
        log.info(f"  route_stops ↔ bus stops join: {joined:,} rows")


def main():
    log.info("=" * 60)
    log.info("Propus — Route Aggregates Precompute (local GTFS → Supabase)")
    log.info("=" * 60)

    engine = create_engine(DATABASE_URL, pool_pre_ping=True)

    for feed_name in ["bus", "metro"]:
        log.info(f"\n── {feed_name.upper()} FEED ──")

        log.info(f"  Building route_stops for {feed_name}...")
        route_stops = build_route_stops(feed_name)
        load_dataframe(engine, route_stops, "derived", "route_stops", feed_name)

        log.info(f"  Building stop_hourly_frequency for {feed_name}...")
        freq = build_stop_hourly_frequency(feed_name)
        load_dataframe(engine, freq, "derived", "stop_hourly_frequency", feed_name)

    verify(engine)

    log.info("\n" + "=" * 60)
    log.info("✓ Route aggregates precompute complete.")
    log.info("=" * 60)


if __name__ == "__main__":
    main()
