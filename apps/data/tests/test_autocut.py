"""Autocut on hand-placed buildings: the promises the cut makes, checked
on a street plan small enough to reason about.

Two parallel east–west streets (A, north; B, south) each have a row of
houses on each side. Lots are 15 m apart; the streets are 30 m apart.
Crossing A or B costs 15 (local streets). Off to the east, one lone
house sits a kilometre away from everything.

    A north  ●●●●●●●●●●●●●●●●●●●●
    A south  ●●●●●●●●●●●●●●●●●●●●
    B north  ●●●●●●●●●●●●●●●●●●●●                        ● (far)
    B south  ●●●●●●●●●●●●●●●●●●●●
"""

import pytest

import duckdb
from src import autocut
from src.dags.tiger import GEO_CATALOG, TIGER_SCHEMA

LOT_M = 15
HOUSES = 20
LAT0, LON0 = 40.7, -74.0
M_PER_DEG_LAT = 111_320
M_PER_DEG_LON = 111_320 * 0.7578  # cos(40.7°)


def _lon(x_m: float) -> float:
    return LON0 + x_m / M_PER_DEG_LON


def _lat(y_m: float) -> float:
    return LAT0 + y_m / M_PER_DEG_LAT


# Rows of houses, by blockface: y is the row's offset from street A.
ROWS = {
    "A:left": 6,  # north side of A
    "A:right": -6,  # south side of A
    "B:left": -24,  # north side of B (B runs 30 m south of A)
    "B:right": -36,  # south side of B
}


@pytest.fixture()
def conn():
    c = duckdb.connect()
    c.execute("INSTALL spatial; LOAD spatial")
    c.execute(f"ATTACH ':memory:' AS {GEO_CATALOG}")
    c.execute(f"CREATE SCHEMA {GEO_CATALOG}.{TIGER_SCHEMA}")
    c.execute(f"""
        CREATE TABLE {GEO_CATALOG}.{TIGER_SCHEMA}.blockface_relationships (
            blockface_id_a VARCHAR, blockface_id_b VARCHAR, crossing_cost_m DOUBLE
        )
    """)
    c.executemany(
        f"INSERT INTO {GEO_CATALOG}.{TIGER_SCHEMA}.blockface_relationships VALUES (?, ?, ?)",
        [("A:left", "A:right", 15.0), ("B:left", "B:right", 15.0)],
    )
    c.execute(f"CREATE TABLE {GEO_CATALOG}.{TIGER_SCHEMA}.edges (feature_class_code VARCHAR, geom GEOMETRY)")
    c.execute("""
        CREATE TABLE autocut_buildings (
            building_id VARCHAR, longitude DOUBLE, latitude DOUBLE, doors INT, blockface_id VARCHAR
        )
    """)
    yield c
    c.close()


def _seed(conn, doors: int = 1, far: bool = False) -> None:
    rows = [(f"{bf}#{i}", _lon(i * LOT_M), _lat(y), doors, bf) for bf, y in ROWS.items() for i in range(HOUSES)]
    if far:
        rows.append(("far", _lon(HOUSES * LOT_M + 1000), _lat(-24), doors, "B:left"))
    conn.executemany("INSERT INTO autocut_buildings VALUES (?, ?, ?, ?, ?)", rows)


def _turfs(conn) -> dict[str, int]:
    return dict(conn.execute("SELECT building_id, turf FROM autocut_turfs").fetchall())


def _doors(conn) -> list[int]:
    return sorted(
        d
        for (d,) in conn.execute(
            "SELECT sum(b.doors) FROM autocut_turfs t JOIN autocut_buildings b USING (building_id) GROUP BY t.turf"
        ).fetchall()
    )


def test_turfs_stay_under_the_cap_and_over_the_floor(conn) -> None:
    _seed(conn)
    autocut.cut(conn, 20)
    doors = _doors(conn)
    assert max(doors) <= 1.25 * 20
    assert min(doors) >= 20 / 3
    assert len(_turfs(conn)) == 4 * HOUSES


def test_a_row_fills_along_the_street_before_crossing_it(conn) -> None:
    """With a target of one full row, each turf is one side of one street."""
    _seed(conn)
    autocut.cut(conn, HOUSES)
    turfs = _turfs(conn)
    sides = {bf: {turfs[f"{bf}#{i}"] for i in range(HOUSES)} for bf in ROWS}
    assert all(len(s) == 1 for s in sides.values()), sides
    assert len({next(iter(s)) for s in sides.values()}) == 4


def test_a_street_merges_across_before_reaching_around_the_block(conn) -> None:
    """With a target of two rows, both sides of one street join (a 15 m
    crossing) rather than the backs of two streets (no relationship)."""
    _seed(conn)
    autocut.cut(conn, 2 * HOUSES)
    turfs = _turfs(conn)
    same_turf = lambda a, b: turfs[f"{a}#0"] == turfs[f"{b}#0"]  # noqa: E731
    assert same_turf("A:left", "A:right") and same_turf("B:left", "B:right")
    assert not same_turf("A:right", "B:left")


def test_a_far_building_is_left_out_rather_than_forced_in(conn) -> None:
    _seed(conn, far=True)
    autocut.cut(conn, 20)
    assert "far" not in _turfs(conn)


def test_every_turf_draws_as_one_polygon_containing_its_buildings(conn) -> None:
    _seed(conn)
    autocut.cut(conn, 20)
    autocut._trade(conn, 20)
    autocut._balance(conn, 20)
    autocut._trade(conn, 20)
    autocut._build_polygons(conn)
    autocut._absorb_islands(conn)
    autocut._order_drafts(conn, "northwest")
    turfs = _turfs(conn)
    (pieces, drawn) = conn.execute("SELECT count(*), count(DISTINCT turf) FROM autocut_polygons").fetchone()
    assert pieces == drawn == len(set(turfs.values()))
    misplaced = conn.execute("""
        SELECT count(*) FROM autocut_buildings b
        JOIN autocut_turfs t USING (building_id)
        JOIN autocut_polygons p ON ST_Contains(p.geom, ST_Point(b.longitude, b.latitude))
        WHERE p.turf <> t.turf
    """).fetchone()[0]
    assert misplaced == 0
    numbers = [n for (n,) in conn.execute("SELECT number FROM autocut_polygons ORDER BY number").fetchall()]
    assert numbers == list(range(1, len(numbers) + 1))


def test_numbering_starts_in_the_chosen_corner(conn) -> None:
    _seed(conn)
    autocut.cut(conn, 20)
    autocut._build_polygons(conn)
    for start, (lon_side, lat_side) in {
        "northwest": (min, max),
        "northeast": (max, max),
        "southwest": (min, min),
        "southeast": (max, min),
    }.items():
        autocut._order_drafts(conn, start)
        lon, lat = conn.execute(
            "SELECT ST_X(ST_Centroid(geom)), ST_Y(ST_Centroid(geom)) FROM autocut_polygons WHERE number = 1"
        ).fetchone()
        centres = conn.execute(
            "SELECT ST_X(ST_Centroid(geom)), ST_Y(ST_Centroid(geom)) FROM autocut_polygons"
        ).fetchall()
        lons, lats = zip(*centres, strict=True)
        assert abs(lon - lon_side(lons)) < 1e-9 or abs(lat - lat_side(lats)) < 1e-9, start
