"""Write the autocut battery's inputs to `fixtures/autocut/`.

For each zip: the buildings of the segment the battery has always used
(Democrats who voted in the 2025 or 2026 primary), with doors counted like
the cutter's sidebar. Plus the blockface relationships those buildings'
blockfaces take part in. Reads the local lake; the fixture is local-only,
like the voter fixtures. The battery tests (`pnpm data:test:autocut`) skip
until this has been run.

    uv run python -m scripts.autocut_fixture [--org default] [--zips 10003 ...]
"""

import argparse
from pathlib import Path

from src.autocut import _RELATIONSHIPS
from src.buildings import building_rows_sql
from src.custom_fields import query_context
from src.dsl.compile import criteria_to_where
from src.dsl.criteria import Criteria
from src.dsl.resolve import resolve_criteria
from src.duckdb import attach_operational_postgres, get_connection
from src.settings import get_settings
from src.tables import resolve


def main() -> None:
    parser = argparse.ArgumentParser(prog="autocut-fixture", description=__doc__)
    parser.add_argument("--org", default="default")
    parser.add_argument("--zips", nargs="+", default=["10003", "10009", "10314", "11201", "11385"])
    parser.add_argument("--out", default=str(Path(__file__).resolve().parents[1] / "fixtures" / "autocut"))
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    settings = get_settings()
    conn = get_connection(settings, read_only=True)
    attach_operational_postgres(conn, settings)
    version, catalog = query_context(conn, args.org)
    blockfaces: set[str] = set()
    for zip5 in args.zips:
        criteria = Criteria.model_validate(
            {
                "steps": [
                    {"verb": "narrow", "filter": {"kind": "text-multi", "key": "zip5", "values": [zip5]}},
                    {"verb": "narrow", "filter": {"kind": "enum", "key": "enrollment", "values": ["democratic"]}},
                    {
                        "verb": "narrow",
                        "filter": {
                            "kind": "voting-history-detail",
                            "key": "voting_history_detail",
                            "mode": "any",
                            "elections": ["2026-primary", "2025-primary"],
                        },
                    },
                ]
            }
        )
        resolved = resolve_criteria(criteria, conn, settings, args.org)
        params: list = []
        where = criteria_to_where(catalog, resolved, None, params)
        conn.execute(
            resolve(
                f"""
                CREATE OR REPLACE TEMP TABLE fixture_buildings AS
                SELECT m."buildingId" AS building_id, m.longitude, m.latitude, m."doorCount" AS doors, g.blockface_id
                FROM ({building_rows_sql(where)}) m
                JOIN {{buildings_geocoded}} g ON g.building_id = m."buildingId"
                """,
                version.schema,
            ),
            params,
        )
        conn.execute(f"COPY fixture_buildings TO '{out / f'{zip5}.parquet'}' (FORMAT parquet)")
        blockfaces.update(r[0] for r in conn.execute("SELECT DISTINCT blockface_id FROM fixture_buildings").fetchall())
        n, doors = conn.execute("SELECT count(*), sum(doors) FROM fixture_buildings").fetchone()
        print(f"{zip5}: {n} buildings, {doors} doors")
    conn.execute("CREATE OR REPLACE TEMP TABLE fixture_blockfaces (blockface_id VARCHAR)")
    conn.executemany("INSERT INTO fixture_blockfaces VALUES (?)", [(b,) for b in blockfaces if b])
    conn.execute(f"""
        COPY (
            SELECT * FROM {_RELATIONSHIPS}
            WHERE blockface_id_a IN (SELECT blockface_id FROM fixture_blockfaces)
              AND blockface_id_b IN (SELECT blockface_id FROM fixture_blockfaces)
        ) TO '{out / "relationships.parquet"}' (FORMAT parquet)
    """)
    rel = out / "relationships.parquet"
    (rows,) = conn.execute(f"SELECT count(*) FROM read_parquet('{rel}')").fetchone()
    print(f"relationships: {rows} rows -> {out}")


if __name__ == "__main__":
    main()
