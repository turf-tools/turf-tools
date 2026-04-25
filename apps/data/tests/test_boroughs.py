"""Full pipeline tests for each NYC borough.

Runs all three Hamilton graphs end-to-end against the real voter file on object
storage and the real TIGER shapefiles. One test per borough, parametrized so
they can be run individually or together.

TIGER shapefiles are cached at the session level in a fixed directory
(./tiger_cache relative to the package root) so repeated runs don't re-download.

Usage:
    # Run all boroughs
    uv run pytest tests/test_boroughs.py -v

    # Run a specific borough
    uv run pytest tests/test_boroughs.py -v -k manhattan
    uv run pytest tests/test_boroughs.py -v -k queens

    # Run with live output (match rate printed as each borough completes)
    uv run pytest tests/test_boroughs.py -v -s
"""

import time
from pathlib import Path

import pytest
from hamilton import driver

from src.dags import geocode, tiger, voter_file_loader

VOTER_FILE_URL = str(Path(__file__).resolve().parents[1] / "fixtures" / "ny-voters-nyc-sample.parquet")
TIGER_CACHE = str(Path(__file__).parent.parent / "tiger_cache")

# (borough_name, boe_county_code, tiger_fips, min_expected_match_pct)
BOROUGH_PARAMS = [
    ("manhattan",     "31", "061", 90.0),
    ("bronx",         "03", "005", 90.0),
    ("brooklyn",      "24", "047", 90.0),
    ("queens",        "41", "081", 90.0),
    ("staten_island", "43", "085", 90.0),
]


def make_transformation_query(county_code: str) -> str:
    return f"""
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
        {{
            middle_name: raw.middle_name,
            name_suffix: raw.name_suffix,
            date_of_birth: raw.date_of_birth,
            gender: raw.gender,
            enrollment: raw.enrollment,
            other_party: raw.other_party,
            county_code: raw.county_code,
            election_district: raw.election_district,
            legislative_district: raw.legislative_district,
            town_city: raw.town_city,
            ward: raw.ward,
            congressional_district: raw.congressional_district,
            senate_district: raw.senate_district,
            assembly_district: raw.assembly_district,
            last_voted_date: raw.last_voted_date,
            prev_year_voted: raw.prev_year_voted,
            registration_date: raw.registration_date,
            status: raw.status,
            voter_history: raw.voter_history
        }}
    ) AS other_properties
FROM raw
WHERE raw.county_code = '{county_code}'
  AND raw.status = 'A'
"""


@pytest.mark.parametrize(
    "borough,county_code,tiger_fips,min_match_pct",
    BOROUGH_PARAMS,
    ids=[p[0] for p in BOROUGH_PARAMS],
)
def test_borough_geocoding(borough, county_code, tiger_fips, min_match_pct, dual_conn, tiger_cache_dir):
    """End-to-end geocoding pipeline for a single NYC borough.

    Asserts:
    - Match rate meets the per-borough minimum threshold
    - All matched persons have coordinates within the NYC bounding box
    - The pipeline completes without error
    """
    t0 = time.time()

    # Graph 1 — load voter file into persons
    dr1 = driver.Builder().with_modules(voter_file_loader).build()
    r1 = dr1.execute(
        final_vars=["validated_persons"],
        inputs={
            "voter_file_url": VOTER_FILE_URL,
            "organization_slug": borough,
            "transformation_query": make_transformation_query(county_code),
            "conn": dual_conn,
        },
    )
    validated = r1["validated_persons"]
    person_count = dual_conn.table(validated.fqn).aggregate("count(*)").fetchone()[0]
    assert person_count > 0, f"No persons loaded for {borough}"

    # Graph 2 — prepare TIGER blockfaces
    Path(tiger_cache_dir).mkdir(parents=True, exist_ok=True)
    dr2 = driver.Builder().with_modules(tiger).build()
    r2 = dr2.execute(
        final_vars=["blockface_final"],
        inputs={
            "tiger_year": "2024",
            "tiger_state_fips": "36",
            "tiger_county_fips": [tiger_fips],
            "tiger_data_dir": tiger_cache_dir,
            "conn": dual_conn,
        },
    )
    blockfaces = r2["blockface_final"]
    bf_count = dual_conn.table(blockfaces.fqn).aggregate("count(*)").fetchone()[0]
    assert bf_count > 0, f"No blockfaces loaded for {borough}"

    # Graph 3 — geocode
    dr3 = driver.Builder().with_modules(geocode).build()
    r3 = dr3.execute(
        final_vars=["geocoding_summary"],
        inputs={
            "validated_persons": validated,
            "blockface_final": blockfaces,
            "organization_slug": borough,
            "conn": dual_conn,
        },
    )
    summary_ref = r3["geocoding_summary"]
    total, matched, unmatched, match_pct, _ = dual_conn.table(summary_ref.fqn).fetchone()

    elapsed = time.time() - t0
    print(f"\n{borough}: {matched:,}/{total:,} matched ({match_pct}%) in {elapsed:.1f}s")

    # Match rate threshold
    assert match_pct >= min_match_pct, (
        f"{borough}: match rate {match_pct}% is below minimum {min_match_pct}%"
    )

    # All matched persons should have coordinates in the NYC bounding box
    geocoded_fqn = f"ducklake.main.{borough}_persons_geocoded"
    bad_coords = dual_conn.execute(f"""
        SELECT count(*) FROM {geocoded_fqn}
        WHERE match_type != 'none'
          AND (
            latitude  IS NULL OR longitude IS NULL
            OR latitude  NOT BETWEEN 40.4  AND 41.0
            OR longitude NOT BETWEEN -74.3 AND -73.7
          )
    """).fetchone()[0]
    assert bad_coords == 0, (
        f"{borough}: {bad_coords} matched persons have invalid or out-of-bounds coordinates"
    )
