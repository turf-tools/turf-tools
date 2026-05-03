"""Tests for the three Hamilton graphs: voter_file_loader, tiger, geocode.

Runs against a deterministic NYC-wide sample of the full NY voter file
(2,000 rows per borough × 5 boroughs = 10,000 rows), stored at
``fixtures/ny-voters-2026-03-08-10k-sample.parquet``. Regenerate with
``scripts/sample_voter_file.py`` if the source upstream changes.

The tests in this file filter the sample to Manhattan (county_code='31')
via the transformation query's WHERE clause and match against Manhattan
TIGER. Cross-borough coverage lives in ``test_boroughs.py``.

Graph 2 (tiger) downloads TIGER data for New York County (Manhattan, FIPS
061) into a pytest session tmpdir — cached for the session.
"""

from pathlib import Path

import pytest
from hamilton import driver

from src.dags import aggregate, geocode, tiger, voter_file_loader

VOTER_FILE_URL = str(Path(__file__).resolve().parents[1] / "fixtures" / "ny-voters-2026-03-08-10k-sample.parquet")

# Manhattan TIGER params — single county (New York County, FIPS 061)
TEST_STATE_FIPS = "36"
TEST_COUNTY_FIPS = ["061"]
TEST_TIGER_YEAR = "2024"

# Transformation query: all Manhattan voters (county_code = '31').
TRANSFORMATION_QUERY = """
SELECT
    raw.sboe_id AS external_id,
    'ny_sboe' AS external_id_type,
    raw.first_name,
    raw.last_name,
    concat_ws(
        ' ',
        nullif(raw.res_house_number, ''),
        nullif(raw.res_half_code, ''),
        nullif(raw.res_pre_direction, ''),
        nullif(raw.res_street_name, ''),
        nullif(raw.res_post_direction, '')
    ) AS address_line_1,
    CASE
        WHEN raw.res_apartment IS NOT NULL AND raw.res_apartment != ''
        THEN concat_ws(' ', nullif(raw.res_apartment_type, ''), raw.res_apartment)
        ELSE NULL
    END AS address_line_2,
    raw.res_city AS city,
    'NY' AS state,
    raw.res_zip5 AS zip5,
    nullif(raw.res_zip4, '') AS zip4,
    to_json(
        {
            county_code: raw.county_code,
            status: raw.status
        }
    ) AS other_properties
FROM raw
WHERE raw.county_code = '31'
"""


# ---------------------------------------------------------------------------
# Session-scoped TIGER cache directory so the shapefile download only happens
# once per test session.
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def tiger_cache_dir(tmp_path_factory):
    """Persistent-within-session directory for cached TIGER shapefiles."""
    return str(tmp_path_factory.mktemp("tiger_cache"))


# ---------------------------------------------------------------------------
# Graph 1 — voter_file_loader
# ---------------------------------------------------------------------------


class TestVoterFileLoader:
    def test_raw_voter_data_loads(self, dual_conn):
        """voters_raw should create a table in ducklake and return a TableRef."""
        ref = voter_file_loader.voters_raw(
            voter_file_url=VOTER_FILE_URL,
            organization_slug="test",
            conn=dual_conn,
        )
        assert ref.catalog == "ducklake"
        assert ref.table == "test_voters_raw"
        count = dual_conn.table(ref.fqn).aggregate("count(*)").fetchone()[0]
        assert count > 0

    def test_transformation_produces_person_schema(self, dual_conn):
        """persons should produce the Person columns."""
        raw_ref = voter_file_loader.voters_raw(
            voter_file_url=VOTER_FILE_URL,
            organization_slug="test",
            conn=dual_conn,
        )
        transformed_ref = voter_file_loader.persons_transformed(
            voters_raw=raw_ref,
            transformation_query=TRANSFORMATION_QUERY,
            organization_slug="test",
            conn=dual_conn,
        )
        rel = dual_conn.table(transformed_ref.fqn)
        cols = set(rel.columns)
        assert "external_id" in cols
        assert "address_line_1" in cols
        assert "zip5" in cols
        assert "first_name" in cols

    def test_validated_persons_passes(self, dual_conn):
        """persons_validated should return the same TableRef when schema is correct."""
        raw_ref = voter_file_loader.voters_raw(
            voter_file_url=VOTER_FILE_URL,
            organization_slug="test",
            conn=dual_conn,
        )
        transformed_ref = voter_file_loader.persons_transformed(
            voters_raw=raw_ref,
            transformation_query=TRANSFORMATION_QUERY,
            organization_slug="test",
            conn=dual_conn,
        )
        validated_ref = voter_file_loader.persons_validated(
            persons_transformed=transformed_ref,
            conn=dual_conn,
        )
        assert validated_ref.fqn == transformed_ref.fqn

    def test_full_graph_via_hamilton_driver(self, dual_conn):
        """Hamilton driver should execute the full voter_file_loader graph."""
        dr = driver.Builder().with_modules(voter_file_loader).build()
        result = dr.execute(
            final_vars=["persons_validated"],
            inputs={
                "voter_file_url": VOTER_FILE_URL,
                "organization_slug": "test_driver",
                "transformation_query": TRANSFORMATION_QUERY,
                "conn": dual_conn,
            },
        )
        ref = result["persons_validated"]
        count = dual_conn.table(ref.fqn).aggregate("count(*)").fetchone()[0]
        assert count > 0


# ---------------------------------------------------------------------------
# Graph 2 — tiger
# ---------------------------------------------------------------------------


class TestTigerGraph:
    def test_address_token_table(self, dual_conn):
        """address_tokens should populate the equivalency groups table."""
        ref = tiger.address_tokens(conn=dual_conn)
        assert ref.catalog == "geo_ducklake"
        assert ref.table == "address_tokens"
        count = dual_conn.table(ref.fqn).aggregate("count(*)").fetchone()[0]
        from src.address_tokens import EQUIVALENT_TOKEN_GROUPS

        assert count == len(EQUIVALENT_TOKEN_GROUPS)

    def test_address_token_table_idempotent(self, dual_conn):
        """Running address_tokens twice should not duplicate rows."""
        tiger.address_tokens(conn=dual_conn)
        ref = tiger.address_tokens(conn=dual_conn)
        from src.address_tokens import EQUIVALENT_TOKEN_GROUPS

        count = dual_conn.table(ref.fqn).aggregate("count(*)").fetchone()[0]
        assert count == len(EQUIVALENT_TOKEN_GROUPS)

    def test_tiger_addrfeat_raw_downloads_and_loads(self, dual_conn, tiger_cache_dir):
        """tiger_addrfeat_raw should download shapefiles and populate the table."""
        ref = tiger.tiger_addrfeat_raw(
            tiger_year=TEST_TIGER_YEAR,
            tiger_state_fips=TEST_STATE_FIPS,
            tiger_county_fips=TEST_COUNTY_FIPS,
            tiger_data_dir=tiger_cache_dir,
            conn=dual_conn,
        )
        assert ref.catalog == "geo_ducklake"
        assert ref.table == "addrfeat"
        count = dual_conn.table(ref.fqn).aggregate("count(*)").fetchone()[0]
        assert count > 0
        # Spot-check expected columns
        cols = set(dual_conn.table(ref.fqn).columns)
        assert "tiger_line_id" in cols
        assert "street_name_tokens" in cols
        assert "left_from_house_num" in cols

    def test_tiger_addrfeat_raw_idempotent(self, dual_conn, tiger_cache_dir):
        """Re-running tiger_addrfeat_raw for the same county should not insert duplicates."""
        ref1 = tiger.tiger_addrfeat_raw(
            tiger_year=TEST_TIGER_YEAR,
            tiger_state_fips=TEST_STATE_FIPS,
            tiger_county_fips=TEST_COUNTY_FIPS,
            tiger_data_dir=tiger_cache_dir,
            conn=dual_conn,
        )
        count1 = dual_conn.table(ref1.fqn).aggregate("count(*)").fetchone()[0]
        ref2 = tiger.tiger_addrfeat_raw(
            tiger_year=TEST_TIGER_YEAR,
            tiger_state_fips=TEST_STATE_FIPS,
            tiger_county_fips=TEST_COUNTY_FIPS,
            tiger_data_dir=tiger_cache_dir,
            conn=dual_conn,
        )
        count2 = dual_conn.table(ref2.fqn).aggregate("count(*)").fetchone()[0]
        assert count1 == count2

    def test_tiger_edges_raw_downloads_and_loads(self, dual_conn, tiger_cache_dir):
        """tiger_edges_raw should download edge shapefiles and populate the table."""
        ref = tiger.tiger_edges_raw(
            tiger_year=TEST_TIGER_YEAR,
            tiger_state_fips=TEST_STATE_FIPS,
            tiger_county_fips=TEST_COUNTY_FIPS,
            tiger_data_dir=tiger_cache_dir,
            conn=dual_conn,
        )
        assert ref.catalog == "geo_ducklake"
        assert ref.table == "edges"
        count = dual_conn.table(ref.fqn).aggregate("count(*)").fetchone()[0]
        assert count > 0
        cols = set(dual_conn.table(ref.fqn).columns)
        assert "from_node_id" in cols
        assert "to_node_id" in cols
        assert "tiger_line_id" in cols

    def test_blockface_unpivoted(self, dual_conn, tiger_cache_dir):
        """blockface_unpivoted should produce left and right rows from addrfeat."""
        addrfeat_ref = tiger.tiger_addrfeat_raw(
            tiger_year=TEST_TIGER_YEAR,
            tiger_state_fips=TEST_STATE_FIPS,
            tiger_county_fips=TEST_COUNTY_FIPS,
            tiger_data_dir=tiger_cache_dir,
            conn=dual_conn,
        )
        edges_ref = tiger.tiger_edges_raw(
            tiger_year=TEST_TIGER_YEAR,
            tiger_state_fips=TEST_STATE_FIPS,
            tiger_county_fips=TEST_COUNTY_FIPS,
            tiger_data_dir=tiger_cache_dir,
            conn=dual_conn,
        )
        ref = tiger.blockface_unpivoted(
            tiger_addrfeat_raw=addrfeat_ref,
            tiger_edges_raw=edges_ref,
            conn=dual_conn,
        )
        assert ref.table == "blockface_unpivoted"
        count = dual_conn.table(ref.fqn).aggregate("count(*)").fetchone()[0]
        assert count > 0
        # Should have both sides
        sides = {r[0] for r in dual_conn.execute(f"SELECT DISTINCT side FROM {ref.fqn}").fetchall()}
        assert "left" in sides
        assert "right" in sides

    def test_blockface_normalized(self, dual_conn, tiger_cache_dir):
        """blockface_normalized should produce integer house numbers and number_type."""
        addrfeat_ref = tiger.tiger_addrfeat_raw(
            tiger_year=TEST_TIGER_YEAR,
            tiger_state_fips=TEST_STATE_FIPS,
            tiger_county_fips=TEST_COUNTY_FIPS,
            tiger_data_dir=tiger_cache_dir,
            conn=dual_conn,
        )
        edges_ref = tiger.tiger_edges_raw(
            tiger_year=TEST_TIGER_YEAR,
            tiger_state_fips=TEST_STATE_FIPS,
            tiger_county_fips=TEST_COUNTY_FIPS,
            tiger_data_dir=tiger_cache_dir,
            conn=dual_conn,
        )
        unpivoted_ref = tiger.blockface_unpivoted(
            tiger_addrfeat_raw=addrfeat_ref,
            tiger_edges_raw=edges_ref,
            conn=dual_conn,
        )
        ref = tiger.blockface_normalized(
            blockface_unpivoted=unpivoted_ref,
            conn=dual_conn,
        )
        assert ref.table == "blockface_normalized"
        count = dual_conn.table(ref.fqn).aggregate("count(*)").fetchone()[0]
        assert count > 0
        # All number_type values should be odd/even/mixed
        bad = dual_conn.execute(
            f"SELECT count(*) FROM {ref.fqn} WHERE number_type NOT IN ('odd','even','mixed')"
        ).fetchone()[0]
        assert bad == 0
        # No NULL house numbers
        null_nums = dual_conn.execute(
            f"SELECT count(*) FROM {ref.fqn} WHERE from_house_num IS NULL OR to_house_num IS NULL"
        ).fetchone()[0]
        assert null_nums == 0

    def test_blockface_final(self, dual_conn, tiger_cache_dir):
        """blockface_final should have expanded tokens and cover all normalized rows."""
        addrfeat_ref = tiger.tiger_addrfeat_raw(
            tiger_year=TEST_TIGER_YEAR,
            tiger_state_fips=TEST_STATE_FIPS,
            tiger_county_fips=TEST_COUNTY_FIPS,
            tiger_data_dir=tiger_cache_dir,
            conn=dual_conn,
        )
        edges_ref = tiger.tiger_edges_raw(
            tiger_year=TEST_TIGER_YEAR,
            tiger_state_fips=TEST_STATE_FIPS,
            tiger_county_fips=TEST_COUNTY_FIPS,
            tiger_data_dir=tiger_cache_dir,
            conn=dual_conn,
        )
        unpivoted_ref = tiger.blockface_unpivoted(
            tiger_addrfeat_raw=addrfeat_ref,
            tiger_edges_raw=edges_ref,
            conn=dual_conn,
        )
        normalized_ref = tiger.blockface_normalized(
            blockface_unpivoted=unpivoted_ref,
            conn=dual_conn,
        )
        token_ref = tiger.address_tokens(conn=dual_conn)
        ref = tiger.blockface_final(
            blockface_normalized=normalized_ref,
            address_tokens=token_ref,
            conn=dual_conn,
        )
        assert ref.table == "blockface_final"
        final_count = dual_conn.table(ref.fqn).aggregate("count(*)").fetchone()[0]
        norm_count = dual_conn.table(normalized_ref.fqn).aggregate("count(*)").fetchone()[0]
        assert final_count == norm_count

    def test_full_tiger_graph_via_hamilton_driver(self, dual_conn, tiger_cache_dir):
        """Hamilton driver should execute the full tiger DAG."""
        dr = driver.Builder().with_modules(tiger).build()
        result = dr.execute(
            final_vars=["blockface_final"],
            inputs={
                "tiger_year": TEST_TIGER_YEAR,
                "tiger_state_fips": TEST_STATE_FIPS,
                "tiger_county_fips": TEST_COUNTY_FIPS,
                "tiger_data_dir": tiger_cache_dir,
                "conn": dual_conn,
            },
        )
        ref = result["blockface_final"]
        count = dual_conn.table(ref.fqn).aggregate("count(*)").fetchone()[0]
        assert count > 0


# ---------------------------------------------------------------------------
# Graph 3 — geocode (end-to-end with Graphs 1 + 2)
# ---------------------------------------------------------------------------


class TestGeocodeGraph:
    """End-to-end tests wiring all three graphs together.

    These are the slowest tests: they load Manhattan persons from object
    storage AND download TIGER shapefiles. They're placed last so earlier
    failures surface quickly.
    """

    @pytest.fixture()
    def persons_validated(self, dual_conn):
        """Run Graph 1 and return persons_validated TableRef."""
        dr = driver.Builder().with_modules(voter_file_loader).build()
        result = dr.execute(
            final_vars=["persons_validated"],
            inputs={
                "voter_file_url": VOTER_FILE_URL,
                "organization_slug": "geocode_test",
                "transformation_query": TRANSFORMATION_QUERY,
                "conn": dual_conn,
            },
        )
        return result["persons_validated"]

    @pytest.fixture()
    def blockfaces(self, dual_conn, tiger_cache_dir):
        """Run Graph 2 and return blockface_final TableRef."""
        dr = driver.Builder().with_modules(tiger).build()
        result = dr.execute(
            final_vars=["blockface_final"],
            inputs={
                "tiger_year": TEST_TIGER_YEAR,
                "tiger_state_fips": TEST_STATE_FIPS,
                "tiger_county_fips": TEST_COUNTY_FIPS,
                "tiger_data_dir": tiger_cache_dir,
                "conn": dual_conn,
            },
        )
        return result["blockface_final"]

    @pytest.fixture()
    def address_tokens(self, dual_conn):
        """Populate the address-token equivalence table (idempotent)."""
        return tiger.address_tokens(conn=dual_conn)

    def test_decomposed_persons(self, dual_conn, persons_validated):
        """persons_decomposed should parse house numbers and tokens."""
        ref = geocode.persons_decomposed(
            persons_validated=persons_validated,
            organization_slug="geocode_test",
            conn=dual_conn,
        )
        assert ref.table == "geocode_test_persons_decomposed"
        count = dual_conn.table(ref.fqn).aggregate("count(*)").fetchone()[0]
        assert count > 0
        cols = set(dual_conn.table(ref.fqn).columns)
        assert "house_number" in cols
        assert "street_name_tokens" in cols
        assert "number_type" in cols
        # All number_type values should be odd or even (persons have parseable house nums)
        bad = dual_conn.execute(f"SELECT count(*) FROM {ref.fqn} WHERE number_type NOT IN ('odd','even')").fetchone()[0]
        assert bad == 0

    def test_candidate_blockfaces(self, dual_conn, persons_validated, blockfaces):
        """persons_candidates should produce person–blockface pairs."""
        decomposed_ref = geocode.persons_decomposed(
            persons_validated=persons_validated,
            organization_slug="geocode_test",
            conn=dual_conn,
        )
        ref = geocode.persons_candidates(
            persons_decomposed=decomposed_ref,
            blockface_final=blockfaces,
            organization_slug="geocode_test",
            conn=dual_conn,
        )
        assert ref.table == "geocode_test_persons_candidates"
        count = dual_conn.table(ref.fqn).aggregate("count(*)").fetchone()[0]
        assert count > 0

    def test_persons_geocoded_match_rate(self, dual_conn, persons_validated, blockfaces, address_tokens):
        """Full geocode pipeline should achieve a reasonable match rate for Manhattan."""
        dr = driver.Builder().with_modules(geocode).build()
        result = dr.execute(
            final_vars=["geocoding_summary"],
            inputs={
                "persons_validated": persons_validated,
                "blockface_final": blockfaces,
                "address_tokens": address_tokens,
                "organization_slug": "geocode_test",
                "conn": dual_conn,
            },
        )
        summary_ref = result["geocoding_summary"]
        row = dual_conn.table(summary_ref.fqn).fetchone()
        total, matched, unmatched, match_pct, blockface_matches = row
        print(f"\nGeocoding summary: {matched}/{total} matched ({match_pct}%)")
        assert total > 0
        assert matched > 0
        # Expect at least 50% match rate for Manhattan against Manhattan TIGER
        assert match_pct >= 50.0

    def test_persons_geocoded_have_valid_coordinates(self, dual_conn, persons_validated, blockfaces, address_tokens):
        """Every row in persons_geocoded should have plausible NYC lat/lon
        coordinates — the table now contains only matched persons (INNER
        JOIN), so any bad coords would be a real bug."""
        dr = driver.Builder().with_modules(geocode).build()
        dr.execute(
            final_vars=["persons_geocoded"],
            inputs={
                "persons_validated": persons_validated,
                "blockface_final": blockfaces,
                "address_tokens": address_tokens,
                "organization_slug": "geocode_test",
                "conn": dual_conn,
            },
        )
        geocoded_fqn = "ducklake.main.geocode_test_persons_geocoded"
        bad_coords = dual_conn.execute(f"""
            SELECT count(*) FROM {geocoded_fqn}
            WHERE latitude  IS NULL OR longitude IS NULL
               OR latitude  NOT BETWEEN 40.4  AND 41.0
               OR longitude NOT BETWEEN -74.3 AND -73.7
        """).fetchone()[0]
        assert bad_coords == 0

    def test_persons_geocoded_idempotent(self, dual_conn, persons_validated, blockfaces, address_tokens):
        """Running persons_geocoded twice should produce the same row count.

        The function now drops and recreates on every run rather than
        appending — schema changes are routine while the canonical persons
        table is still being shaped — so "idempotent" here means "stable
        final state," not "incremental no-op."
        """
        inputs = {
            "persons_validated": persons_validated,
            "blockface_final": blockfaces,
            "address_tokens": address_tokens,
            "organization_slug": "geocode_test",
            "conn": dual_conn,
        }
        dr = driver.Builder().with_modules(geocode).build()
        dr.execute(final_vars=["persons_geocoded"], inputs=inputs)
        count1 = dual_conn.execute("SELECT count(*) FROM ducklake.main.geocode_test_persons_geocoded").fetchone()[0]
        dr.execute(final_vars=["persons_geocoded"], inputs=inputs)
        count2 = dual_conn.execute("SELECT count(*) FROM ducklake.main.geocode_test_persons_geocoded").fetchone()[0]
        assert count1 == count2

    def test_persons_geocoded_structural_invariants(self, dual_conn, persons_validated, blockfaces, address_tokens):
        """Two invariants that should always hold for persons_geocoded:
        - One row per matched person (no duplicates from joins to upstream
          tables that have stale or duplicated keys).
        - Row count never exceeds the source `persons_validated` count
          (persons_geocoded is a subset — matched persons only).
        """
        dr = driver.Builder().with_modules(geocode).build()
        dr.execute(
            final_vars=["persons_geocoded"],
            inputs={
                "persons_validated": persons_validated,
                "blockface_final": blockfaces,
                "address_tokens": address_tokens,
                "organization_slug": "geocode_test",
                "conn": dual_conn,
            },
        )
        geocoded_fqn = "ducklake.main.geocode_test_persons_geocoded"
        validated_count = dual_conn.execute(f"SELECT count(*) FROM {persons_validated.fqn}").fetchone()[0]
        total, distinct = dual_conn.execute(f"""
            SELECT count(*), count(DISTINCT external_id) FROM {geocoded_fqn}
        """).fetchone()

        assert total == distinct, (
            f"persons_geocoded has {total} rows but only {distinct} distinct "
            f"external_ids — duplicate rows from a join multiplication."
        )
        assert total <= validated_count, (
            f"persons_geocoded has {total} rows but persons_validated only "
            f"has {validated_count} — geocoded should be a subset."
        )


# ---------------------------------------------------------------------------
# Graph 4 — aggregate (buildings_geocoded, doors_geocoded)
# ---------------------------------------------------------------------------


class TestAggregateGraph:
    """Building/door aggregation downstream of the geocode pipeline."""

    @pytest.fixture()
    def persons_geocoded(self, dual_conn, tiger_cache_dir):
        """Run the full voter_file_loader → tiger → geocode pipeline so the
        aggregate tests have a populated `persons_geocoded` to consume."""
        dr = driver.Builder().with_modules(voter_file_loader, tiger, geocode).build()
        result = dr.execute(
            final_vars=["persons_geocoded"],
            inputs={
                "voter_file_url": VOTER_FILE_URL,
                "organization_slug": "agg_test",
                "transformation_query": TRANSFORMATION_QUERY,
                "tiger_year": TEST_TIGER_YEAR,
                "tiger_state_fips": TEST_STATE_FIPS,
                "tiger_county_fips": TEST_COUNTY_FIPS,
                "tiger_data_dir": tiger_cache_dir,
                "conn": dual_conn,
            },
        )
        return result["persons_geocoded"]

    def test_buildings_geocoded_shape(self, dual_conn, persons_geocoded):
        """buildings_geocoded should produce one row per distinct building_id
        with sane counts and lat/lng inside NYC."""
        ref = aggregate.buildings_geocoded(
            persons_geocoded=persons_geocoded,
            organization_slug="agg_test",
            conn=dual_conn,
        )
        assert ref.table == "agg_test_buildings_geocoded"
        row = dual_conn.execute(f"""
            SELECT
                count(*),
                count(DISTINCT building_id),
                sum(person_count),
                count(*) FILTER (WHERE latitude BETWEEN 40.4 AND 41.0
                                       AND longitude BETWEEN -74.3 AND -73.7)
            FROM {ref.fqn}
        """).fetchone()
        building_count, distinct_buildings, total_persons, in_nyc = row
        assert building_count > 0
        assert building_count == distinct_buildings
        # Every person in persons_geocoded should be counted exactly once.
        person_total = dual_conn.execute(f"SELECT count(*) FROM {persons_geocoded.fqn}").fetchone()[0]
        assert total_persons == person_total
        # All buildings should land in the NYC envelope: every contributing
        # person has coordinates (persons_geocoded is matched-only).
        assert in_nyc == building_count

    def test_doors_geocoded_shape(self, dual_conn, persons_geocoded):
        """doors_geocoded should produce one row per distinct door_id, with
        each door's building_id pointing at a real building."""
        building_ref = aggregate.buildings_geocoded(
            persons_geocoded=persons_geocoded,
            organization_slug="agg_test",
            conn=dual_conn,
        )
        door_ref = aggregate.doors_geocoded(
            persons_geocoded=persons_geocoded,
            organization_slug="agg_test",
            conn=dual_conn,
        )
        assert door_ref.table == "agg_test_doors_geocoded"
        # Doors >= buildings (multi-unit buildings have multiple doors).
        building_count = dual_conn.execute(f"SELECT count(*) FROM {building_ref.fqn}").fetchone()[0]
        door_count = dual_conn.execute(f"SELECT count(*) FROM {door_ref.fqn}").fetchone()[0]
        assert door_count >= building_count
        # Every door's building_id should reference an existing building.
        orphan_doors = dual_conn.execute(f"""
            SELECT count(*) FROM {door_ref.fqn} d
            LEFT JOIN {building_ref.fqn} b ON b.building_id = d.building_id
            WHERE b.building_id IS NULL
        """).fetchone()[0]
        assert orphan_doors == 0
