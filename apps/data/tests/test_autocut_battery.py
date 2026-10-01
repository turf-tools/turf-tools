"""The autocut battery: five zips cut end to end, judged on the drafts.

Runs on the local fixture written by `python -m scripts.autocut_fixture`
(skipped until it exists), each zip in its own in-memory DuckDB with the
blockface relationships mounted where `src.autocut` looks for them. The
invariants are what a draft must never violate; the golden numbers describe
the quality of the cut and are exact, since the cut is deterministic, so a
change in results shows up as a diff to accept on purpose.

    pnpm data:test:autocut
"""

import time
from pathlib import Path

import pytest

import duckdb
from src import autocut
from src.dags.tiger import GEO_CATALOG, TIGER_SCHEMA

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "autocut"
TARGET = 75
ZIPS = {
    "10003": "East Village",
    "10009": "Alphabet City",
    "10314": "Staten Island",
    "11201": "Brooklyn Heights",
    "11385": "Ridgewood",
}

# Captured 2026-10-01 on the fixture of 2026-09-27: drafts, doors at
# p10/median/p90, smallest draft, share within ±25% of target, drafts over
# the cap, vertices median/max. Update deliberately.
GOLDEN: dict[str, tuple | None] = {
    "10003": (138, (51, 66, 93), 34, 76, 0, 7, 24),
    "10009": (164, (48, 65, 86), 32, 77, 0, 6, 17),
    "10314": (69, (42, 62, 85), 31, 70, 1, 18, 33),
    "11201": (212, (50, 71, 99), 25, 70, 2, 7, 27),
    "11385": (144, (50, 66, 86), 30, 81, 0, 14, 31),
}

# Generous next to the ~3 s the slowest zip takes, so only a real
# regression trips it.
TIME_BUDGET_S = 15.0

pytestmark = pytest.mark.autocut


def _connect(zip5: str) -> duckdb.DuckDBPyConnection:
    conn = duckdb.connect()
    conn.execute("INSTALL spatial; LOAD spatial")
    conn.execute(f"ATTACH ':memory:' AS {GEO_CATALOG}")
    conn.execute(f"CREATE SCHEMA {GEO_CATALOG}.{TIGER_SCHEMA}")
    conn.execute(
        f"CREATE TABLE {GEO_CATALOG}.{TIGER_SCHEMA}.blockface_relationships AS "
        f"SELECT * FROM read_parquet('{FIXTURE / 'relationships.parquet'}')"
    )
    conn.execute(f"CREATE TEMP TABLE autocut_buildings AS SELECT * FROM read_parquet('{FIXTURE / f'{zip5}.parquet'}')")
    return conn


def _stats(conn: duckdb.DuckDBPyConnection) -> dict:
    """Everything measured on drafts, doors counted by containment like the cutter's sidebar."""
    cap, floor = autocut._CAP * TARGET, autocut._FLOOR * TARGET
    row = conn.execute(f"""
        WITH b AS (
            SELECT b.building_id, b.doors, t.turf, ST_Point(b.longitude, b.latitude) AS pt
            FROM autocut_buildings b LEFT JOIN autocut_turfs t USING (building_id)
        ),
        hits AS (
            SELECT b.building_id, b.doors, b.turf AS own, p.turf AS got, p.number
            FROM b LEFT JOIN autocut_polygons p ON ST_Contains(p.geom, b.pt)
        ),
        per_building AS (
            SELECT building_id, any_value(own) AS own, count(number) AS n, bool_or(got <> own) AS wrong
            FROM hits GROUP BY building_id
        ),
        drafts AS (
            SELECT p.number, coalesce(sum(h.doors), 0) AS d, coalesce(max(h.doors), 0) AS biggest
            FROM autocut_polygons p LEFT JOIN hits h USING (number) GROUP BY p.number
        ),
        m AS (SELECT number, ST_Transform(geom, 'EPSG:4326', 'EPSG:32618', true) AS g FROM autocut_polygons),
        overlap AS (
            SELECT coalesce(sum(ST_Area(ST_Intersection(a.g, b.g))), 0) AS m2
            FROM m a JOIN m b ON a.number < b.number AND ST_Intersects(a.g, b.g)
        )
        SELECT (SELECT count(*) FROM drafts) AS drafts,
               (SELECT count(*) FROM drafts) - (SELECT count(DISTINCT turf) FROM autocut_turfs) AS split,
               (SELECT [round(x)::INT FOR x IN quantile_cont(d, [0.1, 0.5, 0.9])] FROM drafts) AS pct,
               (SELECT min(d) FROM drafts) AS smallest,
               (SELECT round(100 * count(*) FILTER (WHERE d BETWEEN {0.75 * TARGET} AND {1.25 * TARGET}) / count(*))
                FROM drafts) AS within,
               -- over the cap for a reason other than one building bigger than the cap
               (SELECT count(*) FILTER (WHERE d > {cap} AND d > biggest) FROM drafts) AS over_cap,
               (SELECT coalesce(sum(doors), 0) FROM b WHERE turf IS NULL) AS uncut_doors,
               (SELECT count(*) FROM per_building WHERE own IS NOT NULL AND n = 0) AS lost,
               (SELECT count(*) FROM per_building WHERE wrong) AS moved,
               (SELECT count(*) FROM per_building WHERE n > 1) AS double,
               (SELECT count(*) FROM drafts WHERE d = 0) AS empty,
               (SELECT round(m2) FROM overlap) AS overlap_m2,
               (SELECT count(*) FROM autocut_polygons WHERE ST_NumInteriorRings(geom) > 0) AS holes,
               (SELECT median(ST_NPoints(geom))::INT FROM autocut_polygons) AS v_med,
               (SELECT max(ST_NPoints(geom)) FROM autocut_polygons) AS v_max
    """).fetchone()
    keys = [
        "drafts",
        "split",
        "pct",
        "smallest",
        "within",
        "over_cap",
        "uncut_doors",
        "lost",
        "moved",
        "double",
        "empty",
        "overlap_m2",
        "holes",
        "v_med",
        "v_max",
    ]
    out = dict(zip(keys, row, strict=True))
    out["floor"] = floor
    return out


@pytest.fixture(scope="module", params=list(ZIPS), ids=list(ZIPS.values()))
def cut(request):
    zip5 = request.param
    if not (FIXTURE / f"{zip5}.parquet").exists():
        pytest.skip(f"No autocut fixture at {FIXTURE}; write it with `python -m scripts.autocut_fixture`.")
    conn = _connect(zip5)
    t = time.time()
    autocut.cut(conn, TARGET)
    autocut._trade(conn, TARGET)
    autocut._build_polygons(conn)
    autocut._absorb_islands(conn)
    autocut._order_drafts(conn, "northwest")
    seconds = time.time() - t
    stats = _stats(conn)
    conn.close()
    return zip5, stats, seconds


def test_every_building_is_in_exactly_its_own_draft(cut):
    _, s, _ = cut
    assert (s["lost"], s["moved"], s["double"]) == (0, 0, 0)


def test_drafts_tile_without_overlap_or_holes(cut):
    _, s, _ = cut
    assert (s["overlap_m2"], s["holes"], s["empty"]) == (0, 0, 0)


def test_one_draft_per_turf_and_nothing_uncut(cut):
    _, s, _ = cut
    assert (s["split"], s["uncut_doors"]) == (0, 0)


def test_no_draft_under_the_floor(cut):
    _, s, _ = cut
    assert s["smallest"] >= s["floor"]


def test_quality_matches_golden(cut):
    zip5, s, _ = cut
    got = (s["drafts"], tuple(s["pct"]), s["smallest"], int(s["within"]), s["over_cap"], s["v_med"], s["v_max"])
    assert got == GOLDEN[zip5], f"{ZIPS[zip5]}: {got}"


def test_stays_inside_the_time_budget(cut):
    zip5, _, seconds = cut
    assert seconds < TIME_BUDGET_S, f"{ZIPS[zip5]} took {seconds:.1f}s"
