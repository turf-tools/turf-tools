"""Ground-truth validation of the relationship derivation.

The unit tests prove the wedge code matches its own model; these tests
check the model against physical reality using data the derivation
never sees: the East Village sample cut
(``fixtures/sample-turf-east-village.json``), whose 2,160 buildings
were placed by the geocoding pipeline at physical offsets on the
correct side of each street.

Two independent checks:

1. **Side convention.** Buildings the geocoder assigned to
   ``<tlid>:left`` must sit geometrically left of the digitized TIGER
   line (cross-product sign in UTM). If the left/right-vs-digitization
   convention were inverted — the classic bug in this computation —
   agreement would be ~1%, not ~99%. (The residual mismatches are OSM
   complex-centroid placements that stray across the line.)

2. **Kind-vs-geometry separation.** For each derived relationship, the
   angle at the shared node between the two blockfaces' nearest
   buildings must order the way the physical corners do: hinge pairs
   (same corner) tightest, turns near 90°, continue/kitty-corner
   widest. A systematic wedge-assignment error (e.g. a broken
   digitization flip) would swap or blur hinge and kitty-corner.

Skips when the TIGER cache is cold, like the Manhattan golden test.
"""

import json
import math
import tempfile
from collections import defaultdict
from pathlib import Path

import pytest

import duckdb
from src.dags.blockface_relationships import blockface_relationships
from src.dags.tiger import blockface_unpivoted, tiger_addrfeat_raw, tiger_edges_raw

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "sample-turf-east-village.json"

# A building's bearing-from-node is only meaningful near the node.
NEAR_NODE_M = 70.0


def _cache_warm(tiger_cache_dir: str) -> bool:
    cache = Path(tiger_cache_dir)
    return (cache / "addrfeat" / "tl_2024_36061_addrfeat.zip").exists() and (
        cache / "edges" / "tl_2024_36061_edges.zip"
    ).exists()


@pytest.fixture(scope="module")
def setup(tiger_cache_dir):
    if not _cache_warm(tiger_cache_dir):
        pytest.skip("TIGER cache for county 36061 not present; warm it via the pipeline integration test.")

    with open(FIXTURE) as f:
        buildings = json.load(f)["buildings"]

    with tempfile.TemporaryDirectory() as tmpdir:
        conn = duckdb.connect()
        for ext in ("ducklake", "spatial"):
            conn.install_extension(ext)
            conn.load_extension(ext)
        conn.execute(f"ATTACH 'ducklake:{tmpdir}/geo.ducklake' AS geo_ducklake (DATA_PATH '{tmpdir}/geo_data/')")
        conn.execute(f"ATTACH 'ducklake:{tmpdir}/voter.ducklake' AS ducklake (DATA_PATH '{tmpdir}/voter_data/')")
        conn.execute("USE ducklake")

        addrfeat = tiger_addrfeat_raw("2024", "36", ["061"], tiger_cache_dir, conn)
        edges = tiger_edges_raw("2024", "36", ["061"], tiger_cache_dir, conn)
        unpivoted = blockface_unpivoted(addrfeat, edges, conn)
        rels = blockface_relationships(unpivoted, edges, conn, ["10003", "10009"])

        conn.execute("CREATE TEMP TABLE _sample_buildings (blockface_id VARCHAR, lng DOUBLE, lat DOUBLE)")
        conn.executemany(
            "INSERT INTO _sample_buildings VALUES (?, ?, ?)",
            [(b["blockfaceId"], b["lng"], b["lat"]) for b in buildings if b.get("blockfaceId")],
        )

        yield {"conn": conn, "edges": edges, "rels": rels}
        conn.close()


def test_geocoded_buildings_agree_with_side_convention(setup):
    conn, edges = setup["conn"], setup["edges"]
    agree, total = conn.execute(f"""
        WITH lines AS (
            SELECT tiger_line_id, ANY_VALUE(ST_Transform(geom, 'OGC:CRS84', 'EPSG:32618')) AS line_m
            FROM {edges.fqn} GROUP BY tiger_line_id
        ),
        pts AS (
            SELECT split_part(b.blockface_id, ':', 2) AS claimed_side,
                   l.line_m,
                   ST_Transform(ST_Point(b.lng, b.lat), 'OGC:CRS84', 'EPSG:32618') AS pt_m
            FROM _sample_buildings b
            JOIN lines l ON l.tiger_line_id = split_part(b.blockface_id, ':', 1)
        ),
        placed AS (
            SELECT claimed_side, pt_m,
                   ST_LineInterpolatePoint(line_m, GREATEST(ST_LineLocatePoint(line_m, pt_m) - 0.02, 0.0)) AS p0,
                   ST_LineInterpolatePoint(line_m, LEAST(ST_LineLocatePoint(line_m, pt_m) + 0.02, 1.0)) AS p1
            FROM pts
        )
        SELECT
            count(*) FILTER (
                claimed_side = CASE WHEN (ST_X(p1) - ST_X(p0)) * (ST_Y(pt_m) - ST_Y(p0))
                                       - (ST_Y(p1) - ST_Y(p0)) * (ST_X(pt_m) - ST_X(p0)) > 0
                                    THEN 'left' ELSE 'right' END
            ),
            count(*)
        FROM placed
    """).fetchone()
    assert total > 2000
    assert agree / total > 0.97


def test_relationship_kinds_separate_by_building_geometry(setup):
    conn, edges, rels = setup["conn"], setup["edges"], setup["rels"]

    node_xy: dict[str, tuple[float, float]] = {}
    for from_node, to_node, x0, y0, x1, y1 in conn.execute(f"""
        WITH lines AS (
            SELECT tiger_line_id, ANY_VALUE(ST_Transform(geom, 'OGC:CRS84', 'EPSG:32618')) AS gm,
                   ANY_VALUE(from_node_id) AS from_node_id, ANY_VALUE(to_node_id) AS to_node_id
            FROM {edges.fqn} GROUP BY tiger_line_id
        )
        SELECT from_node_id, to_node_id,
               ST_X(ST_StartPoint(gm)), ST_Y(ST_StartPoint(gm)),
               ST_X(ST_EndPoint(gm)), ST_Y(ST_EndPoint(gm))
        FROM lines
    """).fetchall():
        node_xy[from_node] = (x0, y0)
        node_xy[to_node] = (x1, y1)

    bf_pts: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for bf_id, x, y in conn.execute("""
        SELECT blockface_id,
               ST_X(ST_Transform(ST_Point(lng, lat), 'OGC:CRS84', 'EPSG:32618')),
               ST_Y(ST_Transform(ST_Point(lng, lat), 'OGC:CRS84', 'EPSG:32618'))
        FROM _sample_buildings
    """).fetchall():
        bf_pts[bf_id].append((x, y))

    def bearing_to_nearest(bf_id: str, nx: float, ny: float) -> float | None:
        best = None
        for x, y in bf_pts.get(bf_id, ()):
            d = math.hypot(x - nx, y - ny)
            if d < NEAR_NODE_M and (best is None or d < best[0]):
                best = (d, math.atan2(y - ny, x - nx))
        return None if best is None else best[1]

    angles: dict[str, list[float]] = defaultdict(list)
    for a_id, b_id, kind, node in conn.execute(
        f"SELECT blockface_id_a, blockface_id_b, kind, node_id FROM {rels.fqn} WHERE node_id IS NOT NULL"
    ).fetchall():
        if node not in node_xy:
            continue
        nx, ny = node_xy[node]
        ba, bb = bearing_to_nearest(a_id, nx, ny), bearing_to_nearest(b_id, nx, ny)
        if ba is None or bb is None:
            continue
        diff = abs(math.degrees(ba - bb))
        angles[kind].append(min(diff, 360.0 - diff))

    def median(kind: str) -> float:
        v = sorted(angles[kind])
        assert len(v) > 100, f"too few {kind} samples to be meaningful: {len(v)}"
        return v[len(v) // 2]

    # Physical ordering of the corner geometries, with clear separation
    # between same-corner (hinge) and diagonal (kitty_corner). Measured
    # 2026-07-03: hinge 64.5°, turn 89.9°, kitty 148.7°, continue 151.0°.
    assert median("hinge") < 80.0
    assert 80.0 < median("turn") < 105.0
    assert median("continue") > 130.0
    assert median("kitty_corner") > 130.0
    assert median("kitty_corner") - median("hinge") > 45.0
