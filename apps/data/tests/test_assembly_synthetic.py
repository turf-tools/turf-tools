"""Synthetic-data tests for assembly.canonical_addresses + persons_geocoded.

The assembly stage is where each building's canonical `address_line_1`
(street spelling, house-number form) and ZIP are settled, and where
`osm_only` voters (TIGER-miss rescues) merge back into the canonical
persons table.

These tests construct hand-built upstream tables for the inputs
(`persons_best_match`, `persons_decomposed`, `refined_positions`,
`osm_only_matches`, `address_tokens`) and run
`assembly.canonical_addresses` / `assembly.persons_geocoded` directly.
"""

import pytest

from src.addressing import canonical_key_sql, street_rewrite_sql, tokenize_street_sql
from src.dags import aggregate, assembly, tiger
from src.models import TableRef
from src.tables import ensure_schema, table_fqn

ORG = "asm_test"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _ref(table: str) -> TableRef:
    return TableRef(catalog="ducklake", schema=ORG, table=table, version=0)


def _create_persons_validated(conn) -> TableRef:
    fqn = table_fqn(ORG, "persons_validated")
    conn.execute(f"DROP TABLE IF EXISTS {fqn}")
    conn.execute(f"""
        CREATE TABLE {fqn} (
            external_id            VARCHAR,
            external_id_type       VARCHAR,
            first_name             VARCHAR,
            last_name              VARCHAR,
            address_line_1         VARCHAR,
            address_line_2         VARCHAR,
            half_code              VARCHAR,
            city                   VARCHAR,
            state                  VARCHAR,
            zip5                   VARCHAR,
            zip4                   VARCHAR,
            county_fips            VARCHAR,
            enrollment             VARCHAR,
            gender                 VARCHAR,
            date_of_birth          VARCHAR,
            registration_date      VARCHAR,
            registration_status    VARCHAR,
            last_voted_date        VARCHAR,
            county_code            VARCHAR,
            precinct               VARCHAR,
            assembly_district      VARCHAR,
            senate_district        VARCHAR,
            congressional_district VARCHAR,
            voting_history         STRUCT(year INT, type VARCHAR, date VARCHAR, method VARCHAR)[]
        )
    """)
    return _ref("persons_validated")


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
    return _ref("persons_decomposed")


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
    return _ref("persons_best_match")


def _create_refined_positions(conn) -> TableRef:
    fqn = table_fqn(ORG, "refined_positions")
    conn.execute(f"DROP TABLE IF EXISTS {fqn}")
    conn.execute(f"""
        CREATE TABLE {fqn} (
            external_id     VARCHAR,
            latitude        DOUBLE,
            longitude       DOUBLE,
            position_source VARCHAR,
            osm_street      VARCHAR,
            osm_housenumber VARCHAR,
            osm_id          BIGINT,
            osm_kind        VARCHAR,
            osm_key         VARCHAR
        )
    """)
    return _ref("refined_positions")


def _create_osm_only_matches(conn) -> TableRef:
    fqn = table_fqn(ORG, "osm_only_matches")
    conn.execute(f"DROP TABLE IF EXISTS {fqn}")
    conn.execute(f"""
        CREATE TABLE {fqn} (
            external_id     VARCHAR,
            latitude        DOUBLE,
            longitude       DOUBLE,
            osm_street      VARCHAR,
            osm_housenumber VARCHAR,
            osm_id          BIGINT,
            osm_kind        VARCHAR,
            osm_key         VARCHAR,
            blockface_id    VARCHAR,
            snap_distance_m DOUBLE
        )
    """)
    return _ref("osm_only_matches")


def _key(conn, street):
    """The street key `osm_addresses_keyed` would compute for `street`."""
    return conn.execute(
        f"""
        WITH raw AS (
            SELECT {tokenize_street_sql(street_rewrite_sql("s"))} AS tokens FROM (VALUES (?)) AS t(s)
        ),
        extras AS (
            SELECT flatten(list(g.equivalent_tokens)) AS extra
            FROM raw, ducklake_geo.tiger.address_tokens g
            WHERE len(list_intersect(raw.tokens, g.equivalent_tokens)) > 0
        )
        SELECT {canonical_key_sql("list_distinct(list_concat(raw.tokens, COALESCE((SELECT extra FROM extras), [])))")}
        FROM raw
        """,
        [street],
    ).fetchone()[0]


@pytest.fixture()
def synth(dual_conn):
    """A connection with empty synthetic-upstream tables in the test org."""
    ensure_schema(dual_conn, ORG)
    refs = {
        "validated": _create_persons_validated(dual_conn),
        "decomposed": _create_persons_decomposed(dual_conn),
        "best_match": _create_persons_best_match(dual_conn),
        "refined": _create_refined_positions(dual_conn),
        "osm_only": _create_osm_only_matches(dual_conn),
        "tokens": tiger.address_tokens(conn=dual_conn),
    }
    return dual_conn, refs


def _voter(conn, refs, eid, hn, zip5="10001"):
    conn.execute(
        f"INSERT INTO {refs['decomposed'].fqn} VALUES (?, ?, '', '', 'RAW', ['raw'], 'even', ?)",
        [eid, hn, zip5],
    )


def _tiger(conn, refs, eid, full_name, hn, blockface_id="bf1"):
    conn.execute(
        f"""INSERT INTO {refs["best_match"].fqn} VALUES
            (?, ?, 'T1', 'left', 1, 999, '', ?, 'n1', 'n2', NULL, ?, 2)""",
        [eid, blockface_id, full_name, hn],
    )


def _refined(conn, refs, eid, osm_street=None, osm_hn=None, osm_id=None, source="osm_matched"):
    """A TIGER-matched voter's position; `osm_street` set = matched an OSM record."""
    key = _key(conn, osm_street) if osm_street else None
    kind = "way" if osm_id is not None else None
    conn.execute(
        f"INSERT INTO {refs['refined'].fqn} VALUES (?, 40.75, -73.99, ?, ?, ?, ?, ?, ?)",
        [eid, source if osm_street else "tiger_only", osm_street, osm_hn, osm_id, kind, key],
    )


def _osm_only(conn, refs, eid, osm_street, osm_hn, osm_id):
    conn.execute(
        f"INSERT INTO {refs['osm_only'].fqn} VALUES (?, 40.78, -73.98, ?, ?, ?, 'way', ?, 'bf42', 12.3)",
        [eid, osm_street, osm_hn, osm_id, _key(conn, osm_street)],
    )


def _canonical(conn, refs) -> dict[str, tuple[str, str]]:
    """external_id → (address_line_1, building_zip5)."""
    ref = assembly.canonical_addresses(
        persons_best_match=refs["best_match"],
        persons_decomposed=refs["decomposed"],
        refined_positions=refs["refined"],
        osm_only_matches=refs["osm_only"],
        address_tokens=refs["tokens"],
        schema=ORG,
        conn=conn,
    )
    rows = conn.execute(f"SELECT external_id, address_line_1, building_zip5 FROM {ref.fqn}").fetchall()
    return {eid: (line1, zip5) for eid, line1, zip5 in rows}


# ---------------------------------------------------------------------------
# canonical_addresses
# ---------------------------------------------------------------------------


class TestStreetSpelling:
    def test_tiger_spelling_when_keys_match(self, synth):
        """OSM and TIGER name the same street: show TIGER's spelling."""
        conn, refs = synth
        _voter(conn, refs, "v1", 50)
        _tiger(conn, refs, "v1", "W 42nd St", 50)
        _refined(conn, refs, "v1", "West 42nd Street", "50", osm_id=1)
        assert _canonical(conn, refs)["v1"][0] == "50 W 42ND ST"

    def test_osm_street_when_keys_differ(self, synth):
        """TIGER named a different street for the range: keep OSM's."""
        conn, refs = synth
        _voter(conn, refs, "v1", 11301)
        _tiger(conn, refs, "v1", "Stoner Rd", 11301)
        _refined(conn, refs, "v1", "Sylvan Green Lane", "11301", osm_id=1)
        assert _canonical(conn, refs)["v1"][0] == "11301 SYLVAN GREEN LANE"

    def test_one_spelling_per_osm_building(self, synth):
        """A voter whose TIGER name disagrees with OSM takes the spelling of a
        neighbour at the same OSM building whose TIGER name agrees."""
        conn, refs = synth
        for eid, tiger_name in (("v1", "Beach 216th St"), ("v2", "Tioga Walk")):
            _voter(conn, refs, eid, 80, zip5="11697")
            _tiger(conn, refs, eid, tiger_name, 80)
            _refined(conn, refs, eid, "Beach 216th Street", "80", osm_id=7)
        rows = _canonical(conn, refs)
        assert rows["v1"][0] == rows["v2"][0] == "80 BEACH 216TH ST"

    def test_building_without_agreeing_tiger_name_takes_zip_spelling(self, synth):
        """Nobody at the building matched TIGER's name for its street, but a
        neighbour in the ZIP did: the building shows that spelling."""
        conn, refs = synth
        _voter(conn, refs, "v1", 10, zip5="10314")
        _tiger(conn, refs, "v1", "Vandalia Ave", 10)
        _refined(conn, refs, "v1", "Vandalia Avenue", "10", osm_id=1)
        _voter(conn, refs, "v2", 20, zip5="10314")
        _tiger(conn, refs, "v2", "Old Vandalia Ave", 20)
        _refined(conn, refs, "v2", "Vandalia Avenue", "20", osm_id=2)
        assert _canonical(conn, refs)["v2"][0] == "20 VANDALIA AVE"

    def test_spelling_looked_up_in_the_building_zip(self, synth):
        """Voters at one building who write different ZIPs share the spelling
        found in the building's ZIP."""
        conn, refs = synth
        _voter(conn, refs, "v0", 90, zip5="10007")
        _tiger(conn, refs, "v0", "Park Ave", 90)
        _refined(conn, refs, "v0")
        for eid, zip5 in (("v1", "10007"), ("v2", "10007"), ("v3", "10038")):
            _voter(conn, refs, eid, 180, zip5=zip5)
            _osm_only(conn, refs, eid, "Park Avenue", "180", osm_id=9)
        rows = _canonical(conn, refs)
        assert {rows[e] for e in ("v1", "v2", "v3")} == {("180 PARK AVE", "10007")}

    def test_tiger_full_name_used_when_no_osm_match(self, synth):
        conn, refs = synth
        _voter(conn, refs, "v1", 50)
        _tiger(conn, refs, "v1", "W 42nd St", 50)
        _refined(conn, refs, "v1")
        assert _canonical(conn, refs)["v1"][0] == "50 W 42ND ST"

    def test_osm_only_voter_takes_building_spelling(self, synth):
        """An osm_only voter at an OSM building with a TIGER-matched voter
        shares that voter's spelling."""
        conn, refs = synth
        _voter(conn, refs, "v1", 200, zip5="10024")
        _tiger(conn, refs, "v1", "Amsterdam Ave", 200)
        _refined(conn, refs, "v1", "Amsterdam Avenue", "200", osm_id=3)
        _voter(conn, refs, "v2", 200, zip5="10024")
        _osm_only(conn, refs, "v2", "Amsterdam Avenue", "200", osm_id=3)
        assert _canonical(conn, refs)["v2"][0] == "200 AMSTERDAM AVE"

    def test_osm_only_voter_borrows_zip_spelling(self, synth):
        """With no TIGER-matched neighbour in the building, an osm_only voter
        takes the TIGER spelling of the same street in their ZIP — and only
        their ZIP."""
        conn, refs = synth
        _voter(conn, refs, "v1", 300, zip5="10025")
        _tiger(conn, refs, "v1", "Riverside Dr", 300)
        _refined(conn, refs, "v1")
        _voter(conn, refs, "v2", 310, zip5="10025")
        _osm_only(conn, refs, "v2", "Riverside Drive", "310", osm_id=4)
        _voter(conn, refs, "v3", 320, zip5="10024")
        _osm_only(conn, refs, "v3", "Riverside Drive", "320", osm_id=5)
        rows = _canonical(conn, refs)
        assert rows["v2"][0] == "310 RIVERSIDE DR"
        assert rows["v3"][0] == "320 RIVERSIDE DRIVE"

    def test_osm_only_voter_keeps_osm_street_with_nothing_to_borrow(self, synth):
        conn, refs = synth
        _voter(conn, refs, "v1", 200, zip5="10024")
        _osm_only(conn, refs, "v1", "Amsterdam Avenue", "200", osm_id=3)
        assert _canonical(conn, refs)["v1"][0] == "200 AMSTERDAM AVENUE"


class TestHouseNumber:
    def test_osm_housenumber_replaces_voter_when_norms_match(self, synth):
        """`646` ↔ `6-46` unify under the OSM form when OSM tags it."""
        conn, refs = synth
        _voter(conn, refs, "v1", 646)
        _tiger(conn, refs, "v1", "Broadway", 646)
        _refined(conn, refs, "v1", "Broadway", "6-46", osm_id=1)
        line1 = _canonical(conn, refs)["v1"][0]
        assert line1.startswith("6-46 "), f"expected OSM hyphenated form, got {line1!r}"

    def test_osm_housenumber_kept_separate_when_norms_differ(self, synth):
        """Voter `100` vs OSM `100A`: OSM's subunit suffix doesn't overwrite
        the voter's number."""
        conn, refs = synth
        _voter(conn, refs, "v1", 100)
        _tiger(conn, refs, "v1", "Broadway", 100)
        _refined(conn, refs, "v1", "Broadway", "100A", osm_id=1)
        line1 = _canonical(conn, refs)["v1"][0]
        assert line1.startswith("100 "), f"voter form should win when norms differ: {line1!r}"


class TestBuildingZip:
    def test_majority_zip_per_osm_building(self, synth):
        """Voters at one OSM building who write different ZIPs share the most
        common one."""
        conn, refs = synth
        for eid, zip5 in (("v1", "10038"), ("v2", "10007"), ("v3", "10007")):
            _voter(conn, refs, eid, 180, zip5=zip5)
            _osm_only(conn, refs, eid, "Park Row", "180", osm_id=9)
        assert {z for _, z in _canonical(conn, refs).values()} == {"10007"}

    def test_tied_zip_takes_lowest(self, synth):
        conn, refs = synth
        for eid, zip5 in (("v1", "10038"), ("v2", "10007")):
            _voter(conn, refs, eid, 180, zip5=zip5)
            _osm_only(conn, refs, eid, "Park Row", "180", osm_id=9)
        assert {z for _, z in _canonical(conn, refs).values()} == {"10007"}

    def test_tiger_building_is_blockface_side_and_address(self, synth):
        """Without OSM, voters at one address on one blockface side are one
        building, whatever ZIPs they write; another side is another building."""
        conn, refs = synth
        for eid, zip5, bf in (("v1", "11239", "bf1"), ("v2", "11208", "bf1"), ("v3", "11239", "bf2")):
            _voter(conn, refs, eid, 1149, zip5=zip5)
            _tiger(conn, refs, eid, "Elton St", 1149, blockface_id=bf)
            _refined(conn, refs, eid)
        rows = _canonical(conn, refs)
        assert rows["v1"][1] == rows["v2"][1] == "11208"
        assert rows["v3"][1] == "11239"


# ---------------------------------------------------------------------------
# persons_geocoded — assembly of canonical record from upstream sources
# ---------------------------------------------------------------------------


class TestPersonsGeocoded:
    def _seed_validated(self, conn, refs, rows):
        """rows: (external_id, address_line_2, zip5)."""
        for eid, line2, zip5 in rows:
            conn.execute(
                f"""INSERT INTO {refs["validated"].fqn}
                        (external_id, external_id_type, first_name, last_name,
                         address_line_1, address_line_2, city, state, zip5, voting_history)
                    VALUES (?, 'ny_sboe', 'A', 'B', 'RAW', ?, 'NEW YORK', 'NY', ?, [])""",
                [eid, line2, zip5],
            )

    def _geocoded(self, conn, refs) -> TableRef:
        canon = assembly.canonical_addresses(
            persons_best_match=refs["best_match"],
            persons_decomposed=refs["decomposed"],
            refined_positions=refs["refined"],
            osm_only_matches=refs["osm_only"],
            address_tokens=refs["tokens"],
            schema=ORG,
            conn=conn,
        )
        return assembly.persons_geocoded(
            persons_validated=refs["validated"],
            persons_best_match=refs["best_match"],
            canonical_addresses=canon,
            refined_positions=refs["refined"],
            osm_only_matches=refs["osm_only"],
            schema=ORG,
            conn=conn,
        )

    def test_osm_only_voter_included_in_persons_geocoded(self, synth):
        """A voter with no persons_best_match row appears via the
        osm_only_matches branch, tagged position_source='osm_only'."""
        conn, refs = synth
        self._seed_validated(conn, refs, [("v2", "APT 3B", "10024")])
        _voter(conn, refs, "v2", 200, zip5="10024")
        _osm_only(conn, refs, "v2", "Amsterdam Avenue", "200", osm_id=3)
        ref = self._geocoded(conn, refs)
        rows = conn.execute(f"SELECT external_id, position_source, blockface_id FROM {ref.fqn}").fetchall()
        assert ("v2", "osm_only", "bf42") in rows, f"osm_only voter missing or mis-tagged: {rows}"

    def test_unmatched_voter_excluded(self, synth):
        """A voter in neither refined_positions nor osm_only_matches is
        excluded from persons_geocoded."""
        conn, refs = synth
        self._seed_validated(conn, refs, [("v1", None, "10001")])
        ref = self._geocoded(conn, refs)
        ids = {r[0] for r in conn.execute(f"SELECT external_id FROM {ref.fqn}").fetchall()}
        assert "v1" not in ids

    def test_building_id_and_door_id_format(self, synth):
        """building_id = address_line_1|building_zip5; door_id =
        address_line_1|address_line_2|building_zip5. Single-family doors carry
        an empty middle segment so building_id and door_id can never collide."""
        conn, refs = synth
        self._seed_validated(conn, refs, [("v1", None, "10001"), ("v2", "APT 3B", "10024")])
        _voter(conn, refs, "v1", 123, zip5="10001")
        _tiger(conn, refs, "v1", "Broadway", 123)
        _refined(conn, refs, "v1", "Broadway", "123", osm_id=1)
        _voter(conn, refs, "v2", 200, zip5="10024")
        _osm_only(conn, refs, "v2", "Amsterdam Avenue", "200", osm_id=3)
        ref = self._geocoded(conn, refs)
        rows = {
            r[0]: r
            for r in conn.execute(
                f"SELECT external_id, building_id, door_id, address_line_1, building_zip5 FROM {ref.fqn}"
            ).fetchall()
        }
        v1 = rows["v1"]
        assert v1[1] == f"{v1[3]}|{v1[4]}"
        assert v1[2] == f"{v1[3]}||{v1[4]}"
        v2 = rows["v2"]
        assert v2[1] == f"{v2[3]}|{v2[4]}"
        assert "APT 3B" in v2[2]
        assert v2[1] != v2[2]

    def test_one_building_across_voter_zips(self, synth):
        """Voters at one OSM building who write different ZIPs share one
        building_id and one buildings_geocoded row; each keeps their own zip5."""
        conn, refs = synth
        voters = [("v1", "10007"), ("v2", "10007"), ("v3", "10038")]
        self._seed_validated(conn, refs, [(eid, None, zip5) for eid, zip5 in voters])
        for eid, zip5 in voters:
            _voter(conn, refs, eid, 180, zip5=zip5)
            _osm_only(conn, refs, eid, "Park Row", "180", osm_id=9)
        ref = self._geocoded(conn, refs)
        rows = conn.execute(f"SELECT external_id, zip5, building_id FROM {ref.fqn} ORDER BY 1").fetchall()
        assert [(eid, zip5) for eid, zip5, _ in rows] == voters
        assert {b for _, _, b in rows} == {"180 PARK ROW|10007"}
        buildings = aggregate.buildings_geocoded(persons_geocoded=ref, schema=ORG, conn=conn)
        assert conn.execute(f"SELECT building_id, zip5, person_count FROM {buildings.fqn}").fetchall() == [
            ("180 PARK ROW|10007", "10007", 3)
        ]
