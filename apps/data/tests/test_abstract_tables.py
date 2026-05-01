"""Tests for placeholder substitution in `src.abstract_tables`."""

import pytest

from src.abstract_tables import UnknownAbstractTableError, resolve


def test_resolves_a_known_placeholder() -> None:
    sql = "SELECT count(*) FROM {persons_geocoded}"
    assert resolve(sql, slug="default") == "SELECT count(*) FROM ducklake.main.default_persons_geocoded"


def test_resolves_multiple_placeholders_in_one_query() -> None:
    sql = "SELECT * FROM {persons_geocoded} p JOIN {buildings_geocoded} b ON b.building_id = p.building_id"
    out = resolve(sql, slug="acme")
    assert "ducklake.main.acme_persons_geocoded" in out
    assert "ducklake.main.acme_buildings_geocoded" in out
    assert "{" not in out


def test_resolves_repeated_placeholder() -> None:
    sql = "SELECT * FROM {persons_geocoded} UNION SELECT * FROM {persons_geocoded}"
    out = resolve(sql, slug="default")
    assert out.count("ducklake.main.default_persons_geocoded") == 2


def test_passes_through_sql_with_no_placeholders() -> None:
    sql = "SELECT 1"
    assert resolve(sql, slug="default") == "SELECT 1"


def test_raises_on_unknown_placeholder() -> None:
    sql = "SELECT * FROM {persons_typoed}"
    with pytest.raises(UnknownAbstractTableError):
        resolve(sql, slug="default")


def test_does_not_match_unrelated_braces() -> None:
    # `{}` patterns that aren't valid placeholder names (e.g. JSON
    # literals embedded in SQL strings) should pass through. Our regex
    # anchors on `[a-z_]+`, so digits, uppercase, mixed punctuation
    # don't match.
    sql = "SELECT '{nope: 1}', '{ABC}', '{123}', count(*) FROM {persons_geocoded}"
    out = resolve(sql, slug="x")
    assert "ducklake.main.x_persons_geocoded" in out
    assert "{nope: 1}" in out
    assert "{ABC}" in out
    assert "{123}" in out
