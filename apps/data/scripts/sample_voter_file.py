"""Sample Ben's remote voter parquet into a small local fixture for fast tests.

Preserves the source column types exactly (DuckDB's read_parquet → write_parquet
round-trip keeps logical types intact). Samples N rows per NYC borough so every
borough test has real data — no single-borough bias.

Determinism is via ``hash(sboe_id)`` rather than ``random()``, so regenerating
the fixture on different machines (or by different contributors) gives the
same sample.

Run from apps/data/ with:
    uv run python scripts/sample_voter_file.py
"""

from pathlib import Path

import duckdb

REMOTE_URL = "https://zohran-data-backups.nyc3.digitaloceanspaces.com/ny-voters-2026-03-08.parquet"
OUTPUT_PATH = Path(__file__).resolve().parents[1] / "fixtures" / "ny-voters-nyc-sample.parquet"
ROWS_PER_BOROUGH = 2000

# NYS BOE county codes for the five NYC boroughs
BOROUGH_COUNTY_CODES = ["31", "03", "24", "41", "43"]


def main() -> None:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    codes = ",".join(f"'{c}'" for c in BOROUGH_COUNTY_CODES)
    print(
        f"Sampling {ROWS_PER_BOROUGH} voters from each of {len(BOROUGH_COUNTY_CODES)} "
        f"NYC boroughs from {REMOTE_URL}…"
    )
    duckdb.sql(f"""
        COPY (
            WITH ranked AS (
                SELECT *, row_number() OVER (
                    PARTITION BY county_code
                    ORDER BY hash(sboe_id)
                ) AS rn
                FROM read_parquet('{REMOTE_URL}')
                WHERE county_code IN ({codes})
            )
            SELECT * EXCLUDE rn FROM ranked WHERE rn <= {ROWS_PER_BOROUGH}
        ) TO '{OUTPUT_PATH}' (FORMAT 'PARQUET')
    """)
    print(f"Wrote {OUTPUT_PATH}")

    count = duckdb.sql(f"SELECT count(*) FROM read_parquet('{OUTPUT_PATH}')").fetchone()[0]
    print(f"Total rows: {count:,}")

    print("\nPer-borough counts:")
    rel = duckdb.sql(f"""
        SELECT county_code, count(*) AS n
        FROM read_parquet('{OUTPUT_PATH}')
        GROUP BY county_code
        ORDER BY county_code
    """)
    for code, n in rel.fetchall():
        print(f"  county_code={code}: {n:,}")


if __name__ == "__main__":
    main()
