"""Zone helpers: definition keys and boundary geometry."""

from __future__ import annotations

import duckdb
from src.cache import singleflight_lru
from src.custom_fields import load_upload_table

# Boundary polygons are simplified per feature at seed time, so adjacent
# shapes disagree along shared edges by up to the simplification
# tolerance (0.0001°) — a plain union inherits that as slivers and
# hairline cracks, which the renderer's per-zoom re-simplification shows
# as flickering triangles and trapped inner lines. Closing the union
# (dilate+erode at that tolerance) seals them; the trailing simplify
# strips the buffer's corner-rounding micro-vertices.
PERIMETER_CLOSE_TOLERANCE = 0.0001
PERIMETER_SIMPLIFY_TOLERANCE = 0.00001


def flatten_zone_keys(zones: list[tuple[str, list[str]]]) -> tuple[list[str], list[str]]:
    """(zone_id, keys) pairs → parallel arrays for a zone-key unnest join."""
    zone_ids: list[str] = []
    keys: list[str] = []
    for zone_id, zone_keys in zones:
        zone_ids.extend([zone_id] * len(zone_keys))
        keys.extend(zone_keys)
    return zone_ids, keys


def zone_target_counts_sql(persons_fqn: str, key_expr: str, where: str) -> str:
    """Per-zone people and door counts for the conditioned population.
    Binds [zone_ids, keys, *where_params]."""
    return f"""
        WITH zk AS (SELECT unnest(?) AS zone_id, unnest(?) AS key)
        SELECT zk.zone_id, count(*), count(DISTINCT door_i)
        FROM {persons_fqn} JOIN zk ON {key_expr} = zk.key
        {where}
        GROUP BY zk.zone_id
    """


PERIMETER_CACHE_BYTES = 32 * 2**20

# Segment perimeters skip the union past this many keys: a segment that
# wide has no meaningful outline, and the GEOS cost grows to seconds
# (~15s city-wide) with a multi-MB result.
MAX_PERIMETER_KEYS = 1000


def boundary_key_counts(conn: duckdb.DuckDBPyConnection, fqns: dict[str, str]) -> dict[str, int]:
    """Rows per boundary table, by key group; unseeded tables are dropped.
    Key count orders key groups by granularity — finer partitions have
    more keys."""
    counts: dict[str, int] = {}
    for key_group, fqn in fqns.items():
        try:
            row = conn.execute(f"SELECT count(*) FROM {fqn}").fetchone()
        except duckdb.Error:
            continue
        if row is not None:
            counts[key_group] = int(row[0])
    return counts


@singleflight_lru(
    PERIMETER_CACHE_BYTES,
    sizeof=lambda v: len(v) if v else 1,
    key=lambda conn, boundary_fqn, keys: (boundary_fqn, keys),
)
def zone_perimeter_geojson(conn: duckdb.DuckDBPyConnection, boundary_fqn: str, keys: tuple[str, ...]) -> str | None:
    """One zone's sealed perimeter as a GeoJSON string, memoized. The
    result is pure in (boundary table, key set) — the FQN's schema
    carries the dataset version — so entries never go stale. Callers
    pass keys sorted so equal sets share an entry."""
    row = conn.execute(perimeter_union_sql(boundary_fqn), [list(keys)]).fetchone()
    return row[0] if row is not None else None


def perimeter_union_sql(boundary_fqn: str) -> str:
    """One sealed perimeter over a zone's boundary keys, as GeoJSON.
    Binds [keys]."""
    return f"""
        SELECT ST_AsGeoJSON(
            ST_SimplifyPreserveTopology(
                ST_Buffer(
                    ST_Buffer(ST_Union_Agg(ST_MakeValid(geom)), {PERIMETER_CLOSE_TOLERANCE}),
                    -{PERIMETER_CLOSE_TOLERANCE}
                ),
                {PERIMETER_SIMPLIFY_TOLERANCE}
            )
        )
        FROM {boundary_fqn} WHERE key IN (SELECT unnest(?))
    """


ZONE_FILE_COLUMNS = ("key", "zone")


def write_zone_file(conn: duckdb.DuckDBPyConnection, zones: list[tuple[str, list[str]]], path: str, fmt: str) -> int:
    """Write (zone name, keys) pairs as a two-column key → zone file, one
    row per key, in zone order then key order, the shape the zone import
    reads back. A zone with no keys gets one row with a blank key, so it
    survives a round trip. Returns the row count. `path` is server-generated."""
    rows = [(name, key) for name, zone_keys in zones for key in (zone_keys or [None])]
    names, keys = [name for name, _ in rows], [key for _, key in rows]
    copy_opts = "FORMAT parquet" if fmt == "parquet" else "FORMAT csv, HEADER"
    key_col, zone_col = ZONE_FILE_COLUMNS
    row = conn.execute(
        f"""
        COPY (
            SELECT key AS {key_col}, zone AS {zone_col}
            FROM (SELECT unnest(?::VARCHAR[]) AS zone, unnest(?::VARCHAR[]) AS key,
                         generate_subscripts(?::VARCHAR[], 1) AS i)
            ORDER BY i
        ) TO '{path}' ({copy_opts})
        """,
        [names, keys, keys],
    ).fetchone()
    return int(row[0]) if row else 0


UNKNOWN_KEY_EXAMPLES = 10
# Leading/trailing whitespace as JavaScript's String.prototype.trim sees it
# (ASCII whitespace, Unicode separators, BOM), in RE2 syntax.
TRIM_PATTERN = r"^[\s\x0B\p{Z}\x{FEFF}]+|[\s\x0B\p{Z}\x{FEFF}]+$"
DUPLICATE_KEY_EXAMPLES = 5


def parse_zone_file(conn: duckdb.DuckDBPyConnection, source: str, boundary_fqn: str) -> dict:
    """Read an uploaded key → zone file (CSV or Parquet, header row, key
    column first) into zone definitions for the zone group whose keys live
    in `boundary_fqn`. Every zone named in the file is returned, in
    first-appearance order with its keys in file order; a row with a zone
    name and a blank key names a zone with no units. Rows with no zone name
    and keys outside the boundary table are skipped and reported. A key
    listed under two different zones, an unreadable file, or a file whose
    keys match none of the units raises ValueError."""
    try:
        cols = load_upload_table(conn, source)
    except duckdb.Error as exc:
        raise ValueError("Couldn't read this file as CSV or Parquet.") from exc
    if len(cols) != 2:
        raise ValueError("File must have two columns: unit keys, then zone names.")
    key_col, zone_col = (f'"{c.replace(chr(34), chr(34) * 2)}"' for c in cols)
    # rowid is file order (the upload table is created with insertion order
    # preserved). The trim set matches JavaScript's String.prototype.trim,
    # which the web side applies to zone names before writing them.
    conn.execute(f"""
        CREATE OR REPLACE TEMP TABLE _zone_rows AS
        SELECT rowid AS i,
               nullif(regexp_replace(CAST({key_col} AS VARCHAR), '{TRIM_PATTERN}', '', 'g'), '') AS key,
               nullif(regexp_replace(CAST({zone_col} AS VARCHAR), '{TRIM_PATTERN}', '', 'g'), '') AS zone
        FROM _upload
    """)
    row_count, blank_count, keyed_count = conn.execute(
        "SELECT count(*), count(*) FILTER (key IS NOT NULL AND zone IS NULL), "
        "count(DISTINCT key) FILTER (zone IS NOT NULL) FROM _zone_rows"
    ).fetchone()

    conflicts = [
        r[0]
        for r in conn.execute(f"""
            SELECT key FROM _zone_rows WHERE key IS NOT NULL AND zone IS NOT NULL
            GROUP BY key HAVING count(DISTINCT zone) > 1 ORDER BY min(i) LIMIT {DUPLICATE_KEY_EXAMPLES}
        """).fetchall()
    ]
    if conflicts:
        raise ValueError(f"Some keys are listed under more than one zone: {', '.join(conflicts)}.")

    unknown = conn.execute(f"""
        SELECT key FROM _zone_rows
        WHERE key IS NOT NULL AND zone IS NOT NULL AND key NOT IN (SELECT key FROM {boundary_fqn})
        GROUP BY key ORDER BY min(i)
    """).fetchall()
    if keyed_count > 0 and len(unknown) == keyed_count:
        raise ValueError(
            "None of the keys in this file match this zone group's units. "
            "Check that the first column holds unit keys of the group's type."
        )

    assigned = conn.execute(f"""
        SELECT zone, coalesce(list(key ORDER BY first_i) FILTER (key IS NOT NULL), [])
        FROM (
            SELECT zone, CASE WHEN key IN (SELECT key FROM {boundary_fqn}) THEN key END AS key,
                   min(i) AS first_i
            FROM _zone_rows WHERE zone IS NOT NULL
            GROUP BY ALL
        )
        GROUP BY zone ORDER BY min(first_i)
    """).fetchall()
    if not assigned:
        raise ValueError("No rows in this file name a zone.")
    return {
        "zones": [{"name": name, "keys": keys} for name, keys in assigned],
        "rowCount": int(row_count),
        "blankCount": int(blank_count),
        "unknownCount": len(unknown),
        "unknownKeys": [r[0] for r in unknown[:UNKNOWN_KEY_EXAMPLES]],
    }
