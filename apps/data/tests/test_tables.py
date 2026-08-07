"""Tests for placeholder substitution in `src.tables`."""

import pytest

from src.tables import UnknownAbstractTableError, resolve, table_fqn


def test_resolves_a_known_placeholder() -> None:
    sql = "SELECT count(*) FROM {persons_geocoded}"
    assert resolve(sql, schema="default") == "SELECT count(*) FROM ducklake.default.persons_geocoded"


def test_resolves_multiple_placeholders_in_one_query() -> None:
    sql = "SELECT * FROM {persons_geocoded} p JOIN {buildings_geocoded} b ON b.building_id = p.building_id"
    out = resolve(sql, schema="acme")
    assert "ducklake.acme.persons_geocoded" in out
    assert "ducklake.acme.buildings_geocoded" in out
    assert "{" not in out


def test_resolves_repeated_placeholder() -> None:
    sql = "SELECT * FROM {persons_geocoded} UNION SELECT * FROM {persons_geocoded}"
    out = resolve(sql, schema="default")
    assert out.count("ducklake.default.persons_geocoded") == 2


def test_passes_through_sql_with_no_placeholders() -> None:
    sql = "SELECT 1"
    assert resolve(sql, schema="default") == "SELECT 1"


def test_raises_on_unknown_placeholder() -> None:
    sql = "SELECT * FROM {persons_typoed}"
    with pytest.raises(UnknownAbstractTableError):
        resolve(sql, schema="default")


def test_does_not_match_unrelated_braces() -> None:
    # `{}` patterns that aren't valid placeholder names (e.g. JSON
    # literals embedded in SQL strings) should pass through. Our regex
    # anchors on `[a-z_]+`, so digits, uppercase, mixed punctuation
    # don't match.
    sql = "SELECT '{nope: 1}', '{ABC}', '{123}', count(*) FROM {persons_geocoded}"
    out = resolve(sql, schema="x")
    assert "ducklake.x.persons_geocoded" in out
    assert "{nope: 1}" in out
    assert "{ABC}" in out
    assert "{123}" in out


def test_table_fqn_leaves_plain_slugs_unquoted() -> None:
    # Plain identifier slugs read more naturally without quotes.
    assert table_fqn("default", "persons_geocoded") == "ducklake.default.persons_geocoded"
    assert table_fqn("nyc_dsa", "persons_geocoded") == "ducklake.nyc_dsa.persons_geocoded"


def test_table_fqn_quotes_hyphenated_slugs() -> None:
    # Slugs with hyphens (`test-org`) must round-trip through SQL
    # without being interpreted as an operator.
    assert table_fqn("test-org", "persons_geocoded") == 'ducklake."test-org".persons_geocoded'


def test_table_fqn_escapes_embedded_quotes() -> None:
    # Defense in depth: a slug containing a double-quote shouldn't
    # break out of the identifier. Slugs shouldn't have this in
    # practice (org-creation should validate) but the helper handles
    # it correctly if one slips through.
    assert table_fqn('weird"slug', "persons_geocoded") == 'ducklake."weird""slug".persons_geocoded'
