"""Hamilton graph for aggregating geocoded persons into buildings and doors.

Both outputs derive from `persons_geocoded` (which already carries
`building_id`, `door_id`, canonical address fields, and lat/lng):

    persons_geocoded ─► buildings_geocoded
                    └─► doors_geocoded

A building is one physical structure (`address_line_1 + zip5`). A door is
one unit within a building (`address_line_1 + address_line_2 + zip5`).
Single-family homes have one door per building. lat/lng is the centroid of
contained persons — they share an address, so coordinates match within
float noise. `persons_geocoded` only contains successfully-matched rows
(see `assembly.py`), so every person here has coordinates and a stable
building/door key.
"""

import duckdb
from src.models import TableRef
from src.tables import PERSON_CATALOG, ensure_org_schema, org_fqn


def _current_version(conn: duckdb.DuckDBPyConnection) -> int:
    return conn.sql(f"FROM {PERSON_CATALOG}.current_snapshot()").fetchone()[0]


def buildings_geocoded(
    persons_geocoded: TableRef,
    organization_slug: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """One row per distinct `building_id`, derived from `persons_geocoded`.

    Columns:
        building_id, address_line_1, city, state, zip5, latitude, longitude,
        person_count, door_count

    lat/lng = AVG of contained persons' coordinates (they share an address,
    so coordinates differ only by float noise).
    """
    table = "buildings_geocoded"
    ensure_org_schema(conn, organization_slug)
    fqn = org_fqn(organization_slug, table)
    persons_fqn = persons_geocoded.fqn

    conn.execute(f"DROP TABLE IF EXISTS {fqn}")
    conn.execute(f"""
        CREATE TABLE {fqn} AS
        SELECT
            building_id,
            -- Address fields are stable across rows that share a
            -- building_id (since the id is derived from them); ANY_VALUE
            -- avoids a needless GROUP BY on each one.
            ANY_VALUE(address_line_1)               AS address_line_1,
            ANY_VALUE(city)                         AS city,
            ANY_VALUE(state)                        AS state,
            zip5,
            AVG(latitude)                           AS latitude,
            AVG(longitude)                          AS longitude,
            COUNT(*)                                AS person_count,
            COUNT(DISTINCT door_id)                 AS door_count
        FROM {persons_fqn}
        GROUP BY building_id, zip5
    """)

    return TableRef(
        catalog=PERSON_CATALOG,
        schema=organization_slug,
        table=table,
        version=_current_version(conn),
    )


def doors_geocoded(
    persons_geocoded: TableRef,
    organization_slug: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRef:
    """One row per distinct `door_id`, derived from `persons_geocoded`.

    Columns:
        door_id, building_id, address_line_2, latitude, longitude, person_count

    lat/lng = AVG of contained persons' coordinates (same as buildings —
    units in a building share a physical location).

    `address_line_2` is NULL for single-family doors (the door_id key has
    an empty middle segment in that case). Multi-unit doors carry the
    canonical unit string (e.g. "APT 3B").
    """
    table = "doors_geocoded"
    ensure_org_schema(conn, organization_slug)
    fqn = org_fqn(organization_slug, table)
    persons_fqn = persons_geocoded.fqn

    conn.execute(f"DROP TABLE IF EXISTS {fqn}")
    conn.execute(f"""
        CREATE TABLE {fqn} AS
        SELECT
            door_id,
            ANY_VALUE(building_id)                  AS building_id,
            ANY_VALUE(address_line_2)               AS address_line_2,
            AVG(latitude)                           AS latitude,
            AVG(longitude)                          AS longitude,
            COUNT(*)                                AS person_count
        FROM {persons_fqn}
        GROUP BY door_id
    """)

    return TableRef(
        catalog=PERSON_CATALOG,
        schema=organization_slug,
        table=table,
        version=_current_version(conn),
    )
