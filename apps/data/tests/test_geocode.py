"""Synthetic-data tests for the geocode DAG.

Covers `refined_positions` (the per-voter lat/lon for TIGER-matched
voters) and `osm_only_matches` (the TIGER-miss rescue via direct OSM
lookup).

`refined_positions` has four mutually-exclusive branches keyed on
position_source:

  - `osm_complex`     — voter inside a residential complex → OSM centroid
  - `osm_matched`     — OSM building projects strictly onto blockface
  - `osm_off_segment` — OSM building projects OFF the blockface (clamps)
  - `tiger_only`      — no OSM match → DENSE_RANK fraction along blockface

This file constructs synthetic upstream tables — `persons_best_match`,
`persons_decomposed`, `blockface_final`, `osm_building_lookup`,
`address_tokens` — and asserts each branch is exercised correctly.
"""

import pytest

from src.addressing import (
    canonical_key_sql,
    street_rewrite_sql,
    tokenize_street_sql,
)
from src.dags import geocode, tiger
from src.models import TableRef
from src.tables import ensure_schema, table_fqn

ORG = "geocode_test"


def _org_ref(table: str) -> TableRef:
    return TableRef(catalog="ducklake", schema=ORG, table=table, version=0)


def _create_persons_decomposed(conn) -> TableRef:
    fqn = table_fqn(ORG, "persons_decomposed")
    conn.execute(f"DROP TABLE IF EXISTS {fqn}")
    conn.execute(f"""
        CREATE TABLE {fqn} (
            external_id        VARCHAR,
            house_number       INTEGER,
            house_num_prefix   VARCHAR,
            half_code          VARCHAR,
            street_name_raw    VARCHAR,
            street_name_tokens VARCHAR[],
            number_type        VARCHAR,
            zip5               VARCHAR
        )
    """)
    return _org_ref("persons_decomposed")


def _create_persons_best_match(conn) -> TableRef:
    fqn = table_fqn(ORG, "persons_best_match")
    conn.execute(f"DROP TABLE IF EXISTS {fqn}")
    conn.execute(f"""
        CREATE TABLE {fqn} (
            external_id        VARCHAR,
            blockface_id       VARCHAR,
            tiger_line_id      VARCHAR,
            side               VARCHAR,
            from_house_num     INTEGER,
            to_house_num       INTEGER,
            house_num_prefix   VARCHAR,
            full_name          VARCHAR,
            from_node_id       VARCHAR,
            to_node_id         VARCHAR,
            geom               GEOMETRY,
            person_house_number INTEGER,
            match_score        INTEGER
        )
    """)
    return _org_ref("persons_best_match")


def _create_blockface_final(conn) -> TableRef:
    conn.execute("CREATE SCHEMA IF NOT EXISTS ducklake_geo.tiger")
    conn.execute("DROP TABLE IF EXISTS ducklake_geo.tiger.blockface_final")
    conn.execute("""
        CREATE TABLE ducklake_geo.tiger.blockface_final (
            blockface_id          VARCHAR,
            side                  VARCHAR,
            from_house_num        INTEGER,
            to_house_num          INTEGER,
            house_num_prefix      VARCHAR,
            number_type           VARCHAR,
            zip_code              VARCHAR,
            full_name             VARCHAR,
            tiger_line_id         VARCHAR,
            street_tokens_match   VARCHAR[],
            street_tokens_lookup  VARCHAR[],
            from_node_id          VARCHAR,
            to_node_id            VARCHAR,
            geom                  GEOMETRY
        )
    """)
    return TableRef(catalog="ducklake_geo", schema="tiger", table="blockface_final", version=0)


def _create_osm_building_lookup(conn) -> TableRef:
    conn.execute("CREATE SCHEMA IF NOT EXISTS ducklake_geo.osm")
    conn.execute("DROP TABLE IF EXISTS ducklake_geo.osm.building_lookup")
    conn.execute("""
        CREATE TABLE ducklake_geo.osm.building_lookup (
            zip_code               VARCHAR,
            canonical_key          VARCHAR,
            housenumber            VARCHAR,
            housenumber_norm       VARCHAR,
            street                 VARCHAR,
            osm_lat                DOUBLE,
            osm_lon                DOUBLE,
            in_residential_complex BOOLEAN
        )
    """)
    return TableRef(catalog="ducklake_geo", schema="osm", table="building_lookup", version=0)


def _tokens(conn, s):
    return conn.execute(f"SELECT {tokenize_street_sql('s')} FROM (VALUES (?)) AS t(s)", [s]).fetchone()[0]


def _expanded_tokens(conn, street):
    """Mirror production: tokenize → equivalency-expand. blockface_final and
    osm_building_lookup both expand; this helper produces the same array
    so synthetic test fixtures match what the pipeline would compute."""
    tokens_sql = tokenize_street_sql(street_rewrite_sql("s"))
    return conn.execute(
        f"""
        WITH raw AS (
            SELECT {tokens_sql} AS tokens FROM (VALUES (?)) AS t(s)
        ),
        extras AS (
            SELECT flatten(list(g.equivalent_tokens)) AS extra
            FROM raw, ducklake_geo.tiger.address_tokens g
            WHERE len(list_intersect(raw.tokens, g.equivalent_tokens)) > 0
        )
        SELECT list_distinct(list_concat(
            raw.tokens, COALESCE((SELECT extra FROM extras), [])
        ))
        FROM raw
        """,
        [street],
    ).fetchone()[0]


def _canonical_key(conn, street):
    """Compute the same canonical_key that the production pipeline derives
    on the voter side (`osm_only_matches`) and the OSM side
    (`osm_building_lookup`). Tests insert this value directly into a
    hand-built `osm_building_lookup` row.
    """
    tokens_sql = tokenize_street_sql(street_rewrite_sql("s"))
    return conn.execute(
        f"""
        WITH raw AS (
            SELECT {tokens_sql} AS tokens
            FROM (VALUES (?)) AS t(s)
        ),
        extras AS (
            SELECT flatten(list(g.equivalent_tokens)) AS extra
            FROM raw, ducklake_geo.tiger.address_tokens g
            WHERE len(list_intersect(raw.tokens, g.equivalent_tokens)) > 0
        ),
        combined AS (
            SELECT list_distinct(list_concat(
                raw.tokens,
                COALESCE((SELECT extra FROM extras), [])
            )) AS expanded
            FROM raw
        )
        SELECT {canonical_key_sql("expanded")} FROM combined
        """,
        [street],
    ).fetchone()[0]


@pytest.fixture()
def synth(dual_conn):
    ensure_schema(dual_conn, ORG)
    pd = _create_persons_decomposed(dual_conn)
    pbm = _create_persons_best_match(dual_conn)
    bf = _create_blockface_final(dual_conn)
    obl = _create_osm_building_lookup(dual_conn)
    tokens = tiger.address_tokens(conn=dual_conn)
    return dual_conn, pd, pbm, bf, obl, tokens


def _insert_decomposed(conn, eid, hn, street, zip5="10001", prefix="", half_code=""):
    toks = _tokens(conn, street)
    nt = "odd" if hn % 2 == 1 else "even"
    conn.execute(
        f"INSERT INTO {table_fqn(ORG, 'persons_decomposed')} VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [eid, hn, prefix, half_code, street, toks, nt, zip5],
    )


def _insert_best_match(
    conn,
    eid,
    blockface_id,
    full_name,
    hn,
    prefix="",
    side="left",
    tiger_line_id=None,
    bf_geom="LINESTRING(0 0, 0 0.01)",
):
    if tiger_line_id is None:
        tiger_line_id = blockface_id.split(":")[0]
    conn.execute(
        f"INSERT INTO {table_fqn(ORG, 'persons_best_match')} VALUES "
        "(?, ?, ?, ?, 1, 199, ?, ?, 'n1', 'n2', "
        f"ST_GeomFromText('{bf_geom}'), ?, 2)",
        [eid, blockface_id, tiger_line_id, side, prefix, full_name, hn],
    )


def _insert_blockface(
    conn, blockface_id, full_name, zip_code="10001", side="left", tiger_line_id=None, geom="LINESTRING(0 0, 0 0.01)"
):
    if tiger_line_id is None:
        tiger_line_id = blockface_id.split(":")[0]
    # Production's blockface_final expands tokens via address_tokens. Both
    # `street_tokens_match` and `street_tokens_lookup` carry the expanded
    # set — the test fixture must do the same so canonical_key derivation
    # on the voter side hits the OSM lookup.
    expanded = _expanded_tokens(conn, full_name)
    conn.execute(
        "INSERT INTO ducklake_geo.tiger.blockface_final VALUES "
        "(?, ?, 1, 199, '', 'odd', ?, ?, ?, ?, ?, 'n1', 'n2', "
        f"ST_GeomFromText('{geom}'))",
        [blockface_id, side, zip_code, full_name, tiger_line_id, expanded, expanded],
    )


def _insert_osm_building(
    conn,
    canonical_key,
    housenumber_norm,
    lat,
    lon,
    zip_code="10001",
    street="Broadway",
    housenumber="100",
    in_complex=False,
):
    conn.execute(
        "INSERT INTO ducklake_geo.osm.building_lookup VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [zip_code, canonical_key, housenumber, housenumber_norm, street, lat, lon, in_complex],
    )


# ---------------------------------------------------------------------------
# refined_positions branches
# ---------------------------------------------------------------------------


class TestRefinedPositionsBranches:
    """For each test, set up exactly one voter and shape the OSM/TIGER
    inputs so that exactly one branch fires. Then assert the resulting
    `position_source` is the expected branch and lat/lon land in a
    plausible region.
    """

    def _run(self, conn, pd, pbm, bf, obl):
        return geocode.refined_positions(
            persons_best_match=pbm,
            persons_decomposed=pd,
            blockface_final=bf,
            osm_building_lookup=obl,
            schema=ORG,
            conn=conn,
        )

    def test_osm_complex_branch(self, synth):
        """`in_residential_complex=true` → OSM centroid used directly,
        no road projection."""
        conn, pd, pbm, bf, obl, _ = synth
        _insert_decomposed(conn, "v1", 100, "WEST 42 STREET")
        _insert_best_match(conn, "v1", "T1:left", "West 42 Street", 100)
        # blockface_final.street_tokens_lookup drives canonical_key.
        _insert_blockface(conn, "T1:left", "West 42 Street")
        # OSM record at a distinctive coordinate, in_complex=True.
        canonical_key = _canonical_key(conn, "West 42 Street")
        _insert_osm_building(conn, canonical_key, "100", lat=40.7777, lon=-73.8888, in_complex=True)
        ref = self._run(conn, pd, pbm, bf, obl)
        row = conn.execute(f"SELECT position_source, latitude, longitude FROM {ref.fqn}").fetchone()
        assert row[0] == "osm_complex"
        # Coords ARE the OSM centroid, not a road projection.
        assert row[1] == pytest.approx(40.7777, abs=1e-6)
        assert row[2] == pytest.approx(-73.8888, abs=1e-6)

    def test_osm_off_segment_branch(self, synth):
        """OSM building geometrically projects beyond the matched blockface
        (clamps to fraction 0 or 1). Should use the OSM centroid directly,
        not snap the voter to a wrong endpoint."""
        conn, pd, pbm, bf, obl, _ = synth
        _insert_decomposed(conn, "v1", 100, "WEST 42 STREET")
        # Blockface is a tiny segment near (0,0).
        _insert_best_match(conn, "v1", "T1:left", "West 42 Street", 100, bf_geom="LINESTRING(-74 40.75, -73.999 40.75)")
        _insert_blockface(conn, "T1:left", "West 42 Street", geom="LINESTRING(-74 40.75, -73.999 40.75)")
        # OSM building sits FAR from the blockface — projection will clamp.
        canonical_key = _canonical_key(conn, "West 42 Street")
        _insert_osm_building(conn, canonical_key, "100", lat=40.85, lon=-73.85, in_complex=False)
        ref = self._run(conn, pd, pbm, bf, obl)
        row = conn.execute(f"SELECT position_source, latitude, longitude FROM {ref.fqn}").fetchone()
        assert row[0] == "osm_off_segment"
        # Coords ARE the OSM centroid (not the blockface).
        assert row[1] == pytest.approx(40.85, abs=1e-6)
        assert row[2] == pytest.approx(-73.85, abs=1e-6)

    def test_osm_matched_branch(self, synth):
        """OSM building projects strictly onto the blockface. The voter
        gets the OSM-projected fraction with the perpendicular offset
        applied."""
        conn, pd, pbm, bf, obl, _ = synth
        _insert_decomposed(conn, "v1", 100, "WEST 42 STREET")
        # Long enough blockface that the OSM point projects in its middle.
        bf_geom = "LINESTRING(-74.01 40.75, -73.99 40.75)"
        _insert_best_match(conn, "v1", "T1:left", "West 42 Street", 100, bf_geom=bf_geom)
        _insert_blockface(conn, "T1:left", "West 42 Street", geom=bf_geom)
        # OSM near the middle of the blockface.
        canonical_key = _canonical_key(conn, "West 42 Street")
        _insert_osm_building(conn, canonical_key, "100", lat=40.7501, lon=-74.0, in_complex=False)
        ref = self._run(conn, pd, pbm, bf, obl)
        row = conn.execute(f"SELECT position_source, latitude, longitude FROM {ref.fqn}").fetchone()
        assert row[0] == "osm_matched"
        # Coords land on/near the blockface (latitude ≈ 40.75 +/- offset).
        assert abs(row[1] - 40.75) < 0.001

    def test_tiger_only_branch(self, synth):
        """No OSM building lookup match → fallback to DENSE_RANK fraction
        along the blockface, source='tiger_only'."""
        conn, pd, pbm, bf, obl, _ = synth
        _insert_decomposed(conn, "v1", 100, "WEST 42 STREET")
        bf_geom = "LINESTRING(-74.01 40.75, -73.99 40.75)"
        _insert_best_match(conn, "v1", "T1:left", "West 42 Street", 100, bf_geom=bf_geom)
        _insert_blockface(conn, "T1:left", "West 42 Street", geom=bf_geom)
        # No OSM record inserted → no match.
        ref = self._run(conn, pd, pbm, bf, obl)
        row = conn.execute(f"SELECT position_source, latitude, longitude FROM {ref.fqn}").fetchone()
        assert row[0] == "tiger_only"
        # Coords still land on the blockface.
        assert abs(row[1] - 40.75) < 0.001


class TestRefinedPositionsRankPartition:
    """`DENSE_RANK` partitions by `(tiger_line_id, side)`. Two voters on
    the same `(tlid, side)` with different (prefix, house_number) get
    distinct ranks → distinct positions even when they fall in the same
    blockface_id."""

    def test_two_voters_get_distinct_positions(self, synth):
        conn, pd, pbm, bf, obl, _ = synth
        _insert_decomposed(conn, "v1", 101, "WEST 42 STREET")
        _insert_decomposed(conn, "v2", 103, "WEST 42 STREET")
        bf_geom = "LINESTRING(-74.01 40.75, -73.99 40.75)"
        _insert_best_match(conn, "v1", "T1:left", "West 42 Street", 101, bf_geom=bf_geom)
        _insert_best_match(conn, "v2", "T1:left", "West 42 Street", 103, bf_geom=bf_geom)
        _insert_blockface(conn, "T1:left", "West 42 Street", geom=bf_geom)
        # No OSM → DENSE_RANK fallback path.
        ref = geocode.refined_positions(
            persons_best_match=pbm,
            persons_decomposed=pd,
            blockface_final=bf,
            osm_building_lookup=obl,
            schema=ORG,
            conn=conn,
        )
        rows = {
            r[0]: (r[1], r[2])
            for r in conn.execute(f"SELECT external_id, latitude, longitude FROM {ref.fqn}").fetchall()
        }
        assert rows["v1"] != rows["v2"], "voters with distinct house numbers should get distinct positions"


# ---------------------------------------------------------------------------
# osm_only_matches — TIGER-miss rescue
# ---------------------------------------------------------------------------


class TestOsmOnlyMatches:
    def test_voter_without_best_match_recovered_via_osm(self, synth):
        """A voter with no `persons_best_match` row but a hit in
        `osm_building_lookup` (same canonical_key + housenumber_norm + zip)
        is rescued and snapped to the nearest blockface in the same zip."""
        conn, pd, pbm, bf, obl, tokens = synth
        # Voter exists in persons_decomposed but NOT in persons_best_match.
        _insert_decomposed(conn, "v1", 100, "WEST 42 STREET", zip5="10001")
        # A blockface in the same zip for the snap target.
        _insert_blockface(conn, "T1:left", "West 42 Street", geom="LINESTRING(-74.01 40.75, -73.99 40.75)")
        # OSM record keyed on the same tokens.
        canonical_key = _canonical_key(conn, "West 42 Street")
        _insert_osm_building(conn, canonical_key, "100", lat=40.7501, lon=-73.999)
        ref = geocode.osm_only_matches(
            persons_decomposed=pd,
            persons_best_match=pbm,
            osm_building_lookup=obl,
            blockface_final=bf,
            address_tokens=tokens,
            schema=ORG,
            conn=conn,
        )
        row = conn.execute(f"SELECT external_id, latitude, longitude, blockface_id FROM {ref.fqn}").fetchone()
        assert row is not None, "TIGER-miss voter not rescued"
        eid, lat, lon, bf_id = row
        assert eid == "v1"
        # Coordinates are the OSM centroid.
        assert lat == pytest.approx(40.7501, abs=1e-6)
        # Snapped to a real blockface in the same zip.
        assert bf_id == "T1:left"

    def test_voter_with_best_match_not_rescued_twice(self, synth):
        """Voters who already have a TIGER blockface match should NOT
        appear in osm_only_matches — they go through refined_positions."""
        conn, pd, pbm, bf, obl, tokens = synth
        _insert_decomposed(conn, "v1", 100, "WEST 42 STREET")
        _insert_best_match(conn, "v1", "T1:left", "West 42 Street", 100)
        _insert_blockface(conn, "T1:left", "West 42 Street", geom="LINESTRING(-74.01 40.75, -73.99 40.75)")
        canonical_key = _canonical_key(conn, "West 42 Street")
        _insert_osm_building(conn, canonical_key, "100", lat=40.7501, lon=-73.999)
        ref = geocode.osm_only_matches(
            persons_decomposed=pd,
            persons_best_match=pbm,
            osm_building_lookup=obl,
            blockface_final=bf,
            address_tokens=tokens,
            schema=ORG,
            conn=conn,
        )
        count = conn.execute(f"SELECT count(*) FROM {ref.fqn}").fetchone()[0]
        assert count == 0, "TIGER-matched voter shouldn't appear in osm_only"
