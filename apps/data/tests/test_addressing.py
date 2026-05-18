"""Unit tests for the address-handling SQL helpers in src/addressing.py.

Each helper returns a SQL fragment that callers embed in their own queries.
We exercise them against a plain in-memory DuckDB (no DuckLake / Hamilton)
by stuffing inputs into a literal `VALUES (...)` source.

These cover the three things that have to stay synchronized across the
voter / TIGER / OSM token pipelines:

  1. Same street → same tokens after rewrite + tokenize + expand.
  2. Same physical housenumber → same `housenumber_norm` regardless of
     hyphen/zero-padding surface form.
  3. `canonical_key` keeps parallel-named streets distinct (60 Place vs
     60 Lane) — no generic-token stripping.
"""

import pytest

import duckdb
from src.addressing import (
    canonical_key_sql,
    housenumber_display_sql,
    housenumber_norm_sql,
    street_rewrite_sql,
    tokenize_street_sql,
)


@pytest.fixture()
def conn():
    """Plain DuckDB connection — no DuckLake. Helpers are pure SQL."""
    c = duckdb.connect()
    yield c
    c.close()


def _eval(conn, expr_sql: str, value):
    """Evaluate a SQL fragment that references column `s` against a single
    literal row. Returns the scalar result."""
    return conn.execute(f"SELECT {expr_sql} FROM (VALUES (?)) AS t(s)", [value]).fetchone()[0]


# ---------------------------------------------------------------------------
# street_rewrite_sql
# ---------------------------------------------------------------------------


class TestStreetRewriteSql:
    def test_lowercases_and_trims(self, conn):
        assert _eval(conn, street_rewrite_sql("s"), "  BROADWAY  ") == "broadway"

    def test_collapses_fdr_to_f_d_r(self, conn):
        """FDR → f d r so OSM/voter/TIGER variants converge after tokenization."""
        assert _eval(conn, street_rewrite_sql("s"), "FDR Drive") == "f d r drive"

    def test_collapses_franklin_d_roosevelt(self, conn):
        """Full-form variant collapses to the same surface as 'FDR'."""
        assert _eval(conn, street_rewrite_sql("s"), "Franklin D Roosevelt Drive") == "f d r drive"

    def test_collapses_franklin_delano_roosevelt(self, conn):
        assert _eval(conn, street_rewrite_sql("s"), "Franklin Delano Roosevelt Drive") == "f d r drive"

    def test_passthrough_unrelated(self, conn):
        assert _eval(conn, street_rewrite_sql("s"), "West 42nd Street") == "west 42nd street"


# ---------------------------------------------------------------------------
# tokenize_street_sql
# ---------------------------------------------------------------------------


class TestTokenizeStreetSql:
    def test_simple_street_tokens(self, conn):
        toks = _eval(conn, tokenize_street_sql("s"), "Broadway")
        assert toks == ["broadway"]

    def test_lowercased_alphanumeric_split(self, conn):
        toks = _eval(conn, tokenize_street_sql("s"), "WEST 42ND STREET")
        # "42nd" splits into both "42" (digit-run) and "nd" (letter-run).
        assert "42" in toks
        assert "street" in toks
        assert "west" in toks
        # Deduped — no token appears twice.
        assert len(toks) == len(set(toks))

    def test_numeric_token_extracted_from_ordinal(self, conn):
        """'42nd' should contribute both '42' and 'nd' (or 'second' via expansion)
        — the numeric extraction is what the matching scorer keys on."""
        toks = _eval(conn, tokenize_street_sql("s"), "42nd Street")
        assert "42" in toks


# ---------------------------------------------------------------------------
# canonical_key_sql
# ---------------------------------------------------------------------------


class TestCanonicalKeySql:
    def test_sorts_and_joins_with_pipe(self, conn):
        result = conn.execute(
            f"SELECT {canonical_key_sql('toks')} FROM (VALUES (['b','a','c'])) AS t(toks)"
        ).fetchone()[0]
        assert result == "a|b|c"

    def test_preserves_generic_tokens(self, conn):
        """Generic tokens (place, lane, street, …) MUST stay in the key —
        that's what keeps parallel-named streets distinct."""
        place = conn.execute(
            f"SELECT {canonical_key_sql('toks')} FROM (VALUES (['60','place'])) AS t(toks)"
        ).fetchone()[0]
        lane = conn.execute(f"SELECT {canonical_key_sql('toks')} FROM (VALUES (['60','lane'])) AS t(toks)").fetchone()[
            0
        ]
        assert place != lane
        assert place == "60|place"
        assert lane == "60|lane"

    def test_same_tokens_different_order_same_key(self, conn):
        a = conn.execute(
            f"SELECT {canonical_key_sql('toks')} FROM (VALUES (['broadway','west'])) AS t(toks)"
        ).fetchone()[0]
        b = conn.execute(
            f"SELECT {canonical_key_sql('toks')} FROM (VALUES (['west','broadway'])) AS t(toks)"
        ).fetchone()[0]
        assert a == b


# ---------------------------------------------------------------------------
# housenumber_norm_sql
# ---------------------------------------------------------------------------


class TestHousenumberNormSql:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            # Plain integer passes through.
            ("123", "123"),
            # Leading zeros after `^` strip.
            ("0042", "42"),
            # Hyphenated Queens-style: zero strip after `-`, then hyphen strip.
            ("132-01", "1321"),
            ("9-02", "92"),
            # Already-normalized hyphenated forms collapse identically.
            ("132-1", "1321"),
            ("9-2", "92"),
            # `646` ↔ `6-46` — the canonical example for surface-form unification.
            ("6-46", "646"),
            ("646", "646"),
            # Multi-hyphen edge case (rare but possible in raw data).
            ("12-3-4", "1234"),
        ],
    )
    def test_normalizes_to_join_key(self, conn, raw, expected):
        assert _eval(conn, housenumber_norm_sql("s"), raw) == expected


# ---------------------------------------------------------------------------
# housenumber_display_sql
# ---------------------------------------------------------------------------


class TestHousenumberDisplaySql:
    def test_plain_number_no_prefix_no_half(self, conn):
        result = conn.execute(f"""
            SELECT {housenumber_display_sql("prefix", "num", "half")}
            FROM (VALUES ('', 42, '')) AS t(prefix, num, half)
        """).fetchone()[0]
        assert result == "42"

    def test_hyphen_prefix_preserved(self, conn):
        """Queens-style hyphen prefix is preserved in the display form."""
        result = conn.execute(f"""
            SELECT {housenumber_display_sql("prefix", "num", "half")}
            FROM (VALUES ('72-', 34, '')) AS t(prefix, num, half)
        """).fetchone()[0]
        assert result == "72-34"

    def test_half_code_appended_with_space(self, conn):
        result = conn.execute(f"""
            SELECT {housenumber_display_sql("prefix", "num", "half")}
            FROM (VALUES ('', 47, '1/2')) AS t(prefix, num, half)
        """).fetchone()[0]
        assert result == "47 1/2"

    def test_null_prefix_and_half_safe(self, conn):
        """COALESCE on prefix/half_code: NULLs don't poison the concat."""
        result = conn.execute(f"""
            SELECT {housenumber_display_sql("prefix", "num", "half")}
            FROM (VALUES (NULL, 100, NULL)) AS t(prefix, num, half)
        """).fetchone()[0]
        assert result == "100"


# ---------------------------------------------------------------------------
# Cross-helper invariant: same street → same canonical_key everywhere
# ---------------------------------------------------------------------------


class TestCanonicalKeyConvergence:
    """The token pipeline is street_rewrite → tokenize → equivalency-expand.
    Every source side (voter / TIGER / OSM) is expected to converge on the
    same canonical_key for the same physical street.

    Equivalency expansion is materialized in `address_tokens` and applied
    in SQL — we don't reproduce it here. Instead we verify the parts of
    the pipeline we own (rewrite + tokenize + canonical_key) put the
    same surface variants into the same sorted token bag, which is what
    expansion then operates on.
    """

    @pytest.mark.parametrize(
        ("a", "b"),
        [
            # FDR variants converge after rewrite.
            ("FDR Drive", "Franklin D Roosevelt Drive"),
            ("FDR Drive", "Franklin Delano Roosevelt Drive"),
            # Case and whitespace differences.
            ("  Broadway  ", "BROADWAY"),
        ],
    )
    def test_variants_produce_same_token_set(self, conn, a, b):
        expr = tokenize_street_sql(street_rewrite_sql("s"))
        toks_a = _eval(conn, expr, a)
        toks_b = _eval(conn, expr, b)
        assert toks_a == toks_b, f"{a!r} and {b!r} should produce the same tokens"

    def test_parallel_named_streets_diverge(self, conn):
        """60 Place and 60 Lane should NOT converge: they're different streets."""
        expr = tokenize_street_sql(street_rewrite_sql("s"))
        place_tokens = _eval(conn, expr, "60 Place")
        lane_tokens = _eval(conn, expr, "60 Lane")
        assert place_tokens != lane_tokens
        # And their canonical_keys differ too.
        place_key = conn.execute(
            f"SELECT {canonical_key_sql('toks')} FROM (VALUES (?::VARCHAR[])) AS t(toks)",
            [place_tokens],
        ).fetchone()[0]
        lane_key = conn.execute(
            f"SELECT {canonical_key_sql('toks')} FROM (VALUES (?::VARCHAR[])) AS t(toks)",
            [lane_tokens],
        ).fetchone()[0]
        assert place_key != lane_key
