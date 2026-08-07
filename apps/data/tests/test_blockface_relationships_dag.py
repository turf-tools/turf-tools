"""End-to-end tests for the blockface_relationships DAG node.

Builds a synthetic plus-sign intersection with real linestring geometry
in an isolated DuckLake and runs the full node — SQL bearing extraction,
per-node classification, and the write-back — asserting the same facts a
human reads off the drawing.

Layout (around lon -73.99, lat 40.73, so the UTM 18N transform is honest):

                  NN_END
                    │ N        MAIN ST runs E-W (lines W, E)
     NW_END ────────┼──────── NE_END      CROSS ST runs N-S (lines N, S)
              W     │ E
                    │ S        W is digitized *toward* the center node
                  NS_END       (its to-end) to exercise the left/right flip.

MAIN ST is in zip 10001, CROSS ST in zip 10002 — the zip-scoping test
cuts along that line.
"""

import pytest

from src.dags.blockface_relationships import blockface_relationships
from src.models import TableRef

CENTER = (-73.99, 40.73)
STEP = 0.001  # ~85-110m; comfortably longer than the bearing sample

LINES = {
    # line_id: (wkt from -> to, from_node, to_node, zip, mtfcc)
    "E": (f"LINESTRING({CENTER[0]} {CENTER[1]}, {CENTER[0] + STEP} {CENTER[1]})", "NC", "NE_END", "10001"),
    "N": (f"LINESTRING({CENTER[0]} {CENTER[1]}, {CENTER[0]} {CENTER[1] + STEP})", "NC", "NN_END", "10002"),
    # Digitized toward the center: NC is this line's TO end.
    "W": (f"LINESTRING({CENTER[0] - STEP} {CENTER[1]}, {CENTER[0]} {CENTER[1]})", "NW_END", "NC", "10001"),
    "S": (f"LINESTRING({CENTER[0]} {CENTER[1]}, {CENTER[0]} {CENTER[1] - STEP})", "NC", "NS_END", "10002"),
}


@pytest.fixture()
def geo_tables(dual_conn):
    """Production-shaped blockface_unpivoted + edges with the plus-sign."""
    conn = dual_conn
    conn.execute("CREATE SCHEMA IF NOT EXISTS ducklake_geo.tiger")
    conn.execute("""
        CREATE TABLE ducklake_geo.tiger.blockface_unpivoted (
            blockface_id        VARCHAR,
            side                VARCHAR,
            raw_from            VARCHAR,
            raw_to              VARCHAR,
            zip_code            VARCHAR,
            full_name           VARCHAR,
            tiger_line_id       VARCHAR,
            street_name_tokens  VARCHAR[],
            from_node_id        VARCHAR,
            to_node_id          VARCHAR,
            geom                GEOMETRY
        )
    """)
    conn.execute("""
        CREATE TABLE ducklake_geo.tiger.edges (
            tiger_line_id       VARCHAR,
            full_name           VARCHAR,
            feature_class_code  VARCHAR,
            from_node_id        VARCHAR,
            to_node_id          VARCHAR,
            street_name_tokens  VARCHAR[],
            state_fips          VARCHAR,
            county_fips         VARCHAR,
            geom                GEOMETRY
        )
    """)
    for line_id, (wkt, from_node, to_node, zip_code) in LINES.items():
        name = "MAIN ST" if line_id in ("E", "W") else "CROSS ST"
        conn.execute(
            """
            INSERT INTO ducklake_geo.tiger.edges VALUES
            (?, ?, 'S1400', ?, ?, [], '36', '061', ST_GeomFromText(?))
            """,
            [line_id, name, from_node, to_node, wkt],
        )
        for side in ("left", "right"):
            conn.execute(
                """
                INSERT INTO ducklake_geo.tiger.blockface_unpivoted VALUES
                (?, ?, '1', '99', ?, ?, ?, [], ?, ?, ST_GeomFromText(?))
                """,
                [f"{line_id}:{side}", side, zip_code, name, line_id, from_node, to_node, wkt],
            )
    return {
        "unpivoted": TableRef(catalog="ducklake_geo", schema="tiger", table="blockface_unpivoted", version=0),
        "edges": TableRef(catalog="ducklake_geo", schema="tiger", table="edges", version=0),
    }


def _run(conn, geo_tables, zips=None):
    ref = blockface_relationships(geo_tables["unpivoted"], geo_tables["edges"], conn, zips)
    rows = conn.execute(f"""
        SELECT blockface_id_a, blockface_id_b, kind, node_id,
               crossed_line_ids, crossed_classes, penalty_class, crossing_cost_m
        FROM {ref.fqn}
        ORDER BY blockface_id_a, blockface_id_b, COALESCE(node_id, '')
    """).fetchall()
    return rows


def _find(rows, a, b):
    key = tuple(sorted((a, b)))
    matches = [r for r in rows if (r[0], r[1]) == key]
    assert matches, f"no relationship for {key}"
    return matches


class TestPlusSign:
    def test_row_inventory(self, dual_conn, geo_tables):
        rows = _run(dual_conn, geo_tables)
        # 4 mid-block across + 24 center-node pairs + 4 dead-end hinges.
        assert len(rows) == 32
        kinds = {}
        for r in rows:
            kinds[r[2]] = kinds.get(r[2], 0) + 1
        assert kinds == {
            "across": 4,
            "hinge": 4 + 4,  # 4 center corners + 4 dead-end wraps
            "continue": 4,
            "turn": 8,
            "kitty_corner": 8,
        }

    def test_across_rows_are_node_free(self, dual_conn, geo_tables):
        rows = _run(dual_conn, geo_tables)
        across = [r for r in rows if r[2] == "across"]
        for r in across:
            assert r[3] is None
            assert r[4] == [r[0].split(":")[0]]  # crosses its own line
            assert r[6] == "minor"

    def test_flipped_digitization_lands_on_physical_sides(self, dual_conn, geo_tables):
        # W runs west->east (center is its TO end), so W's digitized
        # LEFT is the physical NORTH side. The north-sidewalk continue
        # along MAIN is therefore E:left <-> W:left, crossing N.
        rows = _run(dual_conn, geo_tables)
        (north,) = _find(rows, "E:left", "W:left")
        assert north[2] == "continue"
        assert north[4] == ["N"]
        # And the NW physical corner hinge is N:left <-> W:left.
        (nw,) = _find(rows, "N:left", "W:left")
        assert nw[2] == "hinge"
        assert nw[7] == 0.0

    def test_dead_ends_hinge(self, dual_conn, geo_tables):
        rows = _run(dual_conn, geo_tables)
        for line in ("E", "N", "W", "S"):
            pair_rows = _find(rows, f"{line}:left", f"{line}:right")
            by_kind = {r[2] for r in pair_rows}
            assert by_kind == {"across", "hinge"}  # mid-block + dead-end wrap


class TestZipScoping:
    def test_only_scoped_blockfaces_emit_rows(self, dual_conn, geo_tables):
        rows = _run(dual_conn, geo_tables, zips=["10001"])
        ids = {r[0] for r in rows} | {r[1] for r in rows}
        assert ids == {"E:left", "E:right", "W:left", "W:right"}
        # 2 across + 2 dead-end hinges + 4 center pairs (6 MAIN-only
        # pairs minus 2 same-line ones).
        assert len(rows) == 8

    def test_out_of_scope_edges_still_shape_and_price_crossings(self, dual_conn, geo_tables):
        # CROSS ST is outside the zip scope, but continuing along MAIN
        # still means crossing it — the crossed line must be reported
        # even though no relationship rows are emitted for it.
        rows = _run(dual_conn, geo_tables, zips=["10001"])
        (north,) = _find(rows, "E:left", "W:left")
        assert north[2] == "continue"
        assert north[4] == ["N"]
        assert north[7] > 0.0
