"""Synthetic-data tests for assembly.canonical_addresses + persons_geocoded.

The assembly stage is where the OSM-vs-TIGER source priority for the
canonical `address_line_1` is resolved, and where `osm_only` voters
(TIGER-miss rescues) merge back into the canonical persons table.

These tests construct hand-built upstream tables for the four inputs
(`persons_best_match`, `persons_decomposed`, `refined_positions`,
`osm_only_matches`) and run `assembly.canonical_addresses` /
`assembly.persons_geocoded` directly.
"""

import pytest

from src.dags import assembly
from src.models import TableRef
from src.tables import ensure_org_schema, org_fqn

ORG = "asm_test"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _ref(table: str) -> TableRef:
    return TableRef(catalog="ducklake", schema=ORG, table=table, version=0)


def _create_persons_validated(conn) -> TableRef:
    fqn = org_fqn(ORG, "persons_validated")
    conn.execute(f"DROP TABLE IF EXISTS {fqn}")
    conn.execute(f"""
        CREATE TABLE {fqn} (
            external_id     VARCHAR,
            external_id_type VARCHAR,
            first_name      VARCHAR,
            last_name       VARCHAR,
            address_line_1  VARCHAR,
            address_line_2  VARCHAR,
            city            VARCHAR,
            state           VARCHAR,
            zip5            VARCHAR,
            zip4            VARCHAR,
            other_properties JSON
        )
    """)
    return _ref("persons_validated")


def _create_persons_decomposed(conn) -> TableRef:
    fqn = org_fqn(ORG, "persons_decomposed")
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
    fqn = org_fqn(ORG, "persons_best_match")
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
    fqn = org_fqn(ORG, "refined_positions")
    conn.execute(f"DROP TABLE IF EXISTS {fqn}")
    conn.execute(f"""
        CREATE TABLE {fqn} (
            external_id     VARCHAR,
            latitude        DOUBLE,
            longitude       DOUBLE,
            position_source VARCHAR,
            osm_street      VARCHAR,
            osm_housenumber VARCHAR
        )
    """)
    return _ref("refined_positions")


def _create_osm_only_matches(conn) -> TableRef:
    fqn = org_fqn(ORG, "osm_only_matches")
    conn.execute(f"DROP TABLE IF EXISTS {fqn}")
    conn.execute(f"""
        CREATE TABLE {fqn} (
            external_id     VARCHAR,
            latitude        DOUBLE,
            longitude       DOUBLE,
            osm_street      VARCHAR,
            osm_housenumber VARCHAR,
            blockface_id    VARCHAR,
            snap_distance_m DOUBLE
        )
    """)
    return _ref("osm_only_matches")


@pytest.fixture()
def synth(dual_conn):
    """A connection with empty synthetic-upstream tables in the test org."""
    ensure_org_schema(dual_conn, ORG)
    refs = {
        "validated": _create_persons_validated(dual_conn),
        "decomposed": _create_persons_decomposed(dual_conn),
        "best_match": _create_persons_best_match(dual_conn),
        "refined": _create_refined_positions(dual_conn),
        "osm_only": _create_osm_only_matches(dual_conn),
    }
    return dual_conn, refs


# ---------------------------------------------------------------------------
# canonical_addresses
# ---------------------------------------------------------------------------


class TestCanonicalAddresses:
    def test_osm_street_wins_over_tiger_full_name(self, synth):
        """When a voter has both a TIGER full_name and an OSM street, OSM wins —
        all voters at the same OSM building converge on the same address."""
        conn, refs = synth
        conn.execute(f"""
            INSERT INTO {refs['decomposed'].fqn} VALUES
            ('v1', 123, '', '', 'BROADWAY', ['broadway'], 'odd', '10001')
        """)
        conn.execute(f"""
            INSERT INTO {refs['best_match'].fqn} VALUES
            ('v1', 'bf1', 'T1', 'left', 1, 999, '', 'BROADWAY',
             'n1', 'n2', NULL, 123, 2)
        """)
        conn.execute(f"""
            INSERT INTO {refs['refined'].fqn} VALUES
            ('v1', 40.75, -73.99, 'osm_matched', 'Broadway', '123')
        """)
        ref = assembly.canonical_addresses(
            persons_best_match=refs["best_match"],
            persons_decomposed=refs["decomposed"],
            refined_positions=refs["refined"],
            osm_only_matches=refs["osm_only"],
            organization_slug=ORG,
            conn=conn,
        )
        line1 = conn.execute(
            f"SELECT address_line_1 FROM {ref.fqn} WHERE external_id = 'v1'"
        ).fetchone()[0]
        # Street comes from OSM (UPPER applied).
        assert "BROADWAY" in line1

    def test_osm_housenumber_replaces_voter_when_norms_match(self, synth):
        """`646` ↔ `6-46` should unify under the OSM form when OSM tags it."""
        conn, refs = synth
        conn.execute(f"""
            INSERT INTO {refs['decomposed'].fqn} VALUES
            ('v1', 646, '', '', 'BROADWAY', ['broadway'], 'even', '10001')
        """)
        conn.execute(f"""
            INSERT INTO {refs['best_match'].fqn} VALUES
            ('v1', 'bf1', 'T1', 'left', 1, 999, '', 'BROADWAY',
             'n1', 'n2', NULL, 646, 2)
        """)
        conn.execute(f"""
            INSERT INTO {refs['refined'].fqn} VALUES
            ('v1', 40.75, -73.99, 'osm_matched', 'Broadway', '6-46')
        """)
        ref = assembly.canonical_addresses(
            persons_best_match=refs["best_match"],
            persons_decomposed=refs["decomposed"],
            refined_positions=refs["refined"],
            osm_only_matches=refs["osm_only"],
            organization_slug=ORG,
            conn=conn,
        )
        line1 = conn.execute(
            f"SELECT address_line_1 FROM {ref.fqn} WHERE external_id = 'v1'"
        ).fetchone()[0]
        # Voter wrote 646; OSM uses 6-46; both normalize to "646", so OSM wins.
        assert line1.startswith("6-46 "), f"expected OSM hyphenated form, got {line1!r}"

    def test_osm_housenumber_kept_separate_when_norms_differ(self, synth):
        """When voter's parsed housenumber and OSM's housenumber normalize
        differently (e.g. `100` vs `100A`), keep the voter's form so OSM
        subunit suffixes don't overwrite voter-correct housenumbers."""
        conn, refs = synth
        conn.execute(f"""
            INSERT INTO {refs['decomposed'].fqn} VALUES
            ('v1', 100, '', '', 'BROADWAY', ['broadway'], 'even', '10001')
        """)
        conn.execute(f"""
            INSERT INTO {refs['best_match'].fqn} VALUES
            ('v1', 'bf1', 'T1', 'left', 1, 999, '', 'BROADWAY',
             'n1', 'n2', NULL, 100, 2)
        """)
        conn.execute(f"""
            INSERT INTO {refs['refined'].fqn} VALUES
            ('v1', 40.75, -73.99, 'osm_matched', 'Broadway', '100A')
        """)
        ref = assembly.canonical_addresses(
            persons_best_match=refs["best_match"],
            persons_decomposed=refs["decomposed"],
            refined_positions=refs["refined"],
            osm_only_matches=refs["osm_only"],
            organization_slug=ORG,
            conn=conn,
        )
        line1 = conn.execute(
            f"SELECT address_line_1 FROM {ref.fqn} WHERE external_id = 'v1'"
        ).fetchone()[0]
        # Voter's "100" should stay; OSM's "100A" shouldn't replace it.
        assert line1.startswith("100 "), f"voter form should win when norms differ: {line1!r}"

    def test_tiger_full_name_used_when_no_osm_match(self, synth):
        """When the voter matched TIGER but no OSM record was joined,
        canonical street falls back to TIGER's `full_name`."""
        conn, refs = synth
        conn.execute(f"""
            INSERT INTO {refs['decomposed'].fqn} VALUES
            ('v1', 50, '', '', 'WEST 42 ST', ['42','st','west'], 'even', '10001')
        """)
        conn.execute(f"""
            INSERT INTO {refs['best_match'].fqn} VALUES
            ('v1', 'bf1', 'T1', 'left', 1, 999, '', 'W 42nd St',
             'n1', 'n2', NULL, 50, 2)
        """)
        # NULL osm_street → fall back to TIGER full_name.
        conn.execute(f"""
            INSERT INTO {refs['refined'].fqn} VALUES
            ('v1', 40.75, -73.99, 'tiger_only', NULL, NULL)
        """)
        ref = assembly.canonical_addresses(
            persons_best_match=refs["best_match"],
            persons_decomposed=refs["decomposed"],
            refined_positions=refs["refined"],
            osm_only_matches=refs["osm_only"],
            organization_slug=ORG,
            conn=conn,
        )
        line1 = conn.execute(
            f"SELECT address_line_1 FROM {ref.fqn} WHERE external_id = 'v1'"
        ).fetchone()[0]
        assert "W 42ND ST" in line1.upper(), f"expected TIGER fallback in {line1!r}"

    def test_osm_only_voter_produces_canonical_row(self, synth):
        """A voter rescued by OSM-only lookup (no TIGER blockface match)
        should still get a canonical_addresses row using OSM data."""
        conn, refs = synth
        conn.execute(f"""
            INSERT INTO {refs['decomposed'].fqn} VALUES
            ('v1', 200, '', '', 'AMSTERDAM AVE', ['amsterdam','ave'], 'even', '10024')
        """)
        # No persons_best_match row, no refined_positions row.
        conn.execute(f"""
            INSERT INTO {refs['osm_only'].fqn} VALUES
            ('v1', 40.78, -73.98, 'Amsterdam Avenue', '200', 'bf42', 12.3)
        """)
        ref = assembly.canonical_addresses(
            persons_best_match=refs["best_match"],
            persons_decomposed=refs["decomposed"],
            refined_positions=refs["refined"],
            osm_only_matches=refs["osm_only"],
            organization_slug=ORG,
            conn=conn,
        )
        line1 = conn.execute(
            f"SELECT address_line_1 FROM {ref.fqn} WHERE external_id = 'v1'"
        ).fetchone()[0]
        assert "AMSTERDAM AVENUE" in line1


# ---------------------------------------------------------------------------
# persons_geocoded — assembly of canonical record from upstream sources
# ---------------------------------------------------------------------------


class TestPersonsGeocoded:
    def _seed_validated(self, conn, refs):
        conn.execute(f"""
            INSERT INTO {refs['validated'].fqn} VALUES
            ('v1', 'ny_sboe', 'Alice', 'Smith', '123 BROADWAY', NULL,
             'NEW YORK', 'NY', '10001', NULL, '{{}}')
        """)
        conn.execute(f"""
            INSERT INTO {refs['validated'].fqn} VALUES
            ('v2', 'ny_sboe', 'Bob',   'Jones', '200 AMSTERDAM AVE', 'APT 3B',
             'NEW YORK', 'NY', '10024', NULL, '{{}}')
        """)

    def test_osm_only_voter_included_in_persons_geocoded(self, synth):
        """A voter with no persons_best_match row should still appear in
        persons_geocoded via the osm_only_matches branch, tagged
        position_source='osm_only'."""
        conn, refs = synth
        self._seed_validated(conn, refs)
        # v2 has only osm_only_matches — no best_match, no refined.
        conn.execute(f"""
            INSERT INTO {refs['decomposed'].fqn} VALUES
            ('v2', 200, '', '', 'AMSTERDAM AVE', ['amsterdam','ave'], 'even', '10024')
        """)
        conn.execute(f"""
            INSERT INTO {refs['osm_only'].fqn} VALUES
            ('v2', 40.78, -73.98, 'Amsterdam Avenue', '200', 'bf42', 12.3)
        """)
        canon = assembly.canonical_addresses(
            persons_best_match=refs["best_match"],
            persons_decomposed=refs["decomposed"],
            refined_positions=refs["refined"],
            osm_only_matches=refs["osm_only"],
            organization_slug=ORG,
            conn=conn,
        )
        ref = assembly.persons_geocoded(
            persons_validated=refs["validated"],
            persons_best_match=refs["best_match"],
            canonical_addresses=canon,
            refined_positions=refs["refined"],
            osm_only_matches=refs["osm_only"],
            organization_slug=ORG,
            conn=conn,
        )
        rows = conn.execute(
            f"SELECT external_id, position_source, blockface_id FROM {ref.fqn}"
        ).fetchall()
        assert ('v2', 'osm_only', 'bf42') in rows, (
            f"osm_only voter missing or mis-tagged: {rows}"
        )

    def test_unmatched_voter_excluded(self, synth):
        """A voter that ended up in neither refined_positions nor
        osm_only_matches should be excluded from persons_geocoded
        entirely."""
        conn, refs = synth
        self._seed_validated(conn, refs)
        # No decomposed / refined / osm_only rows for v1 → drops out.
        canon = assembly.canonical_addresses(
            persons_best_match=refs["best_match"],
            persons_decomposed=refs["decomposed"],
            refined_positions=refs["refined"],
            osm_only_matches=refs["osm_only"],
            organization_slug=ORG,
            conn=conn,
        )
        ref = assembly.persons_geocoded(
            persons_validated=refs["validated"],
            persons_best_match=refs["best_match"],
            canonical_addresses=canon,
            refined_positions=refs["refined"],
            osm_only_matches=refs["osm_only"],
            organization_slug=ORG,
            conn=conn,
        )
        ids = {r[0] for r in conn.execute(f"SELECT external_id FROM {ref.fqn}").fetchall()}
        assert 'v1' not in ids

    def test_building_id_and_door_id_format(self, synth):
        """building_id = address_line_1|zip5; door_id = address_line_1|address_line_2|zip5.
        Single-family doors carry an empty middle segment so building_id and
        door_id can never collide."""
        conn, refs = synth
        self._seed_validated(conn, refs)
        # v1 = single-family (address_line_2 NULL)
        conn.execute(f"""
            INSERT INTO {refs['decomposed'].fqn} VALUES
            ('v1', 123, '', '', 'BROADWAY', ['broadway'], 'odd', '10001')
        """)
        conn.execute(f"""
            INSERT INTO {refs['best_match'].fqn} VALUES
            ('v1', 'bf1', 'T1', 'left', 1, 999, '', 'BROADWAY',
             'n1', 'n2', NULL, 123, 2)
        """)
        conn.execute(f"""
            INSERT INTO {refs['refined'].fqn} VALUES
            ('v1', 40.75, -73.99, 'osm_matched', 'Broadway', '123')
        """)
        # v2 = apartment (address_line_2 = 'APT 3B')
        conn.execute(f"""
            INSERT INTO {refs['decomposed'].fqn} VALUES
            ('v2', 200, '', '', 'AMSTERDAM AVE', ['amsterdam','ave'], 'even', '10024')
        """)
        conn.execute(f"""
            INSERT INTO {refs['osm_only'].fqn} VALUES
            ('v2', 40.78, -73.98, 'Amsterdam Avenue', '200', 'bf42', 12.3)
        """)
        canon = assembly.canonical_addresses(
            persons_best_match=refs["best_match"],
            persons_decomposed=refs["decomposed"],
            refined_positions=refs["refined"],
            osm_only_matches=refs["osm_only"],
            organization_slug=ORG,
            conn=conn,
        )
        ref = assembly.persons_geocoded(
            persons_validated=refs["validated"],
            persons_best_match=refs["best_match"],
            canonical_addresses=canon,
            refined_positions=refs["refined"],
            osm_only_matches=refs["osm_only"],
            organization_slug=ORG,
            conn=conn,
        )
        rows = {
            r[0]: r for r in conn.execute(
                f"SELECT external_id, building_id, door_id, address_line_1, zip5 "
                f"FROM {ref.fqn}"
            ).fetchall()
        }
        # Single-family door: middle segment is empty → ends in `||{zip5}`.
        v1 = rows['v1']
        assert v1[1] == f"{v1[3]}|{v1[4]}"
        assert v1[2] == f"{v1[3]}||{v1[4]}"
        assert v1[1] != v1[2]
        # Apartment: middle segment carries the unit string.
        v2 = rows['v2']
        assert v2[1] == f"{v2[3]}|{v2[4]}"
        assert "APT 3B" in v2[2]
        assert v2[1] != v2[2]
