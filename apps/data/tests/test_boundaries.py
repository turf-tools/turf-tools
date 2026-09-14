"""Block-union boundaries: backfilling fills gaps inside the voter footprint
and never grows past it. Unit blocks on a 6x3 grid: key A fills the 3x3
square at x=0..2 except its centre, key B has one block at (5,1); the two
columns between hold no voters. Only the enclosed centre should backfill.
"""

from __future__ import annotations

from src.dags.boundaries import boundary_from_blocks
from src.models import TableRef


def _ref(schema: str, table: str) -> TableRef:
    return TableRef(catalog="ducklake", schema=schema, table=table, version=0)


def test_backfill_stays_inside_the_voter_footprint(conn) -> None:
    conn.execute("LOAD spatial")
    conn.execute("CREATE SCHEMA ducklake.t")
    conn.execute(
        """
        CREATE TABLE ducklake.t.tiger_tabblock_raw AS
        SELECT
            'b' || x || y AS block_geoid,
            ST_MakeEnvelope(x, y, x + 1, y + 1) AS geom,
            1 AS land_area,
            '36' AS state_fips,
            '061' AS county_fips
        FROM range(6) t(x), range(3) u(y)
        """
    )
    conn.execute(
        """
        CREATE TABLE ducklake.t.persons_geocoded AS
        SELECT 'A' AS precinct, x + 0.5 AS longitude, y + 0.5 AS latitude
        FROM range(3) t(x), range(3) u(y)
        WHERE NOT (x = 1 AND y = 1)
        UNION ALL SELECT 'B', 5.5, 1.5
        """
    )
    boundary_from_blocks(
        persons_geocoded=_ref("t", "persons_geocoded"),
        tiger_tabblock_raw=_ref("t", "tiger_tabblock_raw"),
        tiger_state_fips="36",
        tiger_county_fips=["061"],
        key_group="eds",
        key_expression="precinct",
        schema="t",
        conn=conn,
        simplify_tolerance=0.0,
    )
    rows = dict(conn.execute('SELECT "key", ST_Area(geom) FROM ducklake.t.eds ORDER BY 1').fetchall())
    # The enclosed centre backfills to A; the empty columns at x=3..4 and
    # B's no-voter neighbours stay unassigned.
    assert rows == {"A": 9.0, "B": 1.0}
