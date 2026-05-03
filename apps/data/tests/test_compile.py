"""Tests for criteria → WHERE compilation."""

import pytest

from src.dsl.compile import (
    CriteriaError,
    boundary_key_expr_for,
    column_expr_for,
    to_where,
)
from src.dsl.criteria import (
    AgeRangeFilter,
    Criteria,
    EnumFilter,
    KeyFilter,
    TextFilter,
)

# ---------------------------------------------------------------------------
# Empty / passthrough cases
# ---------------------------------------------------------------------------


def test_empty_criteria_returns_empty_clause() -> None:
    where, params = to_where(Criteria(filters=[]))
    assert where == ""
    assert params == []


def test_filter_with_empty_value_drops_out() -> None:
    # Inactive filters (empty enum values, empty text, unbounded age)
    # produce no clause and don't count toward AND-joined output.
    criteria = Criteria(
        filters=[
            EnumFilter(kind="enum", key="party", values=[]),
            TextFilter(kind="text", key="zip5", value=""),
            AgeRangeFilter(kind="age-range", key="date_of_birth", min=None, max=None),
        ]
    )
    where, params = to_where(criteria)
    assert where == ""
    assert params == []


# ---------------------------------------------------------------------------
# Per-kind compilation
# ---------------------------------------------------------------------------


def test_enum_filter_on_other_properties() -> None:
    criteria = Criteria(filters=[EnumFilter(kind="enum", key="party", values=["DEM", "WOR"])])
    where, params = to_where(criteria)
    assert where == "WHERE (other_properties->>'party') IN (?, ?)"
    assert params == ["DEM", "WOR"]


def test_text_filter_equals_on_top_level_column() -> None:
    criteria = Criteria(filters=[TextFilter(kind="text", key="zip5", value="10001")])
    where, params = to_where(criteria)
    assert where == "WHERE zip5 = ?"
    assert params == ["10001"]


def test_text_filter_contains_on_top_level_column() -> None:
    criteria = Criteria(filters=[TextFilter(kind="text", key="last_name", value="smith")])
    where, params = to_where(criteria)
    assert where == "WHERE last_name ILIKE ?"
    assert params == ["%smith%"]


def test_age_range_with_both_bounds() -> None:
    criteria = Criteria(filters=[AgeRangeFilter(kind="age-range", key="date_of_birth", min=18, max=64)])
    where, params = to_where(criteria)
    # Compiled SQL is messy by necessity (try_strptime + age + extract);
    # what matters is the structure and the param order.
    assert "try_strptime((other_properties->>'date_of_birth')" in where
    assert ">= ?" in where
    assert "<= ?" in where
    assert params == [18, 64]


def test_age_range_min_only() -> None:
    criteria = Criteria(filters=[AgeRangeFilter(kind="age-range", key="date_of_birth", min=18, max=None)])
    where, params = to_where(criteria)
    assert ">= ?" in where
    assert "<= ?" not in where
    assert params == [18]


def test_age_range_max_only() -> None:
    criteria = Criteria(filters=[AgeRangeFilter(kind="age-range", key="date_of_birth", min=None, max=64)])
    where, params = to_where(criteria)
    assert ">= ?" not in where
    assert "<= ?" in where
    assert params == [64]


# ---------------------------------------------------------------------------
# AND combination across filters
# ---------------------------------------------------------------------------


def test_multiple_filters_join_with_and() -> None:
    criteria = Criteria(
        filters=[
            EnumFilter(kind="enum", key="party", values=["DEM"]),
            TextFilter(kind="text", key="zip5", value="10001"),
        ]
    )
    where, params = to_where(criteria)
    assert " AND " in where
    assert "(other_properties->>'party') IN (?)" in where
    assert "zip5 = ?" in where
    assert params == ["DEM", "10001"]


# ---------------------------------------------------------------------------
# Key filter (spatial scope)
# ---------------------------------------------------------------------------


def test_key_filter_alone() -> None:
    where, params = to_where(
        Criteria(filters=[]),
        key_filter=KeyFilter(keyGroup="nyc_zips", keys=["10001", "10002"]),
    )
    assert where == "WHERE zip5 IN (?, ?)"
    assert params == ["10001", "10002"]


def test_key_filter_combines_with_criteria() -> None:
    where, params = to_where(
        Criteria(filters=[EnumFilter(kind="enum", key="party", values=["DEM"])]),
        key_filter=KeyFilter(keyGroup="nyc_eds", keys=["75-001"]),
    )
    assert " AND " in where
    assert "(other_properties->>'party') IN (?)" in where
    assert "(other_properties->>'ad_ed') IN (?)" in where
    assert params == ["DEM", "75-001"]


def test_empty_key_set_short_circuits_to_match_nothing() -> None:
    # Empty `keys` is "no zones selected" — should match no rows rather
    # than emit a `IN ()` SQL syntax error.
    where, params = to_where(
        Criteria(filters=[]),
        key_filter=KeyFilter(keyGroup="nyc_zips", keys=[]),
    )
    assert where == "WHERE 1=0"
    assert params == []


# ---------------------------------------------------------------------------
# Validation / error cases
# ---------------------------------------------------------------------------


def test_unknown_field_raises() -> None:
    criteria = Criteria(filters=[EnumFilter(kind="enum", key="not_a_field", values=["x"])])
    with pytest.raises(CriteriaError):
        to_where(criteria)


def test_kind_field_def_mismatch_raises() -> None:
    # `zip5` is a text field; using it as an enum should error.
    criteria = Criteria(filters=[EnumFilter(kind="enum", key="zip5", values=["10001"])])
    with pytest.raises(CriteriaError):
        to_where(criteria)


def test_unknown_key_group_raises() -> None:
    with pytest.raises(CriteriaError):
        boundary_key_expr_for("not_a_group")


# ---------------------------------------------------------------------------
# Helper expressions
# ---------------------------------------------------------------------------


def test_column_expr_for_top_level() -> None:
    assert column_expr_for("zip5") == "zip5"


def test_column_expr_for_other_properties() -> None:
    assert column_expr_for("party") == "(other_properties->>'party')"


def test_boundary_key_expr_for_known_groups() -> None:
    assert boundary_key_expr_for("nyc_zips") == "zip5"
    assert boundary_key_expr_for("nyc_eds") == "(other_properties->>'ad_ed')"
