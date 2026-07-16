"""Full-pipeline integration test.

Runs the same DAG `seed-persons` runs — `voter_file_loader` → `tiger` →
`osm` → `matching` → `geocode` → `assembly` → `aggregate` — against the
full NYC voter fixture (`ny-voters-2026-03-08-nyc.parquet`, ~5.4M
voters) in an isolated tempdir DuckLake.

Asserts:

  - Exact-match golden counts captured from a known-good run, so any
    behavior change (intentional or not) trips the test and forces an
    explicit re-baseline.
  - Strict structural invariants (every row keyed correctly, no NULL
    coords, no duplicate building dots, etc.) that should always hold
    regardless of the version baseline.

Marked `@pytest.mark.integration` so the default suite skips it
(see `pnpm data:test` vs `pnpm data:test:integration`).

Caches:
  - TIGER shapefiles under `apps/data/tiger_cache/` (~30 MB per county).
  - OSM PBF + buildings extract under `apps/data/osm_cache/` (~500 MB
    download on first run, then a cache hit).
"""

import tempfile
from pathlib import Path

import pytest
from hamilton import driver

import duckdb
from src.dags import aggregate, assembly, geocode, matching, osm, tiger
from src.import_progress import NullProgress
from src.importers.nys_voter_file import NysVoterFileImporter

VOTER_FILE = Path(__file__).resolve().parents[1] / "fixtures" / "ny-voters-2026-03-08-nyc.parquet"


# Golden numbers captured 2026-05-17 against the full NYC fixture.
# Re-baseline (with an explanation in the PR description) when an
# intentional pipeline change shifts them.
GOLDEN = {
    "total_persons": 5_360_017,
    "matched": 5_281_714,
    "unmatched": 78_303,
    "match_pct": 98.54,
    "matched_osm_road_projected": 3_811_666,
    "matched_osm_complex": 709_962,
    "matched_osm_off_segment": 110_021,
    "matched_tiger_only": 564_019,
    "matched_osm_only": 86_046,
    "buildings": 763_527,
    "doors": 3_026_868,
}

# Widened NYC envelope. The narrower commonly-cited bbox (-74.3 to -73.7)
# clips the easternmost edge of the Bronx / City Island where some real
# voters live. Lat 40.4-41.0, lon -74.3 to -73.5 covers all of NYC.
NYC_LAT_MIN, NYC_LAT_MAX = 40.4, 41.0
NYC_LON_MIN, NYC_LON_MAX = -74.3, -73.5

ALLOWED_POSITION_SOURCES = {
    "osm_matched",
    "osm_complex",
    "osm_off_segment",
    "tiger_only",
    "osm_only",
}


@pytest.fixture(scope="module")
def nyc_pipeline(tiger_cache_dir, osm_cache_dir):
    """Run the full NYC pipeline once for the whole module. Module-scoped
    so all assertions share one pipeline run."""
    if not VOTER_FILE.exists():
        pytest.skip(
            f"Voter fixture not present at {VOTER_FILE}. Pull from object "
            "storage or regenerate via `uv run python scripts/sample_voter_file.py`."
        )

    with tempfile.TemporaryDirectory() as tmpdir:
        conn = duckdb.connect()
        conn.install_extension("ducklake")
        conn.load_extension("ducklake")
        conn.install_extension("spatial")
        conn.load_extension("spatial")
        # Isolated tempdir DuckLakes — never touch the dev catalog.
        conn.execute(f"ATTACH 'ducklake:{tmpdir}/voter.ducklake' AS ducklake (DATA_PATH '{tmpdir}/voter_data/')")
        conn.execute(f"ATTACH 'ducklake:{tmpdir}/geo.ducklake' AS geo_ducklake (DATA_PATH '{tmpdir}/geo_data/')")
        conn.execute("USE ducklake")

        persons_validated = NysVoterFileImporter().load(str(VOTER_FILE), "default", conn, NullProgress())
        dr = (
            driver.Builder()
            .with_modules(
                tiger,
                osm,
                matching,
                geocode,
                assembly,
                aggregate,
            )
            .build()
        )
        dr.execute(
            final_vars=["persons_geocoded", "geocoding_summary", "buildings_geocoded", "doors_geocoded"],
            inputs={
                "persons_validated": persons_validated,
                "schema": "default",
                "tiger_year": "2024",
                "tiger_state_fips": "36",
                # All five NYC counties — matches the seed-persons default.
                "tiger_county_fips": ["061", "005", "047", "081", "085"],
                "tiger_data_dir": tiger_cache_dir,
                "osm_url": ("https://download.geofabrik.de/north-america/us/new-york-260501.osm.pbf"),
                "osm_data_dir": osm_cache_dir,
                "conn": conn,
            },
        )
        yield conn
        conn.close()


# Module-level mark so every test in this file is gated on -m integration.
pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# Golden numbers — exact match on a known-good baseline
# ---------------------------------------------------------------------------


def test_geocoding_summary_matches_baseline(nyc_pipeline):
    """`geocoding_summary` per-source counts and totals match the locked
    baseline. Any pipeline change that shifts a number trips this."""
    row = nyc_pipeline.execute("""
        SELECT total_persons, matched, unmatched, match_pct,
               matched_osm_road_projected, matched_osm_complex,
               matched_osm_off_segment, matched_tiger_only, matched_osm_only
        FROM ducklake."default".geocoding_summary
    """).fetchone()
    (total, matched, unmatched, match_pct, m_road, m_complex, m_off, m_tiger, m_osm_only) = row
    assert total == GOLDEN["total_persons"]
    assert matched == GOLDEN["matched"]
    assert unmatched == GOLDEN["unmatched"]
    assert match_pct == GOLDEN["match_pct"]
    assert m_road == GOLDEN["matched_osm_road_projected"]
    assert m_complex == GOLDEN["matched_osm_complex"]
    assert m_off == GOLDEN["matched_osm_off_segment"]
    assert m_tiger == GOLDEN["matched_tiger_only"]
    assert m_osm_only == GOLDEN["matched_osm_only"]


def test_table_row_counts_match_baseline(nyc_pipeline):
    """`persons_geocoded`, `buildings_geocoded`, `doors_geocoded` row
    counts match the baseline."""
    persons = nyc_pipeline.execute('SELECT count(*) FROM ducklake."default".persons_geocoded').fetchone()[0]
    buildings = nyc_pipeline.execute('SELECT count(*) FROM ducklake."default".buildings_geocoded').fetchone()[0]
    doors = nyc_pipeline.execute('SELECT count(*) FROM ducklake."default".doors_geocoded').fetchone()[0]
    assert persons == GOLDEN["matched"]  # persons_geocoded == matched
    assert buildings == GOLDEN["buildings"]
    assert doors == GOLDEN["doors"]


# ---------------------------------------------------------------------------
# Structural invariants — should always hold
# ---------------------------------------------------------------------------


def test_no_duplicate_buildings_at_same_coords(nyc_pipeline):
    """Two voters at the exact same `(latitude, longitude, zip5)` must
    share a `building_id`. The native app renders one dot per building
    and shows its residents; overlapping distinct buildings would stack
    invisibly. This is the strictest definition of "real dupe."
    """
    n = nyc_pipeline.execute("""
        SELECT count(*) FROM (
          SELECT latitude, longitude, zip5
          FROM ducklake."default".persons_geocoded
          WHERE latitude IS NOT NULL AND longitude IS NOT NULL
          GROUP BY 1, 2, 3
          HAVING count(DISTINCT building_id) > 1
        )
    """).fetchone()[0]
    assert n == 0, f"{n} coord clusters share two or more building_ids"


def test_persons_geocoded_unique_by_external_id(nyc_pipeline):
    total, distinct = nyc_pipeline.execute("""
        SELECT count(*), count(DISTINCT external_id)
        FROM ducklake."default".persons_geocoded
    """).fetchone()
    assert total == distinct


def test_every_person_has_position_source(nyc_pipeline):
    null_count = nyc_pipeline.execute("""
        SELECT count(*) FROM ducklake."default".persons_geocoded
        WHERE position_source IS NULL
    """).fetchone()[0]
    assert null_count == 0


def test_position_source_values_in_allowed_enum(nyc_pipeline):
    sources = {
        r[0]
        for r in nyc_pipeline.execute("""
            SELECT DISTINCT position_source
            FROM ducklake."default".persons_geocoded
        """).fetchall()
    }
    unexpected = sources - ALLOWED_POSITION_SOURCES
    assert not unexpected, f"unknown position_source values: {unexpected}"


def test_all_coords_in_nyc_envelope(nyc_pipeline):
    """No matched person should land outside the widened NYC bbox."""
    n = nyc_pipeline.execute(f"""
        SELECT count(*) FROM ducklake."default".persons_geocoded
        WHERE latitude  IS NULL OR longitude IS NULL
           OR latitude  NOT BETWEEN {NYC_LAT_MIN} AND {NYC_LAT_MAX}
           OR longitude NOT BETWEEN {NYC_LON_MIN} AND {NYC_LON_MAX}
    """).fetchone()[0]
    assert n == 0


def test_no_zero_person_buildings(nyc_pipeline):
    n = nyc_pipeline.execute("""
        SELECT count(*) FROM ducklake."default".buildings_geocoded
        WHERE person_count = 0
    """).fetchone()[0]
    assert n == 0


def test_building_person_count_reconciles(nyc_pipeline):
    """sum(building.person_count) must equal persons_geocoded row count —
    every matched person counted exactly once, in exactly one building."""
    total = nyc_pipeline.execute("""
        SELECT sum(person_count) FROM ducklake."default".buildings_geocoded
    """).fetchone()[0]
    assert total == GOLDEN["matched"]


def test_door_person_count_reconciles(nyc_pipeline):
    total = nyc_pipeline.execute("""
        SELECT sum(person_count) FROM ducklake."default".doors_geocoded
    """).fetchone()[0]
    assert total == GOLDEN["matched"]


def test_address_line_1_is_well_formed(nyc_pipeline):
    """Every `address_line_1` must be non-empty, fully uppercase, start
    with a digit, and contain at least one letter."""
    counts = nyc_pipeline.execute("""
        SELECT
          count(*) FILTER (WHERE address_line_1 IS NULL OR address_line_1 = '')           AS null_or_empty,
          count(*) FILTER (WHERE address_line_1 != UPPER(address_line_1))                  AS not_upper,
          count(*) FILTER (WHERE NOT regexp_matches(address_line_1, '^[0-9]'))             AS no_leading_digit,
          count(*) FILTER (WHERE NOT regexp_matches(address_line_1, '[A-Z]'))              AS no_letter
        FROM ducklake."default".persons_geocoded
    """).fetchone()
    null_or_empty, not_upper, no_leading_digit, no_letter = counts
    assert null_or_empty == 0, f"{null_or_empty} address_line_1 rows are null/empty"
    assert not_upper == 0, f"{not_upper} address_line_1 rows are not fully uppercase"
    assert no_leading_digit == 0, f"{no_leading_digit} address_line_1 rows don't start with a digit"
    assert no_letter == 0, f"{no_letter} address_line_1 rows contain no letters"


def test_building_and_door_keys_match_canonical_format(nyc_pipeline):
    """`building_id` == `address_line_1 || '|' || zip5`;
    `door_id` == `address_line_1 || '|' || COALESCE(address_line_2, '') || '|' || zip5`.

    Catches assembly bugs where the derived keys drift from the canonical
    address (which would silently fragment buildings/doors in the admin UI).
    """
    bad = nyc_pipeline.execute("""
        SELECT
          count(*) FILTER (WHERE building_id != address_line_1 || '|' || zip5) AS bad_building,
          count(*) FILTER (
            WHERE door_id != address_line_1 || '|' || COALESCE(address_line_2, '') || '|' || zip5
          ) AS bad_door
        FROM ducklake."default".persons_geocoded
    """).fetchone()
    assert bad == (0, 0)


# ---------------------------------------------------------------------------
# voter-file extraction — shape/content sanity for the promoted columns
# ---------------------------------------------------------------------------


def test_promoted_voter_fields_present(nyc_pipeline):
    """The canonical voter-file scalars and voting_history are top-level
    columns on persons_geocoded."""
    row = nyc_pipeline.execute("""
        SELECT
          count(*) FILTER (WHERE enrollment           IS NOT NULL) AS has_enrollment,
          count(*) FILTER (WHERE registration_status  IS NOT NULL) AS has_reg_status,
          count(*) FILTER (WHERE registration_date    IS NOT NULL) AS has_reg_date,
          count(*) FILTER (WHERE voting_history       IS NOT NULL) AS has_voting_history,
          count(*) AS total
        FROM ducklake."default".persons_geocoded
    """).fetchone()
    has_enrollment, has_reg_status, has_reg_date, has_voting_history, total = row
    assert has_enrollment > 0.99 * total, f"{has_enrollment}/{total} have enrollment"
    assert has_reg_status == total
    assert has_reg_date == total
    assert has_voting_history == total  # empty list also counts as present


def test_dates_are_iso_8601(nyc_pipeline):
    """date_of_birth, registration_date, last_voted_date all match YYYY-MM-DD."""
    iso = r"'^\d{4}-\d{2}-\d{2}$'"
    bad = nyc_pipeline.execute(f"""
        SELECT
          count(*) FILTER (WHERE date_of_birth IS NOT NULL
                             AND date_of_birth !~ {iso}) AS bad_dob,
          count(*) FILTER (WHERE registration_date IS NOT NULL
                             AND registration_date !~ {iso}) AS bad_reg,
          count(*) FILTER (WHERE last_voted_date IS NOT NULL
                             AND last_voted_date !~ {iso}) AS bad_last_voted
        FROM ducklake."default".persons_geocoded
    """).fetchone()
    assert bad == (0, 0, 0)


def test_enrollment_values_in_canonical_enum(nyc_pipeline):
    """enrollment only takes documented canonical labels."""
    allowed = {
        "democratic",
        "republican",
        "conservative",
        "working_families",
        "independence",
        "green",
        "libertarian",
        "reform",
        "unaffiliated",
        "other",
    }
    rows = nyc_pipeline.execute("""
        SELECT DISTINCT enrollment
        FROM ducklake."default".persons_geocoded
        WHERE enrollment IS NOT NULL
    """).fetchall()
    seen = {r[0] for r in rows}
    unexpected = seen - allowed
    assert not unexpected, f"unexpected enrollment values: {unexpected}"
