"""CLI entrypoints for the data package."""

import argparse
from pathlib import Path

from hamilton import driver

from src.dags import (
    aggregate,
    assembly,
    boundaries,
    geocode,
    matching,
    osm,
    quickwit,
    tiger,
    voter_file_loader,
)
from src.duckdb import get_connection
from src.models import TableRef
from src.perf import TimingHook
from src.settings import get_settings
from src.tables import PERSON_CATALOG, drop_org_schema, ensure_org_schema
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
    _render(driver.Builder().with_modules(matching).build(), "matching_graph.png")
    _render(driver.Builder().with_modules(osm).build(), "osm_graph.png")
    _render(driver.Builder().with_modules(geocode).build(), "geocode_graph.png")
    _render(driver.Builder().with_modules(assembly).build(), "assembly_graph.png")
    _render(driver.Builder().with_modules(aggregate).build(), "aggregate_graph.png")
    _render(driver.Builder().with_modules(quickwit).build(), "quickwit_graph.png")
    _render(driver.Builder().with_modules(boundaries).build(), "boundaries_graph.png")
    _render(
        driver.Builder()
        .with_modules(voter_file_loader, tiger, osm, matching, geocode, assembly, aggregate, quickwit)
        .build(),
        "pipeline_graph.png",
    )


# ---------------------------------------------------------------------------
# Seed commands — one-shot ingests for reference data that's static enough to
# treat as "set up at deploy time, no UI yet". When admin upload flows land,
# these get a proper job runner; for now they're CLI invocations.
# ---------------------------------------------------------------------------


def _fixtures_dir(settings) -> Path:  # noqa: ANN001 — settings is a Settings instance
    return Path(__file__).resolve().parent.parent / settings.fixtures_dir


def seed_boundaries() -> None:
    """Derive every key group's polygons from the voter file + TIGER blocks.

    For each configured key group, downloads (if missing) the TIGER
    census-block polygons for the configured counties and unions the
    blocks where voters tagged with each distinct key live. Output goes
    to ``geo_ducklake.boundaries.{key_group}``.

    Requires ``seed-persons`` to have run first — we read from
    ``ducklake.<org>.persons_geocoded`` for the keys + coordinates.
    Pair `--org-slug` here with whatever you passed to `seed-persons`
    if you used a non-default schema:

        uv run seed-boundaries --org-slug sample_10k

    Add a new entry to ``key_group_sources`` to seed another key group;
    each entry is the destination key-group name plus the SQL expression
    that produces the key from a row of the persons table.
    """
    parser = argparse.ArgumentParser(prog="seed-boundaries", description=seed_boundaries.__doc__)
    parser.add_argument(
        "--org-slug",
        default=_DEFAULT_ORG_SLUG,
        help=f"Org schema to read persons from (default: {_DEFAULT_ORG_SLUG!r}).",
    )
    args = parser.parse_args()

    key_group_sources = [
        {
            "key_group": "nyc_eds",
            "key_expression": "json_extract_string(other_properties, '$.ad_ed')",
        },
        {
            "key_group": "nyc_zips",
            "key_expression": "zip5",
        },
    ]

    settings = get_settings()
    conn = get_connection(settings)

    # Single driver — Hamilton resolves the tiger_tabblock_raw →
    # boundary_from_blocks edge itself and we don't have to plumb the
    # TableRef through manually. tiger_tabblock_raw is idempotent
    # (skips counties already loaded) so re-running it once per
    # key-group iteration is cheap after the first pass.
    dr = driver.Builder().with_modules(tiger, boundaries).build()

    # Persons table referenced by FQN — must already exist
    # (seed_persons output). The persons reference is the same for
    # every key group; only `key_group` and `key_expression` vary.
    persons_ref = TableRef(
        catalog=PERSON_CATALOG,
        schema=args.org_slug,
        table="persons_geocoded",
        version=0,
    )

    base_inputs = {
        "tiger_year": settings.tiger_year,
        "tiger_state_fips": settings.tiger_state_fips,
        "tiger_county_fips": settings.tiger_county_fips,
        "tiger_data_dir": settings.tiger_data_dir,
        "persons_geocoded": persons_ref,
        "conn": conn,
    }

    for source in key_group_sources:
        print(f"Deriving {source['key_group']} from voter file…")
        result = dr.execute(
            final_vars=["boundary_from_blocks"],
            inputs={
                **base_inputs,
                "key_group": source["key_group"],
                "key_expression": source["key_expression"],
            },
        )
        ref = result["boundary_from_blocks"]
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


def seed_persons() -> None:
    """Run voter_file_loader → tiger → osm → matching → geocode → assembly →
    aggregate against a voter file fixture.

    Defaults to `{fixtures_dir}/{voter_file_fixture}` (configured in
    settings — usually `apps/data/fixtures/ny-voters-2026-03-08-nyc.parquet`)
    and writes into the `default` org schema (matching `slug: "default"`
    in `packages/db/src/mock.ts` so the web app finds it).

    Override either with flags:

        uv run seed-persons --fixture ny-voters-2026-03-08-10k-sample.parquet
        uv run seed-persons --fixture <sample> --org-slug sample_10k

    Using a non-default org slug writes to a separate DuckLake schema
    (`ducklake.<slug>.persons_geocoded`), so iterating on samples doesn't
    overwrite the default schema the web app reads from.

    Most intermediate DAG nodes are incremental (`CREATE TABLE IF NOT
    EXISTS` + `WHERE external_id NOT IN (...)`), which is fast on
    re-runs but means schema changes inside the pipeline don't
    auto-apply. Pass `--reset` to drop the org's DuckLake schema
    before running so the next pipeline run rebuilds every table from
    scratch:

        uv run seed-persons --reset

    If the fixture is missing, prints a hint pointing at the source URL
    and the script that materialises it.

    Final outputs (under ``ducklake.<org>``):
    - ``persons_geocoded`` — canonical "person record": Person fields
      with canonicalized addresses, lat/lng, blockface match metadata,
      derived `building_id` and `door_id`.
    - ``buildings_geocoded`` — one row per distinct building.
    - ``doors_geocoded`` — one row per distinct door.

    TIGER counties pulled from settings (defaults to all 5 NYC boroughs).
    First run downloads the TIGER shapefiles for each county (a few minutes
    on a fresh machine); subsequent runs reuse the on-disk cache and are
    fast.
    """
    parser = argparse.ArgumentParser(prog="seed-persons", description=seed_persons.__doc__)
    parser.add_argument(
        "--fixture",
        default=None,
        help="Fixture filename inside `fixtures_dir` (default: settings.voter_file_fixture).",
    )
    parser.add_argument(
        "--org-slug",
        default=_DEFAULT_ORG_SLUG,
        help=f"Target DuckLake schema (default: {_DEFAULT_ORG_SLUG!r}).",
    )
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Drop the org's DuckLake schema before running. Use after a pipeline schema change.",
    )
    parser.add_argument(
        "--timing",
        action="store_true",
        help="Print per-node wall time as the pipeline runs, plus a sorted summary at the end.",
    )
    args = parser.parse_args()

    settings = get_settings()
    conn = get_connection(settings)

    if args.reset:
        print(f"Dropping schema ducklake.{args.org_slug}…")
        drop_org_schema(conn, args.org_slug)
        ensure_org_schema(conn, args.org_slug)

    fixture_name = args.fixture or settings.voter_file_fixture
    fixture_path = _fixtures_dir(settings) / fixture_name
    if not fixture_path.exists():
        print(f"Voter file fixture not found at {fixture_path}.")
        print(
            f"Materialise it from {settings.voter_file_url} via "
            "`uv run python scripts/sample_voter_file.py` "
            "(see the script for sampling options)."
        )
        return

    print(f"Seeding persons from {fixture_path} (org={args.org_slug})…")
    print(f"  TIGER counties: {settings.tiger_county_fips} (cache: {settings.tiger_data_dir})")
    if settings.voter_zip5_filter:
        print(f"  Voter ZIP5 filter (dev scope): {settings.voter_zip5_filter}")

    timing = TimingHook() if args.timing else None
    builder = driver.Builder().with_modules(
        voter_file_loader,
        tiger,
        osm,
        matching,
        geocode,
        assembly,
        aggregate,
    )
    if timing is not None:
        builder = builder.with_adapters(timing)
    dr = builder.build()
    result = dr.execute(
        final_vars=[
            "persons_geocoded",
            "geocoding_summary",
            "buildings_geocoded",
            "doors_geocoded",
        ],
        inputs={
            "voter_file_url": str(fixture_path),
            "organization_slug": args.org_slug,
            # Fixture is already NYC-only so we skip the county filter.
            # `voter_zip5_filter` from settings scopes dev runs to a small
            # geographic slice.
            "transformation_query": nys_sboe_transformation_query(
                zip5_filter=settings.voter_zip5_filter,
            ),
            "tiger_year": settings.tiger_year,
            "tiger_state_fips": settings.tiger_state_fips,
            "tiger_county_fips": settings.tiger_county_fips,
            "tiger_data_dir": settings.tiger_data_dir,
            "osm_url": settings.osm_url,
            "osm_data_dir": settings.osm_data_dir,
            "conn": conn,
        },
    )

    geocoded_ref = result["persons_geocoded"]
    summary_ref = result["geocoding_summary"]
    buildings_ref = result["buildings_geocoded"]
    doors_ref = result["doors_geocoded"]
    (total, matched, unmatched, pct, m_road, m_complex, m_off_seg, m_tiger_only, m_osm_only) = conn.sql(f"""
        SELECT total_persons, matched, unmatched, match_pct,
               matched_osm_road_projected, matched_osm_complex,
               matched_osm_off_segment,
               matched_tiger_only, matched_osm_only
        FROM {summary_ref.fqn}
    """).fetchone()
    building_count = conn.sql(f"SELECT count(*) FROM {buildings_ref.fqn}").fetchone()[0]
    door_count = conn.sql(f"SELECT count(*) FROM {doors_ref.fqn}").fetchone()[0]
    print(
        f"  → {matched:,}/{total:,} matched ({pct}%); {unmatched:,} unmatched.\n"
        f"      OSM road-projected : {m_road:>8,d}\n"
        f"      OSM complex        : {m_complex:>8,d}\n"
        f"      OSM off-segment    : {m_off_seg:>8,d}\n"
        f"      TIGER rank fallback: {m_tiger_only:>8,d}\n"
        f"      OSM-only (TIGER-miss rescue): {m_osm_only:>8,d}\n"
        f"  → {building_count:,} buildings, {door_count:,} doors.\n"
        f"  → Outputs: {geocoded_ref.fqn}, {buildings_ref.fqn}, {doors_ref.fqn}"
    )

    if timing is not None:
        timing.print_summary()
    conn.close()
    print("Persons seeded.")
