"""CLI entrypoints for the data package."""

from pathlib import Path

from hamilton import driver

from src.dags import aggregate, boundaries, geocode, quickwit, tiger, voter_file_loader
from src.db import get_connection
from src.settings import get_settings
from src.transformations import nys_sboe_transformation_query


def _render(dr: driver.Driver, filename: str) -> None:
    docs = Path(__file__).resolve().parent.parent / "docs"
    docs.mkdir(exist_ok=True)
    path = str(docs / filename)
    dr.display_all_functions(path)
    print(f"Wrote {path}")


def update_visualizations() -> None:
    """Render all Hamilton graph visualizations into docs/."""
    _render(driver.Builder().with_modules(voter_file_loader).build(), "voter_file_loader_graph.png")
    _render(driver.Builder().with_modules(tiger).build(), "tiger_graph.png")
    _render(driver.Builder().with_modules(geocode).build(), "geocode_graph.png")
    _render(driver.Builder().with_modules(aggregate).build(), "aggregate_graph.png")
    _render(driver.Builder().with_modules(quickwit).build(), "quickwit_graph.png")
    _render(driver.Builder().with_modules(boundaries).build(), "boundaries_graph.png")
    _render(
        driver.Builder()
        .with_modules(voter_file_loader, tiger, geocode, aggregate, quickwit)
        .build(),
        "pipeline_graph.png",
    )


# ---------------------------------------------------------------------------
# Seed commands — one-shot ingests for reference data that's static enough to
# treat as "set up at deploy time, no UI yet". When admin upload flows land,
# these get a proper job runner; for now they're CLI invocations.
# ---------------------------------------------------------------------------


_FIXTURES_DIR = Path(__file__).resolve().parent.parent / "fixtures"


def seed_boundaries() -> None:
    """Load every available boundary source into ``geo_ducklake.boundaries.*``.

    Add a new entry to BOUNDARY_SOURCES below to seed another key group.
    Skips sources whose source file isn't on disk so partial setups don't
    error.
    """
    BOUNDARY_SOURCES = [
        {
            "key_group": "nyc_eds",
            "geojson_path": _FIXTURES_DIR / "nyc-eds.geojson",
            "key_property": "district",
            "name_property": None,
        },
        {
            "key_group": "nyc_zips",
            "geojson_path": _FIXTURES_DIR / "nyc-zips.geojson",
            "key_property": "modzcta",
            "name_property": "label",
        },
    ]

    settings = get_settings()
    conn = get_connection(settings)
    dr = driver.Builder().with_modules(boundaries).build()

    for source in BOUNDARY_SOURCES:
        path: Path = source["geojson_path"]  # type: ignore[assignment]
        if not path.exists():
            print(f"Skipping {source['key_group']}: {path} not found")
            continue

        print(f"Loading {source['key_group']} from {path}…")
        result = dr.execute(
            final_vars=["boundary_from_geojson"],
            inputs={
                "geojson_url": str(path),
                "key_group": source["key_group"],
                "key_property": source["key_property"],
                "name_property": source["name_property"],
                "conn": conn,
            },
        )
        ref = result["boundary_from_geojson"]
        count = conn.sql(f"SELECT count(*) FROM {ref.fqn}").fetchone()[0]
        print(f"  → {count:,} polygons in {ref.fqn}")

    conn.close()
    print("Boundaries seeded.")


# ---------------------------------------------------------------------------
# Seed persons: load the NYC sample voter file → transform to Person schema
# → geocode against TIGER blockfaces → aggregate into buildings/doors.
# ---------------------------------------------------------------------------


# Org slug to seed under. Must match `slug: "default"` in
# packages/db/src/mock.ts so the web app's RPC layer can resolve voter
# data for the seeded organization.
_DEFAULT_ORG_SLUG = "default"
_DEFAULT_VOTER_FIXTURE = _FIXTURES_DIR / "nys-voters-2026-03-08-10k-sample.parquet"


def seed_persons() -> None:
    """Run voter_file_loader → tiger → geocode → aggregate against the NYC
    sample fixture.

    Final outputs (under ``ducklake.main``):
    - ``{org}_persons_geocoded`` — canonical "person record": Person fields
      with canonicalized addresses, lat/lng, blockface match metadata,
      derived `building_id` and `door_id`.
    - ``{org}_buildings_geocoded`` — one row per distinct building.
    - ``{org}_doors_geocoded`` — one row per distinct door.

    TIGER counties pulled from settings (defaults to all 5 NYC boroughs).
    First run downloads the TIGER shapefiles for each county (a few minutes
    on a fresh machine); subsequent runs reuse the on-disk cache and are
    fast.
    """
    settings = get_settings()
    conn = get_connection(settings)

    if not _DEFAULT_VOTER_FIXTURE.exists():
        print(f"Voter fixture not found: {_DEFAULT_VOTER_FIXTURE}")
        return

    print(f"Seeding persons from {_DEFAULT_VOTER_FIXTURE} (org={_DEFAULT_ORG_SLUG})…")
    print(f"  TIGER counties: {settings.tiger_county_fips} (cache: {settings.tiger_data_dir})")

    dr = driver.Builder().with_modules(voter_file_loader, tiger, geocode, aggregate).build()
    result = dr.execute(
        final_vars=[
            "geocoded_persons",
            "geocoding_summary",
            "buildings_geocoded",
            "doors_geocoded",
        ],
        inputs={
            "voter_file_url": str(_DEFAULT_VOTER_FIXTURE),
            "organization_slug": _DEFAULT_ORG_SLUG,
            # Curated transformation: passes all rows in the fixture (no
            # county filter) since the fixture is already NYC-only.
            "transformation_query": nys_sboe_transformation_query(),
            "tiger_year": settings.tiger_year,
            "tiger_state_fips": settings.tiger_state_fips,
            "tiger_county_fips": settings.tiger_county_fips,
            "tiger_data_dir": settings.tiger_data_dir,
            "conn": conn,
        },
    )

    geocoded_ref = result["geocoded_persons"]
    summary_ref = result["geocoding_summary"]
    buildings_ref = result["buildings_geocoded"]
    doors_ref = result["doors_geocoded"]
    total, matched, unmatched, pct = conn.sql(
        f"SELECT total_persons, matched, unmatched, match_pct FROM {summary_ref.fqn}"
    ).fetchone()
    building_count = conn.sql(f"SELECT count(*) FROM {buildings_ref.fqn}").fetchone()[0]
    door_count = conn.sql(f"SELECT count(*) FROM {doors_ref.fqn}").fetchone()[0]
    print(
        f"  → {matched:,}/{total:,} matched ({pct}%); {unmatched:,} unmatched.\n"
        f"  → {building_count:,} buildings, {door_count:,} doors.\n"
        f"  → Outputs: {geocoded_ref.fqn}, {buildings_ref.fqn}, {doors_ref.fqn}"
    )

    conn.close()
    print("Persons seeded.")
