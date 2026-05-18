"""Synthetic-data tests for the matching DAG.

Covers the three nodes in `src/dags/matching.py`:

- `persons_decomposed` — parse `address_line_1` into house number,
  prefix, half_code, tokens, number_type.
- `persons_candidates` — inverted-index join voter ↔ blockface with
  generic-token gating and opposing-cardinal rejection.
- `persons_best_match` — ROW_NUMBER pick with deterministic tiebreak.

All tests build minimal upstream tables by hand. No TIGER download, no
OSM PBF; runs in well under a second.
"""

import pytest

from src.addressing import tokenize_street_sql
from src.dags import matching
from src.models import TableRef
from src.tables import ensure_org_schema, org_fqn

ORG = "matching_test"


def _ref(table: str) -> TableRef:
    return TableRef(catalog="ducklake", schema=ORG, table=table, version=0)


def _create_persons_validated(conn) -> TableRef:
    fqn = org_fqn(ORG, "persons_validated")
    conn.execute(f"DROP TABLE IF EXISTS {fqn}")
    conn.execute(f"""
        CREATE TABLE {fqn} (
            external_id      VARCHAR,
            external_id_type VARCHAR,
            first_name       VARCHAR,
            last_name        VARCHAR,
            address_line_1   VARCHAR,
            address_line_2   VARCHAR,
            half_code        VARCHAR,
            city             VARCHAR,
            state            VARCHAR,
            zip5             VARCHAR,
            zip4             VARCHAR,
            other_properties JSON
        )
    """)
    return _ref("persons_validated")


def _create_blockface_final(conn) -> TableRef:
    """A minimal blockface_final under the geo_ducklake catalog. Schema
    mirrors the production table from src/dags/tiger.py."""
    conn.execute("CREATE SCHEMA IF NOT EXISTS geo_ducklake.tiger")
    conn.execute("DROP TABLE IF EXISTS geo_ducklake.tiger.blockface_final")
    conn.execute("""
        CREATE TABLE geo_ducklake.tiger.blockface_final (
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
    return TableRef(catalog="geo_ducklake", schema="tiger", table="blockface_final", version=0)


def _insert_validated(
    conn,
    external_id,
    address_line_1,
    zip5="10001",
    half_code=None,
    address_line_2=None,
):
    conn.execute(
        f"""INSERT INTO {org_fqn(ORG, "persons_validated")} VALUES
           (?, 'ny_sboe', 'Test', 'Person', ?, ?, ?, 'NEW YORK', 'NY', ?, NULL, '{{}}')""",
        [external_id, address_line_1, address_line_2, half_code, zip5],
    )


def _tokens(conn, s):
    """Tokenize via the same SQL helper the pipeline uses."""
    return conn.execute(f"SELECT {tokenize_street_sql('s')} FROM (VALUES (?)) AS t(s)", [s]).fetchone()[0]


def _insert_blockface(
    conn,
    blockface_id,
    full_name,
    from_hn,
    to_hn,
    *,
    zip_code="10001",
    side="left",
    prefix="",
    tiger_line_id=None,
    number_type=None,
    match_tokens=None,
):
    """Insert one synthetic blockface_final row.

    Equivalency expansion isn't applied here — tests that need it explicitly
    set `match_tokens`.
    """
    if number_type is None:
        number_type = (
            "odd"
            if (from_hn % 2 == 1 and to_hn % 2 == 1)
            else "even"
            if (from_hn % 2 == 0 and to_hn % 2 == 0)
            else "mixed"
        )
    tokens = match_tokens if match_tokens is not None else _tokens(conn, full_name)
    if tiger_line_id is None:
        tiger_line_id = blockface_id.split(":")[0]
    conn.execute(
        """INSERT INTO geo_ducklake.tiger.blockface_final VALUES
           (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'n1', 'n2',
            ST_GeomFromText('LINESTRING(0 0, 1 1)'))""",
        [blockface_id, side, from_hn, to_hn, prefix, number_type, zip_code, full_name, tiger_line_id, tokens, tokens],
    )


@pytest.fixture()
def synth(dual_conn):
    """Connection with empty synthetic persons_validated + blockface_final."""
    ensure_org_schema(dual_conn, ORG)
    validated = _create_persons_validated(dual_conn)
    bf = _create_blockface_final(dual_conn)
    return dual_conn, validated, bf


# ---------------------------------------------------------------------------
# persons_decomposed
# ---------------------------------------------------------------------------


class TestPersonsDecomposed:
    def test_plain_address_parses(self, synth):
        conn, validated, _ = synth
        _insert_validated(conn, "v1", "123 BROADWAY")
        ref = matching.persons_decomposed(
            persons_validated=validated,
            organization_slug=ORG,
            conn=conn,
        )
        row = conn.execute(
            f"SELECT house_number, house_num_prefix, number_type FROM {ref.fqn} WHERE external_id = 'v1'"
        ).fetchone()
        assert row == (123, "", "odd")

    def test_queens_hyphen_prefix_parses(self, synth):
        """Queens-style `34-12 Broadway` → prefix='34-', house=12."""
        conn, validated, _ = synth
        _insert_validated(conn, "v1", "34-12 BROADWAY")
        ref = matching.persons_decomposed(
            persons_validated=validated,
            organization_slug=ORG,
            conn=conn,
        )
        row = conn.execute(
            f"SELECT house_number, house_num_prefix, number_type FROM {ref.fqn} WHERE external_id = 'v1'"
        ).fetchone()
        assert row == (12, "34-", "even")

    def test_half_code_carries_through(self, synth):
        conn, validated, _ = synth
        _insert_validated(conn, "v1", "47 BROADWAY", half_code="1/2")
        ref = matching.persons_decomposed(
            persons_validated=validated,
            organization_slug=ORG,
            conn=conn,
        )
        half = conn.execute(f"SELECT half_code FROM {ref.fqn} WHERE external_id = 'v1'").fetchone()[0]
        assert half == "1/2"

    def test_unparseable_address_dropped(self, synth):
        """A row with no parseable house number should be dropped, not break
        the pipeline."""
        conn, validated, _ = synth
        _insert_validated(conn, "v1", "BROADWAY")  # no house number
        _insert_validated(conn, "v2", "123 BROADWAY")
        ref = matching.persons_decomposed(
            persons_validated=validated,
            organization_slug=ORG,
            conn=conn,
        )
        ids = {r[0] for r in conn.execute(f"SELECT external_id FROM {ref.fqn}").fetchall()}
        assert ids == {"v2"}

    def test_street_rewrite_applied_to_tokens(self, synth):
        """STREET_REWRITES collapse FDR variants before tokenization, so the
        voter and OSM/TIGER sides converge."""
        conn, validated, _ = synth
        _insert_validated(conn, "v1", "100 FDR DRIVE")
        _insert_validated(conn, "v2", "100 FRANKLIN D ROOSEVELT DRIVE")
        ref = matching.persons_decomposed(
            persons_validated=validated,
            organization_slug=ORG,
            conn=conn,
        )
        rows = {
            r[0]: set(r[1]) for r in conn.execute(f"SELECT external_id, street_name_tokens FROM {ref.fqn}").fetchall()
        }
        # Both should produce the same token set after rewrite.
        assert rows["v1"] == rows["v2"]
        for tok in ("f", "d", "r", "drive"):
            assert tok in rows["v1"], f"missing token {tok!r}: {rows['v1']}"


# ---------------------------------------------------------------------------
# persons_candidates — inverted-index join
# ---------------------------------------------------------------------------


class TestPersonsCandidates:
    def _run(self, conn, validated, bf):
        decomposed = matching.persons_decomposed(
            persons_validated=validated,
            organization_slug=ORG,
            conn=conn,
        )
        return matching.persons_candidates(
            persons_decomposed=decomposed,
            blockface_final=bf,
            organization_slug=ORG,
            conn=conn,
        )

    def test_basic_match(self, synth):
        """One voter, one blockface, same zip + ≥ 2 token overlap + parity
        match + in range → one candidate pair.

        Note: `persons_candidates` requires ≥ 2 overlapping tokens. Voters
        on single-word streets (`100 BROADWAY`) bypass this stage entirely
        and get rescued via `osm_only_matches` instead. This test uses a
        multi-token street to exercise the inverted-index matching path.
        """
        conn, validated, bf = synth
        _insert_validated(conn, "v1", "100 WEST 42 STREET", zip5="10001")
        _insert_blockface(conn, "T1:left", "West 42 Street", 1, 199, number_type="even")
        ref = self._run(conn, validated, bf)
        pairs = conn.execute(f"SELECT external_id, blockface_id FROM {ref.fqn}").fetchall()
        assert pairs == [("v1", "T1:left")]

    def test_zip_mismatch_rejected(self, synth):
        conn, validated, bf = synth
        _insert_validated(conn, "v1", "100 WEST 42 STREET", zip5="10001")
        _insert_blockface(conn, "T1:left", "West 42 Street", 1, 199, number_type="even", zip_code="20002")
        ref = self._run(conn, validated, bf)
        assert conn.execute(f"SELECT count(*) FROM {ref.fqn}").fetchone()[0] == 0

    def test_house_number_out_of_range_rejected(self, synth):
        conn, validated, bf = synth
        _insert_validated(conn, "v1", "999 WEST 42 STREET")
        _insert_blockface(conn, "T1:left", "West 42 Street", 1, 199, number_type="odd")
        ref = self._run(conn, validated, bf)
        assert conn.execute(f"SELECT count(*) FROM {ref.fqn}").fetchone()[0] == 0

    def test_parity_mismatch_rejected(self, synth):
        """Odd-numbered voter into an even-only blockface = no match."""
        conn, validated, bf = synth
        _insert_validated(conn, "v1", "101 WEST 42 STREET")  # odd
        _insert_blockface(conn, "T1:left", "West 42 Street", 2, 200, number_type="even")
        ref = self._run(conn, validated, bf)
        assert conn.execute(f"SELECT count(*) FROM {ref.fqn}").fetchone()[0] == 0

    def test_hyphen_prefix_mismatch_rejected(self, synth):
        """Voter on `34-12` shouldn't match a blockface with prefix `35-`,
        even if all the tokens line up — they're on different blocks."""
        conn, validated, bf = synth
        _insert_validated(conn, "v1", "34-12 WEST 42 STREET")  # prefix="34-", hn=12
        _insert_blockface(conn, "T1:left", "West 42 Street", 1, 99, prefix="35-", number_type="even")
        ref = self._run(conn, validated, bf)
        assert conn.execute(f"SELECT count(*) FROM {ref.fqn}").fetchone()[0] == 0

    def test_distinctive_token_required(self, synth):
        """Two streets sharing only generic tokens (`east`, `street`) should
        NOT match. Need at least one non-generic shared token."""
        conn, validated, bf = synth
        _insert_validated(conn, "v1", "100 EAST 1 STREET")
        # Blockface for "East 11 Street" — overlaps voter's tokens on
        # {east, street} only; "1" and "11" are different.
        _insert_blockface(conn, "T1:left", "East 11 Street", 1, 199, number_type="even")
        ref = self._run(conn, validated, bf)
        assert conn.execute(f"SELECT count(*) FROM {ref.fqn}").fetchone()[0] == 0

    def test_all_generic_voter_still_matches_via_sentinel(self, synth):
        """A voter on `100 WEST DRIVE` has no distinctive tokens (every
        token is generic). The sentinel-token sentinel keeps them matchable
        against blockfaces that share the same generic tokens — otherwise
        they'd be unmatchable everywhere."""
        conn, validated, bf = synth
        _insert_validated(conn, "v1", "100 WEST DRIVE")
        _insert_blockface(conn, "T1:left", "West Drive", 1, 199, number_type="even")
        ref = self._run(conn, validated, bf)
        pairs = conn.execute(f"SELECT external_id, blockface_id FROM {ref.fqn}").fetchall()
        assert pairs == [("v1", "T1:left")]

    def test_opposing_cardinals_rejected(self, synth):
        """A voter on `North Broadway` must not match a blockface for
        `South Broadway` even though the token overlap is high."""
        conn, validated, bf = synth
        _insert_validated(conn, "v1", "100 NORTH BROADWAY")
        _insert_blockface(conn, "T1:left", "South Broadway", 1, 199, number_type="even")
        ref = self._run(conn, validated, bf)
        assert conn.execute(f"SELECT count(*) FROM {ref.fqn}").fetchone()[0] == 0


# ---------------------------------------------------------------------------
# persons_best_match — deterministic tiebreak
# ---------------------------------------------------------------------------


class TestPersonsBestMatch:
    def test_higher_score_wins(self, synth):
        conn, validated, bf = synth
        _insert_validated(conn, "v1", "100 BROADWAY EAST")  # 'broadway' distinctive
        # T1 matches on { broadway } only (overlap = 2 with "east"+"broadway")
        _insert_blockface(conn, "T1:left", "Broadway", 1, 199, number_type="even")
        # T2 matches on { broadway, east } AND has the numeric-bonus from
        # voter's '100' against blockface name (no, the numeric bonus is
        # about tokens IN the address line — '100' is a digit. So both T1
        # and T2 get the numeric bonus.)
        _insert_blockface(conn, "T2:left", "Broadway East", 1, 199, number_type="even")
        decomposed = matching.persons_decomposed(
            persons_validated=validated,
            organization_slug=ORG,
            conn=conn,
        )
        candidates = matching.persons_candidates(
            persons_decomposed=decomposed,
            blockface_final=bf,
            organization_slug=ORG,
            conn=conn,
        )
        scored = matching.persons_scored(
            persons_candidates=candidates,
            persons_decomposed=decomposed,
            organization_slug=ORG,
            conn=conn,
        )
        best = matching.persons_best_match(
            persons_scored=scored,
            organization_slug=ORG,
            conn=conn,
        )
        row = conn.execute(f"SELECT blockface_id FROM {best.fqn} WHERE external_id = 'v1'").fetchone()
        assert row[0] == "T2:left", "higher token-overlap blockface should win"

    def test_tiebreak_is_deterministic(self, synth):
        """Same input twice → same chosen blockface. ROW_NUMBER ordered by
        (match_score DESC, blockface_id, full_name) makes this hold."""
        conn, validated, bf = synth
        _insert_validated(conn, "v1", "100 WEST 42 STREET")
        # Two equally-scoring blockfaces. ORDER BY blockface_id ASC picks T1.
        _insert_blockface(conn, "T1:left", "West 42 Street", 1, 199, number_type="even")
        _insert_blockface(conn, "T2:left", "West 42 Street", 1, 199, number_type="even")

        def _run():
            d = matching.persons_decomposed(
                persons_validated=validated,
                organization_slug=ORG,
                conn=conn,
            )
            c = matching.persons_candidates(
                persons_decomposed=d,
                blockface_final=bf,
                organization_slug=ORG,
                conn=conn,
            )
            s = matching.persons_scored(
                persons_candidates=c,
                persons_decomposed=d,
                organization_slug=ORG,
                conn=conn,
            )
            return matching.persons_best_match(
                persons_scored=s,
                organization_slug=ORG,
                conn=conn,
            )

        # Re-running on a fresh org schema is the only way to confirm
        # determinism — incremental nodes won't re-process existing ids.
        ref1 = _run()
        chosen1 = conn.execute(f"SELECT blockface_id FROM {ref1.fqn} WHERE external_id = 'v1'").fetchone()[0]
        # Drop and re-run.
        for t in ("persons_best_match", "persons_scored", "persons_candidates", "persons_decomposed"):
            conn.execute(f"DROP TABLE IF EXISTS {org_fqn(ORG, t)}")
        ref2 = _run()
        chosen2 = conn.execute(f"SELECT blockface_id FROM {ref2.fqn} WHERE external_id = 'v1'").fetchone()[0]
        assert chosen1 == chosen2 == "T1:left"
