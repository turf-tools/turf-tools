"""Tests for the three Hamilton graphs: voter_file_loader, tiger, geocode.

Graph 1 (voter_file_loader) is tested against the real NY voter file on object
storage, filtered to Manhattan (county_code = '31', ~1.17M voters).

Graph 2 (tiger) downloads TIGER data for a single county (New York County
/ Manhattan, FIPS 061) into a temp directory. The download is cached at the
pytest-session level so subsequent test runs reuse the local files.

Graph 3 (geocode) wires all three graphs together end-to-end: load all
Manhattan voters, build Manhattan blockfaces, geocode, assert match rate.
"""

import tempfile

import pytest
from hamilton import driver

from src.dags import geocode, tiger, voter_file_loader

VOTER_FILE_URL = "https://zohran-data-backups.nyc3.digitaloceanspaces.com/ny-voters-2026-03-08.parquet"

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
        """raw_voter_data should create a table in ducklake and return a TableRef."""
        ref = voter_file_loader.raw_voter_data(
            voter_file_url=VOTER_FILE_URL,
            client_name="test",
            conn=dual_conn,
        )
        assert ref.catalog == "ducklake"
        assert ref.table == "test_voters_raw"
        count = dual_conn.table(ref.fqn).aggregate("count(*)").fetchone()[0]
        assert count > 0

    def test_transformation_produces_canvas_target_schema(self, dual_conn):
        """transformed_voter_data should produce the Person columns."""
        raw_ref = voter_file_loader.raw_voter_data(
            voter_file_url=VOTER_FILE_URL,
            client_name="test",
            conn=dual_conn,
        )
        transformed_ref = voter_file_loader.transformed_voter_data(
            raw_voter_data=raw_ref,
            transformation_query=TRANSFORMATION_QUERY,
            client_name="test",
            conn=dual_conn,
        )
        rel = dual_conn.table(transformed_ref.fqn)
        cols = set(rel.columns)
        assert "external_id" in cols
        assert "address_line_1" in cols
        assert "zip5" in cols
        assert "first_name" in cols

    def test_validated_voter_data_passes(self, dual_conn):
        """validated_voter_data should return the same TableRef when schema is correct."""
        raw_ref = voter_file_loader.raw_voter_data(
            voter_file_url=VOTER_FILE_URL,
            client_name="test",
            conn=dual_conn,
        )
        transformed_ref = voter_file_loader.transformed_voter_data(
            raw_voter_data=raw_ref,
            transformation_query=TRANSFORMATION_QUERY,
            client_name="test",
            conn=dual_conn,
        )
        validated_ref = voter_file_loader.validated_voter_data(
            transformed_voter_data=transformed_ref,
            conn=dual_conn,
        )
        assert validated_ref.fqn == transformed_ref.fqn

    def test_full_graph_via_hamilton_driver(self, dual_conn):
        """Hamilton driver should execute the full voter_file_loader graph."""
        dr = driver.Builder().with_modules(voter_file_loader).build()
        result = dr.execute(
            final_vars=["validated_voter_data"],
            inputs={
                "voter_file_url": VOTER_FILE_URL,
                "client_name": "test_driver",
                "transformation_query": TRANSFORMATION_QUERY,
                "conn": dual_conn,
            },
        )
        ref = result["validated_voter_data"]
        count = dual_conn.table(ref.fqn).aggregate("count(*)").fetchone()[0]
        assert count > 0


# ---------------------------------------------------------------------------
# Graph 2 — tiger
# ---------------------------------------------------------------------------


class TestTigerGraph:
    def test_address_token_table(self, dual_conn):
        """address_token_table should populate the equivalency groups table."""
        ref = tiger.address_token_table(conn=dual_conn)
        assert ref.catalog == "geo_ducklake"
        assert ref.table == "address_tokens"
        count = dual_conn.table(ref.fqn).aggregate("count(*)").fetchone()[0]
        from src.address_tokens import EQUIVALENT_TOKEN_GROUPS

        assert count == len(EQUIVALENT_TOKEN_GROUPS)

    def test_address_token_table_idempotent(self, dual_conn):
        """Running address_token_table twice should not duplicate rows."""
        tiger.address_token_table(conn=dual_conn)
        ref = tiger.address_token_table(conn=dual_conn)
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
        token_ref = tiger.address_token_table(conn=dual_conn)
        ref = tiger.blockface_final(
            blockface_normalized=normalized_ref,
            address_token_table=token_ref,
            conn=dual_conn,
        )
        assert ref.table == "blockface"
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

    These are the slowest tests: they load Manhattan voter data from object
    storage AND download TIGER shapefiles. They're placed last so earlier
    failures surface quickly.
    """

    @pytest.fixture()
    def validated_voters(self, dual_conn):
        """Run Graph 1 and return validated_voter_data TableRef."""
        dr = driver.Builder().with_modules(voter_file_loader).build()
        result = dr.execute(
            final_vars=["validated_voter_data"],
            inputs={
                "voter_file_url": VOTER_FILE_URL,
                "client_name": "geocode_test",
                "transformation_query": TRANSFORMATION_QUERY,
                "conn": dual_conn,
            },
        )
        return result["validated_voter_data"]

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

    def test_decomposed_voter_addresses(self, dual_conn, validated_voters):
        """decomposed_voter_addresses should parse house numbers and tokens."""
        ref = geocode.decomposed_voter_addresses(
            validated_voter_data=validated_voters,
            client_name="geocode_test",
            conn=dual_conn,
        )
        assert ref.table == "geocode_test_voters_decomposed"
        count = dual_conn.table(ref.fqn).aggregate("count(*)").fetchone()[0]
        assert count > 0
        cols = set(dual_conn.table(ref.fqn).columns)
        assert "house_number" in cols
        assert "street_name_tokens" in cols
        assert "number_type" in cols
        # All number_type values should be odd or even (voters have parseable house nums)
        bad = dual_conn.execute(f"SELECT count(*) FROM {ref.fqn} WHERE number_type NOT IN ('odd','even')").fetchone()[0]
        assert bad == 0

    def test_candidate_blockfaces(self, dual_conn, validated_voters, blockfaces):
        """candidate_blockfaces should produce voter–blockface pairs."""
        decomposed_ref = geocode.decomposed_voter_addresses(
            validated_voter_data=validated_voters,
            client_name="geocode_test",
            conn=dual_conn,
        )
        ref = geocode.candidate_blockfaces(
            decomposed_voter_addresses=decomposed_ref,
            blockface_final=blockfaces,
            client_name="geocode_test",
            conn=dual_conn,
        )
        assert ref.table == "geocode_test_voters_candidates"
        count = dual_conn.table(ref.fqn).aggregate("count(*)").fetchone()[0]
        assert count > 0

    def test_geocoded_voters_match_rate(self, dual_conn, validated_voters, blockfaces):
        """Full geocode pipeline should achieve a reasonable match rate for Manhattan."""
        dr = driver.Builder().with_modules(geocode).build()
        result = dr.execute(
            final_vars=["geocoding_summary"],
            inputs={
                "validated_voter_data": validated_voters,
                "blockface_final": blockfaces,
                "client_name": "geocode_test",
                "conn": dual_conn,
            },
        )
        summary_ref = result["geocoding_summary"]
        row = dual_conn.table(summary_ref.fqn).fetchone()
        total, matched, unmatched, match_pct, blockface_matches = row
        print(f"\nGeocoding summary: {matched}/{total} matched ({match_pct}%)")
        assert total > 0
        assert matched > 0
        # Expect at least 50% match rate for Manhattan voters against Manhattan TIGER
        assert match_pct >= 50.0

    def test_geocoded_voters_have_valid_coordinates(self, dual_conn, validated_voters, blockfaces):
        """Matched voters should have plausible NYC lat/lon coordinates."""
        dr = driver.Builder().with_modules(geocode).build()
        dr.execute(
            final_vars=["geocoded_voters"],
            inputs={
                "validated_voter_data": validated_voters,
                "blockface_final": blockfaces,
                "client_name": "geocode_test",
                "conn": dual_conn,
            },
        )
        geocoded_fqn = f"ducklake.main.geocode_test_voters_geocoded"
        # Matched rows should have non-null coordinates in NYC bounding box
        bad_coords = dual_conn.execute(f"""
            SELECT count(*) FROM {geocoded_fqn}
            WHERE match_type != 'none'
              AND (
                latitude  IS NULL OR longitude IS NULL
                OR latitude  NOT BETWEEN 40.4  AND 41.0
                OR longitude NOT BETWEEN -74.3 AND -73.7
              )
        """).fetchone()[0]
        assert bad_coords == 0

    def test_geocoded_voters_idempotent(self, dual_conn, validated_voters, blockfaces):
        """Running geocode twice should not duplicate rows in geocoded_voters."""
        inputs = {
            "validated_voter_data": validated_voters,
            "blockface_final": blockfaces,
            "client_name": "geocode_test",
            "conn": dual_conn,
        }
        dr = driver.Builder().with_modules(geocode).build()
        dr.execute(final_vars=["geocoded_voters"], inputs=inputs)
        count1 = dual_conn.execute("SELECT count(*) FROM ducklake.main.geocode_test_voters_geocoded").fetchone()[0]
        dr.execute(final_vars=["geocoded_voters"], inputs=inputs)
        count2 = dual_conn.execute("SELECT count(*) FROM ducklake.main.geocode_test_voters_geocoded").fetchone()[0]
        assert count1 == count2
