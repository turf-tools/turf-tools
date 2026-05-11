"""Tests for criteria → WHERE compilation and the cascade aggregate query."""

import pytest

from src.dsl.compile import (
    CriteriaError,
    boundary_key_expr_for,
    cascade_sql,
    column_expr_for,
    criteria_to_where,
)
from src.dsl.criteria import (
    AgeRangeFilter,
    AllFilter,
    Criteria,
    EnumFilter,
    KeyFilter,
    Step,
    TextFilter,
)


def _narrow(*filters) -> Criteria:
    return Criteria(steps=[Step(verb="narrow", filter=f) for f in filters])


# ---------------------------------------------------------------------------
# Empty / passthrough cases
# ---------------------------------------------------------------------------


def test_empty_criteria_returns_empty_clause() -> None:
    params: list = []
    where = criteria_to_where(Criteria(), None, params)
    assert where == ""
    assert params == []


def test_step_with_inactive_filter_drops_out() -> None:
    # Inactive filters (empty enum values, empty text, unbounded age)
    # produce no clause, regardless of verb.
    params: list = []
    where = criteria_to_where(
        _narrow(
            EnumFilter(kind="enum", key="party", values=[]),
            TextFilter(kind="text", key="zip5", value=""),
            AgeRangeFilter(kind="age-range", key="date_of_birth", min=None, max=None),
        ),
        None,
        params,
    )
    assert where == ""
    assert params == []


# ---------------------------------------------------------------------------
# Per-kind compilation (single narrow step)
# ---------------------------------------------------------------------------


def test_enum_filter_on_other_properties() -> None:
    params: list = []
    where = criteria_to_where(
        _narrow(EnumFilter(kind="enum", key="party", values=["DEM", "WOR"])),
        None,
        params,
    )
    assert where == "WHERE (other_properties->>'party') IN (?, ?)"
    assert params == ["DEM", "WOR"]


def test_text_filter_equals_on_top_level_column() -> None:
    params: list = []
    where = criteria_to_where(
        _narrow(TextFilter(kind="text", key="zip5", value="10001")),
        None,
        params,
    )
    assert where == "WHERE zip5 = ?"
    assert params == ["10001"]


def test_text_filter_contains_on_top_level_column() -> None:
    params: list = []
    where = criteria_to_where(
        _narrow(TextFilter(kind="text", key="last_name", value="smith")),
        None,
        params,
    )
    assert where == "WHERE last_name ILIKE ?"
    assert params == ["%smith%"]


def test_age_range_with_both_bounds() -> None:
    params: list = []
    where = criteria_to_where(
        _narrow(AgeRangeFilter(kind="age-range", key="date_of_birth", min=18, max=64)),
        None,
        params,
    )
    # Compiled SQL is messy by necessity (try_strptime + age + extract);
    # what matters is the structure and the param order.
    assert "try_strptime((other_properties->>'date_of_birth')" in where
    assert ">= ?" in where
    assert "<= ?" in where
    assert params == [18, 64]


def test_age_range_min_only() -> None:
    params: list = []
    where = criteria_to_where(
        _narrow(AgeRangeFilter(kind="age-range", key="date_of_birth", min=18, max=None)),
        None,
        params,
    )
    assert ">= ?" in where
    assert "<= ?" not in where
    assert params == [18]


def test_age_range_max_only() -> None:
    params: list = []
    where = criteria_to_where(
        _narrow(AgeRangeFilter(kind="age-range", key="date_of_birth", min=None, max=64)),
        None,
        params,
    )
    assert ">= ?" not in where
    assert "<= ?" in where
    assert params == [64]


def test_all_filter_compiles_to_match_all() -> None:
    params: list = []
    where = criteria_to_where(
        _narrow(AllFilter(kind="all")),
        None,
        params,
    )
    assert where == "WHERE 1=1"
    assert params == []


# ---------------------------------------------------------------------------
# Verb combinations — Boolean algebra
# ---------------------------------------------------------------------------


def test_narrow_chain_ands_filters() -> None:
    params: list = []
    where = criteria_to_where(
        _narrow(
            EnumFilter(kind="enum", key="party", values=["DEM"]),
            TextFilter(kind="text", key="zip5", value="10001"),
        ),
        None,
        params,
    )
    assert " AND " in where
    assert "(other_properties->>'party') IN (?)" in where
    assert "zip5 = ?" in where
    assert params == ["DEM", "10001"]


def test_add_step_compiles_as_or() -> None:
    params: list = []
    where = criteria_to_where(
        Criteria(steps=[
            Step(verb="narrow", filter=EnumFilter(kind="enum", key="party", values=["DEM"])),
            Step(verb="add", filter=EnumFilter(kind="enum", key="party", values=["REP"])),
        ]),
        None,
        params,
    )
    assert " OR " in where
    assert params == ["DEM", "REP"]


def test_remove_step_compiles_as_and_not() -> None:
    params: list = []
    where = criteria_to_where(
        Criteria(steps=[
            Step(verb="narrow", filter=EnumFilter(kind="enum", key="party", values=["DEM"])),
            Step(verb="remove", filter=TextFilter(kind="text", key="zip5", value="10001")),
        ]),
        None,
        params,
    )
    assert " AND NOT " in where
    assert params == ["DEM", "10001"]


def test_remove_as_first_step_negates() -> None:
    params: list = []
    where = criteria_to_where(
        Criteria(steps=[
            Step(verb="remove", filter=TextFilter(kind="text", key="zip5", value="10001")),
        ]),
        None,
        params,
    )
    assert where == "WHERE NOT (zip5 = ?)"
    assert params == ["10001"]


def test_remove_all_resets_to_empty_set() -> None:
    # `remove: all` is the "build mode" escape hatch — should match nothing.
    params: list = []
    where = criteria_to_where(
        Criteria(steps=[Step(verb="remove", filter=AllFilter(kind="all"))]),
        None,
        params,
    )
    assert where == "WHERE NOT (1=1)"


def test_mixed_verb_sequence_preserves_order() -> None:
    # narrow D, add R, remove ZIP — final: (D OR R) AND NOT zip
    params: list = []
    where = criteria_to_where(
        Criteria(steps=[
            Step(verb="narrow", filter=EnumFilter(kind="enum", key="party", values=["DEM"])),
            Step(verb="add", filter=EnumFilter(kind="enum", key="party", values=["REP"])),
            Step(verb="remove", filter=TextFilter(kind="text", key="zip5", value="10001")),
        ]),
        None,
        params,
    )
    # Verify structure: outermost AND NOT, inside the OR.
    assert " OR " in where
    assert " AND NOT " in where
    assert params == ["DEM", "REP", "10001"]


# ---------------------------------------------------------------------------
# Key filter (spatial scope)
# ---------------------------------------------------------------------------


def test_key_filter_alone() -> None:
    params: list = []
    where = criteria_to_where(
        Criteria(),
        KeyFilter(keyGroup="nyc_zips", keys=["10001", "10002"]),
        params,
    )
    assert where == "WHERE zip5 IN (?, ?)"
    assert params == ["10001", "10002"]


def test_key_filter_combines_with_criteria() -> None:
    params: list = []
    where = criteria_to_where(
        _narrow(EnumFilter(kind="enum", key="party", values=["DEM"])),
        KeyFilter(keyGroup="nyc_eds", keys=["75-001"]),
        params,
    )
    assert " AND " in where
    assert "(other_properties->>'party') IN (?)" in where
    assert "(other_properties->>'ad_ed') IN (?)" in where
    assert params == ["DEM", "75-001"]


def test_empty_key_set_short_circuits_to_match_nothing() -> None:
    # Empty `keys` is "no zones selected" — should match no rows rather
    # than emit a `IN ()` SQL syntax error.
    params: list = []
    where = criteria_to_where(
        Criteria(),
        KeyFilter(keyGroup="nyc_zips", keys=[]),
        params,
    )
    assert where == "WHERE 1=0"
    assert params == []


# ---------------------------------------------------------------------------
# Cascade — one query, N+1 filtered counts
# ---------------------------------------------------------------------------


def test_cascade_empty_criteria_emits_baseline_only() -> None:
    params: list = []
    sql = cascade_sql(Criteria(), "persons", params)
    assert sql == "SELECT count(*) AS step_0 FROM persons"
    assert params == []


def test_cascade_emits_one_filter_per_step() -> None:
    params: list = []
    sql = cascade_sql(
        Criteria(steps=[
            Step(verb="narrow", filter=EnumFilter(kind="enum", key="party", values=["DEM"])),
            Step(verb="add", filter=EnumFilter(kind="enum", key="party", values=["REP"])),
        ]),
        "persons",
        params,
    )
    assert "step_0" in sql
    assert "step_1" in sql
    assert "step_2" in sql
    assert sql.count("FILTER (WHERE") == 2
    # Each step compiles independently; params repeat for prefix-1 then prefix-2.
    assert params == ["DEM", "DEM", "REP"]


# ---------------------------------------------------------------------------
# Validation / error cases
# ---------------------------------------------------------------------------


def test_unknown_field_raises() -> None:
    with pytest.raises(CriteriaError):
        criteria_to_where(
            _narrow(EnumFilter(kind="enum", key="not_a_field", values=["x"])),
            None,
            [],
        )


def test_kind_field_def_mismatch_raises() -> None:
    # `zip5` is a text field; using it as an enum should error.
    with pytest.raises(CriteriaError):
        criteria_to_where(
            _narrow(EnumFilter(kind="enum", key="zip5", values=["10001"])),
            None,
            [],
        )


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
