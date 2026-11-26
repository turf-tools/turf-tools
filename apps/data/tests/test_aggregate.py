"""Tests for aggregate.buildings_geocoded: the same persons always give the
same building row."""

from src.dags import aggregate
from src.models import TableRef
from src.tables import ensure_schema, table_fqn

ORG = "agg_test"


def _persons(conn, rows) -> TableRef:
    """rows: (external_id, city, blockface_id) for one building."""
    ensure_schema(conn, ORG)
    fqn = table_fqn(ORG, "persons_geocoded")
    conn.execute(f"""
        CREATE OR REPLACE TABLE {fqn} (
            external_id VARCHAR, building_id VARCHAR, address_line_1 VARCHAR, city VARCHAR, state VARCHAR,
            building_zip5 VARCHAR, latitude DOUBLE, longitude DOUBLE, blockface_id VARCHAR,
            door_i BIGINT, building_i BIGINT
        )
    """)
    conn.executemany(
        f"INSERT INTO {fqn} VALUES (?, '1 MAIN ST|11111', '1 MAIN ST', ?, 'NY', '11111', 40.7, -73.9, ?, 1, 1)",
        rows,
    )
    return TableRef(catalog="ducklake", schema=ORG, table="persons_geocoded", version=0)


def _building(conn, rows):
    ref = aggregate.buildings_geocoded(persons_geocoded=_persons(conn, rows), schema=ORG, conn=conn)
    return conn.execute(f"SELECT city, blockface_id, person_count FROM {ref.fqn}").fetchall()


def test_most_common_city_and_blockface(dual_conn):
    rows = [("a", "QUEENS VLG", "B:left"), ("b", "QUEENS VILLAGE", "A:left"), ("c", "QUEENS VILLAGE", "A:left")]
    assert _building(dual_conn, rows) == [("QUEENS VILLAGE", "A:left", 3)]


def test_ties_go_alphabetical_and_to_the_lowest_blockface(dual_conn):
    rows = [("a", "Miami", "B:left"), ("b", "MIAMI", "A:left"), ("c", None, None)]
    assert _building(dual_conn, rows) == [("MIAMI", "A:left", 3)]
