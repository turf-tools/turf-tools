"""Tests for criteria → WHERE compilation and the cascade aggregate query."""

from datetime import date

import pytest

from src.dsl.compile import (
    CriteriaError,
    boundary_key_expr_for,
    cascade_sql,
    column_expr_for,
    criteria_to_where,
)
from src.dsl.criteria import (
    AddressFilter,
    AgeRangeFilter,
    AllFilter,
    CanvassOutcomeFilter,
    CanvassResponseFilter,
    Criteria,
    DateRangeFilter,
    EnumFilter,
    KeyFilter,
    NestedFilter,
    NumberRangeFilter,
    PersonIdSetFilter,
    Step,
    TextFilter,
    TextMultiFilter,
    VotingHistoryCountFilter,
    VotingHistoryDetailFilter,
    build_field_catalog,
)
from src.importers.nys_voter_file.manifest import NYS_MANIFEST

# The compiler is manifest-driven; exercise it against the real NYS field set.
# The election registry is per-version data (bits assigned newest-first at
# import); count-filter windows are relative to today, so key years are too.
# `2005-general` at bit 64 exercises the second mask word.
_Y = date.today().year
ELECTION_BITS = {
    f"{_Y}-general": 0,
    f"{_Y}-primary": 1,
    f"{_Y - 1}-general": 2,
    f"{_Y - 1}-presidential_primary": 3,
    f"{_Y - 2}-general": 4,
    "2005-general": 64,
}
CATALOG = build_field_catalog(NYS_MANIFEST, election_bits=ELECTION_BITS)


def _narrow(*filters) -> Criteria:
    return Criteria(steps=[Step(verb="narrow", filter=f) for f in filters])


# ---------------------------------------------------------------------------
# Empty / passthrough cases
# ---------------------------------------------------------------------------


def test_empty_criteria_returns_empty_clause() -> None:
    params: list = []
    where = criteria_to_where(CATALOG, Criteria(), None, params)
    assert where == ""
    assert params == []


def test_step_with_inactive_filter_drops_out() -> None:
    # Inactive filters (empty enum values, empty text, unbounded age)
    # produce no clause, regardless of verb.
    params: list = []
    where = criteria_to_where(
        CATALOG,
        _narrow(
            EnumFilter(kind="enum", key="enrollment", values=[]),
            TextFilter(kind="text", key="last_name", value=""),
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


def test_enum_filter_on_top_level_column() -> None:
    params: list = []
    where = criteria_to_where(
        CATALOG,
        _narrow(EnumFilter(kind="enum", key="enrollment", values=["democratic", "working_families"])),
        None,
        params,
    )
    assert where == "WHERE enrollment IN (?, ?)"
    assert params == ["democratic", "working_families"]


def test_text_multi_filter_on_top_level_column() -> None:
    params: list = []
    where = criteria_to_where(
        CATALOG,
        _narrow(TextMultiFilter(kind="text-multi", key="zip5", values=["10001", "10002"])),
        None,
        params,
    )
    assert where == "WHERE zip5 IN (?, ?)"
    assert params == ["10001", "10002"]


def test_text_filter_contains_on_top_level_column() -> None:
    params: list = []
    where = criteria_to_where(
        CATALOG,
        _narrow(TextFilter(kind="text", key="last_name", value="smith")),
        None,
        params,
    )
    assert where == "WHERE last_name ILIKE ?"
    assert params == ["%smith%"]


def test_age_range_with_both_bounds() -> None:
    params: list = []
    where = criteria_to_where(
        CATALOG,
        _narrow(AgeRangeFilter(kind="age-range", key="date_of_birth", min=18, max=64)),
        None,
        params,
    )
    # Compiled SQL is messy by necessity (try_strptime + age + extract);
    # what matters is the structure and the param order.
    assert "try_strptime(date_of_birth" in where
    assert ">= ?" in where
    assert "<= ?" in where
    assert params == [18, 64]


def test_age_range_min_only() -> None:
    params: list = []
    where = criteria_to_where(
        CATALOG,
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
        CATALOG,
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
        CATALOG,
        _narrow(AllFilter(kind="all")),
        None,
        params,
    )
    assert where == "WHERE 1=1"
    assert params == []


def test_date_range_both_bounds() -> None:
    params: list = []
    where = criteria_to_where(
        CATALOG,
        _narrow(
            DateRangeFilter(
                kind="date-range",
                key="registration_date",
                min="2020-01-01",
                max="2024-12-31",
            )
        ),
        None,
        params,
    )
    assert "registration_date >= ?" in where
    assert "registration_date <= ?" in where
    assert params == ["2020-01-01", "2024-12-31"]


def test_date_range_min_only() -> None:
    params: list = []
    where = criteria_to_where(
        CATALOG,
        _narrow(DateRangeFilter(kind="date-range", key="registration_date", min="2020-01-01", max=None)),
        None,
        params,
    )
    assert "registration_date >= ?" in where
    assert "<= ?" not in where
    assert params == ["2020-01-01"]


def test_date_range_both_null_is_inactive() -> None:
    params: list = []
    where = criteria_to_where(
        CATALOG,
        _narrow(DateRangeFilter(kind="date-range", key="registration_date", min=None, max=None)),
        None,
        params,
    )
    assert where == ""
    assert params == []


def test_voting_history_at_least_primary() -> None:
    """Triple-prime targeting: voted in 3+ primaries (incl. presidential) in last 4y."""
    params: list = []
    where = criteria_to_where(
        CATALOG,
        _narrow(
            VotingHistoryCountFilter(
                kind="voting-history-count",
                key="voting_history_count",
                type="primary",
                window_years=4,
                comparator="at_least",
                count=3,
            )
        ),
        None,
        params,
    )
    # In-window primaries: bits 1 (this year's primary) + 3 (last year's
    # presidential primary) → mask 0b1010; popcount against the mask column.
    assert where == "WHERE (bit_count(voting_history_mask_0 & 10::UBIGINT)) >= ?"
    assert params == [3]


def test_address_all_four_fields() -> None:
    """Address filter AND-joins clauses for every non-empty sub-field."""
    params: list = []
    where = criteria_to_where(
        CATALOG,
        _narrow(
            AddressFilter(
                kind="address",
                key="address",
                line1="Broadway",
                city="New York",
                state="ny",
                zip="10024",
            )
        ),
        None,
        params,
    )
    assert "address_line_1 ILIKE ?" in where
    assert "city ILIKE ?" in where
    assert "state = ?" in where
    assert "zip5 = ?" in where
    # state is uppercased; line1/city wrapped in %%.
    assert params == ["%Broadway%", "%New York%", "NY", "10024"]


def test_address_partial_fields() -> None:
    """Only non-empty sub-fields contribute clauses."""
    params: list = []
    where = criteria_to_where(
        CATALOG,
        _narrow(AddressFilter(kind="address", key="address", line1="", city="brooklyn", state="", zip="")),
        None,
        params,
    )
    assert "city ILIKE ?" in where
    assert "address_line_1" not in where
    assert "state =" not in where
    assert "zip5 =" not in where
    assert params == ["%brooklyn%"]


def test_address_all_empty_is_inactive() -> None:
    params: list = []
    where = criteria_to_where(
        CATALOG,
        _narrow(AddressFilter(kind="address", key="address", line1="", city="", state="", zip="")),
        None,
        params,
    )
    assert where == ""
    assert params == []


def test_voting_history_exactly_general() -> None:
    params: list = []
    where = criteria_to_where(
        CATALOG,
        _narrow(
            VotingHistoryCountFilter(
                kind="voting-history-count",
                key="voting_history_count",
                type="general",
                window_years=4,
                comparator="exactly",
                count=1,
            )
        ),
        None,
        params,
    )
    # In-window generals: bits 0, 2, 4 → mask 0b10101.
    assert where == "WHERE (bit_count(voting_history_mask_0 & 21::UBIGINT)) = ?"
    assert params == [1]


def test_voting_history_detail_any_membership() -> None:
    """`any` mode matches persons who voted in at least one selected election."""
    params: list = []
    where = criteria_to_where(
        CATALOG,
        _narrow(
            VotingHistoryDetailFilter(
                kind="voting-history-detail",
                key="voting_history_detail",
                mode="any",
                elections=[f"{_Y}-primary", f"{_Y - 1}-general"],
            )
        ),
        None,
        params,
    )
    # Bits 1 + 2 → mask 0b110; selected keys map to a mask literal, not params.
    assert where == "WHERE (voting_history_mask_0 & 6::UBIGINT) != 0"
    assert params == []


def test_voting_history_detail_all_membership() -> None:
    """`all` mode requires every selected election."""
    params: list = []
    where = criteria_to_where(
        CATALOG,
        _narrow(
            VotingHistoryDetailFilter(
                kind="voting-history-detail",
                key="voting_history_detail",
                mode="all",
                elections=[f"{_Y}-primary", f"{_Y - 1}-general"],
            )
        ),
        None,
        params,
    )
    assert where == "WHERE (voting_history_mask_0 & 6::UBIGINT) = 6::UBIGINT"
    assert params == []


def test_voting_history_detail_spans_mask_words() -> None:
    """A selection reaching past bit 63 adds a second-word term; words the
    selection doesn't touch contribute none."""
    params: list = []
    where = criteria_to_where(
        CATALOG,
        _narrow(
            VotingHistoryDetailFilter(
                kind="voting-history-detail",
                key="voting_history_detail",
                mode="any",
                elections=[f"{_Y}-general", "2005-general"],
            )
        ),
        None,
        params,
    )
    assert where == ("WHERE ((voting_history_mask_0 & 1::UBIGINT) != 0 OR (voting_history_mask_1 & 1::UBIGINT) != 0)")
    assert params == []


def test_voting_history_detail_unknown_key_matches_nothing() -> None:
    """Keys absent from the version's registry: `any` over only-unknown keys is
    unsatisfiable, and one unknown key poisons `all`."""
    for mode, elections in (("any", ["1900-general"]), ("all", [f"{_Y}-general", "1900-general"])):
        params: list = []
        where = criteria_to_where(
            CATALOG,
            _narrow(
                VotingHistoryDetailFilter(
                    kind="voting-history-detail",
                    key="voting_history_detail",
                    mode=mode,
                    elections=elections,
                )
            ),
            None,
            params,
        )
        assert where == "WHERE 1=0"
        assert params == []


def test_voting_history_without_registry_raises() -> None:
    """A version resolved without an election registry can't compile
    voting-history filters — backfill/reimport, never silently mis-filter."""
    catalog = build_field_catalog(NYS_MANIFEST)
    with pytest.raises(CriteriaError, match="registry"):
        criteria_to_where(
            catalog,
            _narrow(
                VotingHistoryDetailFilter(
                    kind="voting-history-detail",
                    key="voting_history_detail",
                    mode="any",
                    elections=[f"{_Y}-general"],
                )
            ),
            None,
            [],
        )


def test_voting_history_detail_empty_is_inactive() -> None:
    params: list = []
    where = criteria_to_where(
        CATALOG,
        _narrow(
            VotingHistoryDetailFilter(
                kind="voting-history-detail",
                key="voting_history_detail",
                mode="any",
                elections=[],
            )
        ),
        None,
        params,
    )
    assert where == ""
    assert params == []


# ---------------------------------------------------------------------------
# Verb combinations — Boolean algebra
# ---------------------------------------------------------------------------


def test_narrow_chain_ands_filters() -> None:
    params: list = []
    where = criteria_to_where(
        CATALOG,
        _narrow(
            EnumFilter(kind="enum", key="enrollment", values=["democratic"]),
            TextFilter(kind="text", key="last_name", value="smith"),
        ),
        None,
        params,
    )
    assert " AND " in where
    assert "enrollment IN (?)" in where
    assert "last_name ILIKE ?" in where
    assert params == ["democratic", "%smith%"]


def test_add_step_compiles_as_or() -> None:
    params: list = []
    where = criteria_to_where(
        CATALOG,
        Criteria(
            steps=[
                Step(verb="narrow", filter=EnumFilter(kind="enum", key="enrollment", values=["democratic"])),
                Step(verb="add", filter=EnumFilter(kind="enum", key="enrollment", values=["republican"])),
            ]
        ),
        None,
        params,
    )
    assert " OR " in where
    assert params == ["democratic", "republican"]


def test_remove_step_compiles_as_and_not() -> None:
    params: list = []
    where = criteria_to_where(
        CATALOG,
        Criteria(
            steps=[
                Step(verb="narrow", filter=EnumFilter(kind="enum", key="enrollment", values=["democratic"])),
                Step(verb="remove", filter=TextFilter(kind="text", key="last_name", value="smith")),
            ]
        ),
        None,
        params,
    )
    assert " AND NOT " in where
    assert params == ["democratic", "%smith%"]


def test_remove_as_first_step_negates() -> None:
    params: list = []
    where = criteria_to_where(
        CATALOG,
        Criteria(
            steps=[
                Step(verb="remove", filter=TextFilter(kind="text", key="last_name", value="smith")),
            ]
        ),
        None,
        params,
    )
    assert where == "WHERE NOT (last_name ILIKE ?)"
    assert params == ["%smith%"]


def test_remove_all_resets_to_empty_set() -> None:
    # `remove: all` is the "build mode" escape hatch — should match nothing.
    params: list = []
    where = criteria_to_where(
        CATALOG,
        Criteria(steps=[Step(verb="remove", filter=AllFilter(kind="all"))]),
        None,
        params,
    )
    assert where == "WHERE NOT (1=1)"


def test_mixed_verb_sequence_preserves_order() -> None:
    # narrow D, add R, remove last_name — final: (D OR R) AND NOT name
    params: list = []
    where = criteria_to_where(
        CATALOG,
        Criteria(
            steps=[
                Step(verb="narrow", filter=EnumFilter(kind="enum", key="enrollment", values=["democratic"])),
                Step(verb="add", filter=EnumFilter(kind="enum", key="enrollment", values=["republican"])),
                Step(verb="remove", filter=TextFilter(kind="text", key="last_name", value="smith")),
            ]
        ),
        None,
        params,
    )
    # Verify structure: outermost AND NOT, inside the OR.
    assert " OR " in where
    assert " AND NOT " in where
    assert params == ["democratic", "republican", "%smith%"]


# ---------------------------------------------------------------------------
# Custom-field filters (values-table semi-join — see docs/plans/custom-fields.md)
# ---------------------------------------------------------------------------


CUSTOM_CATALOG = build_field_catalog(
    NYS_MANIFEST,
    custom_table="ducklake.main.nys_custom_fields",
    custom_fields={
        "f-num": "number",
        "f-date": "date",
        "f-text": "text",
        "f-code": "text_multi",
        "f-enum": "enum",
    },
)


def test_custom_number_range_semi_join() -> None:
    params: list = []
    where = criteria_to_where(
        CUSTOM_CATALOG,
        _narrow(NumberRangeFilter(kind="number-range", key="f-num", min=0.5, max=0.9)),
        None,
        params,
    )
    assert where == (
        "WHERE external_id IN (SELECT external_id FROM ducklake.main.nys_custom_fields "
        "WHERE field_id = ? AND try_cast(value AS DOUBLE) >= ? AND try_cast(value AS DOUBLE) <= ?)"
    )
    assert params == ["f-num", 0.5, 0.9]


def test_custom_date_range_casts_value() -> None:
    params: list = []
    where = criteria_to_where(
        CUSTOM_CATALOG,
        _narrow(DateRangeFilter(kind="date-range", key="f-date", min="2026-01-01", max=None)),
        None,
        params,
    )
    assert "try_cast(value AS DATE) >= ?" in where
    assert params == ["f-date", "2026-01-01"]


def test_custom_enum_and_text_clauses() -> None:
    params: list = []
    where = criteria_to_where(
        CUSTOM_CATALOG,
        _narrow(
            EnumFilter(kind="enum", key="f-enum", values=["a", "b"]),
            TextFilter(kind="text", key="f-text", value="smith"),
        ),
        None,
        params,
    )
    assert "WHERE field_id = ? AND value IN (?, ?)" in where
    assert "WHERE field_id = ? AND value ILIKE ?" in where
    assert params == ["f-enum", "a", "b", "f-text", "%smith%"]


def test_custom_code_matches_whole_values_not_substrings() -> None:
    # The reason Code exists: a Text filter for "3" would compile to
    # `value ILIKE '%3%'` and sweep up 13, 23, 30-39. Code binds each value
    # whole, so district 3 stays district 3.
    params: list = []
    where = criteria_to_where(
        CUSTOM_CATALOG,
        _narrow(TextMultiFilter(kind="text-multi", key="f-code", values=["3", "40"])),
        None,
        params,
    )
    assert where == (
        "WHERE external_id IN (SELECT external_id FROM ducklake.main.nys_custom_fields "
        "WHERE field_id = ? AND value IN (?, ?))"
    )
    assert params == ["f-code", "3", "40"]


def test_custom_code_blank_values_are_inactive() -> None:
    # Whitespace-only tokens are dropped; an all-blank list is an inactive
    # filter (matches everyone), not an `IN ()` syntax error.
    params: list = []
    assert (
        criteria_to_where(
            CUSTOM_CATALOG,
            _narrow(TextMultiFilter(kind="text-multi", key="f-code", values=["  ", ""])),
            None,
            params,
        )
        == ""
    )
    assert params == []


def test_custom_field_kind_mismatch_raises() -> None:
    with pytest.raises(CriteriaError):
        criteria_to_where(
            CUSTOM_CATALOG,
            _narrow(NumberRangeFilter(kind="number-range", key="f-date", min=1.0, max=None)),
            None,
            [],
        )


# ---------------------------------------------------------------------------
# Key filter (spatial scope)
# ---------------------------------------------------------------------------


def test_key_filter_alone() -> None:
    params: list = []
    where = criteria_to_where(
        CATALOG,
        Criteria(),
        KeyFilter(key_group="nyc_zips", keys=["10001", "10002"]),
        params,
    )
    assert where == "WHERE zip5 IN (SELECT unnest(?))"
    assert params == [["10001", "10002"]]


def test_key_filter_combines_with_criteria() -> None:
    params: list = []
    where = criteria_to_where(
        CATALOG,
        _narrow(EnumFilter(kind="enum", key="enrollment", values=["democratic"])),
        KeyFilter(key_group="nyc_eds", keys=["75-001"]),
        params,
    )
    assert " AND " in where
    assert "enrollment IN (?)" in where
    assert "precinct IN (SELECT unnest(?))" in where
    assert params == ["democratic", ["75-001"]]


def test_key_filter_clips_criteria_with_trailing_add() -> None:
    # A trailing `add` makes the criteria a top-level OR; the key filter must
    # still clip the whole expression, not just the add branch.
    params: list = []
    where = criteria_to_where(
        CATALOG,
        Criteria(
            steps=[
                Step(verb="narrow", filter=EnumFilter(kind="enum", key="enrollment", values=["democratic"])),
                Step(verb="add", filter=EnumFilter(kind="enum", key="enrollment", values=["republican"])),
            ]
        ),
        KeyFilter(key_group="nyc_zips", keys=["10001"]),
        params,
    )
    assert where == "WHERE ((enrollment IN (?)) OR (enrollment IN (?))) AND (zip5 IN (SELECT unnest(?)))"
    assert params == ["democratic", "republican", ["10001"]]


def test_empty_key_set_short_circuits_to_match_nothing() -> None:
    # Empty `keys` is "no zones selected" — should match no rows rather
    # than emit a `IN ()` SQL syntax error.
    params: list = []
    where = criteria_to_where(
        CATALOG,
        Criteria(),
        KeyFilter(key_group="nyc_zips", keys=[]),
        params,
    )
    assert where == "WHERE 1=0"
    assert params == []


# ---------------------------------------------------------------------------
# Cascade — one query, N+1 filtered counts
# ---------------------------------------------------------------------------


def test_cascade_empty_criteria_emits_baseline_only() -> None:
    params: list = []
    sql = cascade_sql(CATALOG, Criteria(), "persons", params)
    assert sql == "SELECT count(*) AS step_0 FROM persons"
    assert params == []


def test_cascade_emits_one_filter_per_step() -> None:
    params: list = []
    sql = cascade_sql(
        CATALOG,
        Criteria(
            steps=[
                Step(verb="narrow", filter=EnumFilter(kind="enum", key="enrollment", values=["democratic"])),
                Step(verb="add", filter=EnumFilter(kind="enum", key="enrollment", values=["republican"])),
            ]
        ),
        "persons",
        params,
    )
    assert "step_0" in sql
    assert "step_1" in sql
    assert "step_2" in sql
    assert sql.count("FILTER (WHERE") == 2
    # Each step's filter compiles exactly once, in step order. Both clauses
    # are pushdown disjuncts here, so pushdown would save nothing and no
    # copies are appended.
    assert params == ["democratic", "republican"]


def test_cascade_pushdown_appends_first_clause_params() -> None:
    params: list = []
    sql = cascade_sql(
        CATALOG,
        Criteria(
            steps=[
                Step(verb="narrow", filter=EnumFilter(kind="enum", key="enrollment", values=["democratic"])),
                Step(verb="narrow", filter=EnumFilter(kind="enum", key="gender", values=["F"])),
            ]
        ),
        "persons",
        params,
    )
    # All-narrow chain: the first clause pushes into WHERE (its params bind
    # last, after the projection's) and step_0 becomes a scalar subquery.
    assert "WHERE" in sql
    assert "(SELECT count(*) FROM persons) AS step_0" in sql
    assert params == ["democratic", "F", "democratic"]


def test_cascade_pushdown_survives_add_when_narrows_follow() -> None:
    params: list = []
    sql = cascade_sql(
        CATALOG,
        Criteria(
            steps=[
                Step(verb="narrow", filter=EnumFilter(kind="enum", key="enrollment", values=["democratic"])),
                Step(verb="add", filter=EnumFilter(kind="enum", key="enrollment", values=["republican"])),
                Step(verb="narrow", filter=EnumFilter(kind="enum", key="gender", values=["F"])),
            ]
        ),
        "persons",
        params,
    )
    # The pushdown predicate is the first clause OR-ed with the add clause —
    # implied by every prefix — with both copies' params binding last.
    assert "WHERE (enrollment IN (?)) OR (enrollment IN (?))" in sql
    assert params == ["democratic", "republican", "F", "democratic", "republican"]


def _cascade_oracle(conn, criteria: Criteria) -> list[int]:
    """Per-prefix counts via the (verb-aware) WHERE compiler — the ground
    truth cascade_sql must reproduce in one scan."""
    counts = [conn.execute("SELECT count(*) FROM persons").fetchone()[0]]
    for i in range(1, len(criteria.steps) + 1):
        params: list = []
        where = criteria_to_where(CATALOG, Criteria(steps=criteria.steps[:i]), None, params)
        counts.append(conn.execute(f"SELECT count(*) FROM persons {where}", params).fetchone()[0])
    return counts


@pytest.mark.parametrize(
    "steps",
    [
        # Pure narrowing chain — takes the first-step WHERE pushdown path.
        [
            Step(verb="narrow", filter=TextMultiFilter(kind="text-multi", key="zip5", values=["11226", "10025"])),
            Step(verb="narrow", filter=EnumFilter(kind="enum", key="gender", values=["F"])),
            Step(verb="narrow", filter=EnumFilter(kind="enum", key="enrollment", values=["democratic"])),
        ],
        # A widening `add` — pushdown becomes first-clause OR add-clause;
        # counts can grow across the add step.
        [
            Step(verb="narrow", filter=EnumFilter(kind="enum", key="gender", values=["F"])),
            Step(verb="add", filter=EnumFilter(kind="enum", key="enrollment", values=["republican"])),
            Step(verb="narrow", filter=TextMultiFilter(kind="text-multi", key="zip5", values=["11226"])),
        ],
        # Adds interleaved with narrows and a remove — the OR-of-disjuncts
        # pushdown must stay implied by every prefix.
        [
            Step(verb="narrow", filter=TextMultiFilter(kind="text-multi", key="zip5", values=["11226", "10025"])),
            Step(verb="add", filter=EnumFilter(kind="enum", key="enrollment", values=["republican"])),
            Step(verb="remove", filter=EnumFilter(kind="enum", key="gender", values=["M"])),
            Step(verb="add", filter=TextMultiFilter(kind="text-multi", key="zip5", values=["10314"])),
            Step(verb="narrow", filter=EnumFilter(kind="enum", key="enrollment", values=["democratic"])),
        ],
        # `remove` first (a NOT disjunct) with a later add.
        [
            Step(verb="remove", filter=EnumFilter(kind="enum", key="gender", values=["M"])),
            Step(verb="add", filter=EnumFilter(kind="enum", key="enrollment", values=["republican"])),
            Step(verb="narrow", filter=TextMultiFilter(kind="text-multi", key="zip5", values=["11226"])),
        ],
        # `remove` after narrow, plus an inactive step (empty enum) mid-chain.
        [
            Step(verb="narrow", filter=TextMultiFilter(kind="text-multi", key="zip5", values=["11226", "10025"])),
            Step(verb="narrow", filter=EnumFilter(kind="enum", key="enrollment", values=[])),
            Step(verb="remove", filter=EnumFilter(kind="enum", key="gender", values=["M"])),
        ],
        # `remove` as the first step.
        [
            Step(verb="remove", filter=EnumFilter(kind="enum", key="gender", values=["M"])),
            Step(verb="narrow", filter=TextMultiFilter(kind="text-multi", key="zip5", values=["11226"])),
        ],
        # Inactive leading step: the prefix stays the full universe.
        [
            Step(verb="narrow", filter=EnumFilter(kind="enum", key="enrollment", values=[])),
            Step(verb="narrow", filter=EnumFilter(kind="enum", key="gender", values=["F"])),
        ],
    ],
)
def test_cascade_counts_match_prefix_where_compilation(steps) -> None:
    import duckdb

    conn = duckdb.connect()
    conn.execute("""
        CREATE TABLE persons AS
        FROM (VALUES
            ('11226', 'F', 'democratic'),
            ('11226', 'M', 'democratic'),
            ('11226', 'F', 'republican'),
            ('10025', 'F', 'democratic'),
            ('10025', 'M', 'republican'),
            ('10314', 'F', 'democratic'),
            ('10314', 'M', NULL)
        ) t(zip5, gender, enrollment)
    """)
    criteria = Criteria(steps=steps)
    params: list = []
    sql = cascade_sql(CATALOG, criteria, "persons", params)
    got = list(conn.execute(sql, params).fetchone())
    assert got == _cascade_oracle(conn, criteria)


def test_cascade_supports_stacked_subquery_filters() -> None:
    """Two custom-field steps: both compile to semi-join subqueries, which
    lateral column aliases can't chain (DuckDB BinderException) — the clause
    columns live in a real projection precisely so this shape works."""
    import duckdb

    conn = duckdb.connect()
    conn.execute("CREATE TABLE persons (external_id VARCHAR, zip5 VARCHAR)")
    conn.execute("INSERT INTO persons VALUES ('p1','11226'), ('p2','10025'), ('p3','10025')")
    conn.execute("CREATE TABLE cf (external_id VARCHAR, field_id VARCHAR, value VARCHAR)")
    conn.execute("INSERT INTO cf VALUES ('p1','f-enum','1'), ('p1','f-code','40'), ('p2','f-enum','2')")

    catalog = build_field_catalog(
        NYS_MANIFEST, custom_table="cf", custom_fields={"f-enum": "enum", "f-code": "text_multi"}
    )
    criteria = Criteria(
        steps=[
            Step(verb="narrow", filter=EnumFilter(kind="enum", key="f-enum", values=["1", "2"])),
            Step(verb="narrow", filter=TextMultiFilter(kind="text-multi", key="f-code", values=["40"])),
        ]
    )
    params: list = []
    sql = cascade_sql(catalog, criteria, "persons", params)
    step_0, step_1, step_2 = conn.execute(sql, params).fetchone()
    assert (step_0, step_1, step_2) == (3, 2, 1)


# ---------------------------------------------------------------------------
# Validation / error cases
# ---------------------------------------------------------------------------


def test_unknown_field_raises() -> None:
    with pytest.raises(CriteriaError):
        criteria_to_where(
            CATALOG,
            _narrow(EnumFilter(kind="enum", key="not_a_field", values=["x"])),
            None,
            [],
        )


def test_kind_field_def_mismatch_raises() -> None:
    # `zip5` is a text field; using it as an enum should error.
    with pytest.raises(CriteriaError):
        criteria_to_where(
            CATALOG,
            _narrow(EnumFilter(kind="enum", key="zip5", values=["10001"])),
            None,
            [],
        )


def test_unknown_key_group_raises() -> None:
    with pytest.raises(CriteriaError):
        boundary_key_expr_for(CATALOG, "not_a_group")


# ---------------------------------------------------------------------------
# Helper expressions
# ---------------------------------------------------------------------------


def test_column_expr_for_top_level() -> None:
    assert column_expr_for(CATALOG, "zip5") == "zip5"


def test_column_expr_for_promoted_field() -> None:
    assert column_expr_for(CATALOG, "enrollment") == "enrollment"


def test_boundary_key_expr_for_known_groups() -> None:
    assert boundary_key_expr_for(CATALOG, "nyc_zips") == "zip5"
    assert boundary_key_expr_for(CATALOG, "nyc_eds") == "precinct"


# ---------------------------------------------------------------------------
# NestedFilter — produced by the web layer when expanding segment refs.
# Compiles to a parenthesised boolean of the inner criteria; the outer
# step's verb composes it like any other filter.
# ---------------------------------------------------------------------------


def _inner_dem() -> NestedFilter:
    return NestedFilter(
        kind="nested",
        criteria=_narrow(EnumFilter(kind="enum", key="enrollment", values=["democratic"])),
    )


def test_nested_filter_narrow_composes_as_and() -> None:
    params: list = []
    where = criteria_to_where(
        CATALOG,
        Criteria(
            steps=[
                Step(verb="narrow", filter=TextFilter(kind="text", key="last_name", value="smith")),
                Step(verb="narrow", filter=_inner_dem()),
            ],
        ),
        None,
        params,
    )
    assert where == "WHERE (last_name ILIKE ?) AND ((enrollment IN (?)))"
    assert params == ["%smith%", "democratic"]


def test_nested_filter_add_composes_as_or() -> None:
    params: list = []
    where = criteria_to_where(
        CATALOG,
        Criteria(
            steps=[
                Step(verb="narrow", filter=TextFilter(kind="text", key="last_name", value="smith")),
                Step(verb="add", filter=_inner_dem()),
            ],
        ),
        None,
        params,
    )
    assert where == "WHERE (last_name ILIKE ?) OR ((enrollment IN (?)))"
    assert params == ["%smith%", "democratic"]


def test_nested_filter_remove_composes_as_and_not() -> None:
    params: list = []
    where = criteria_to_where(
        CATALOG,
        Criteria(
            steps=[
                Step(verb="narrow", filter=TextFilter(kind="text", key="last_name", value="smith")),
                Step(verb="remove", filter=_inner_dem()),
            ],
        ),
        None,
        params,
    )
    assert where == "WHERE (last_name ILIKE ?) AND NOT ((enrollment IN (?)))"
    assert params == ["%smith%", "democratic"]


def test_empty_nested_filter_matches_universe() -> None:
    # An empty segment matches everyone standalone (no WHERE), so an
    # empty NestedFilter must compile to 1=1 — letting "add: empty-seg"
    # after "remove: Everyone" correctly produce everyone.
    params: list = []
    where = criteria_to_where(
        CATALOG,
        Criteria(
            steps=[
                Step(verb="remove", filter=AllFilter(kind="all")),
                Step(verb="add", filter=NestedFilter(kind="nested", criteria=Criteria())),
            ],
        ),
        None,
        params,
    )
    assert where == "WHERE (NOT (1=1)) OR (1=1)"
    assert params == []


def test_nested_filter_with_internal_verbs_preserves_composition() -> None:
    # Inner criteria uses both narrow and add internally; the parenthesised
    # OR group must be wrapped intact when the outer step ANDs it in.
    inner = Criteria(
        steps=[
            Step(verb="narrow", filter=EnumFilter(kind="enum", key="enrollment", values=["democratic"])),
            Step(verb="add", filter=EnumFilter(kind="enum", key="enrollment", values=["working_families"])),
        ],
    )
    params: list = []
    where = criteria_to_where(
        CATALOG,
        Criteria(
            steps=[
                Step(verb="narrow", filter=TextFilter(kind="text", key="last_name", value="smith")),
                Step(verb="narrow", filter=NestedFilter(kind="nested", criteria=inner)),
            ],
        ),
        None,
        params,
    )
    assert where == "WHERE (last_name ILIKE ?) AND (((enrollment IN (?)) OR (enrollment IN (?))))"
    assert params == ["%smith%", "democratic", "working_families"]


def test_nested_filter_compiles_recursively() -> None:
    # Nested-inside-nested — what a chain of segment references produces.
    leaf = NestedFilter(
        kind="nested",
        criteria=_narrow(EnumFilter(kind="enum", key="enrollment", values=["democratic"])),
    )
    middle = NestedFilter(
        kind="nested",
        criteria=Criteria(steps=[Step(verb="narrow", filter=leaf)]),
    )
    params: list = []
    where = criteria_to_where(
        CATALOG,
        Criteria(steps=[Step(verb="narrow", filter=middle)]),
        None,
        params,
    )
    assert where == "WHERE ((enrollment IN (?)))"
    assert params == ["democratic"]


# ---------------------------------------------------------------------------
# PersonIdSetFilter — produced by resolving operational-data filters (e.g.
# CanvassOutcomeFilter) to a literal set of person external_ids.
# ---------------------------------------------------------------------------


def test_person_id_set_compiles_to_external_id_in() -> None:
    params: list = []
    where = criteria_to_where(
        CATALOG,
        _narrow(PersonIdSetFilter(kind="person-id-set", ids=["abc", "def"])),
        None,
        params,
    )
    assert where == "WHERE external_id IN (?, ?)"
    assert params == ["abc", "def"]


def test_empty_person_id_set_matches_nothing() -> None:
    # Distinct from an inactive filter: an empty *resolved* set means "no
    # person matched", so it must compile to 1=0 (not drop out).
    params: list = []
    where = criteria_to_where(
        CATALOG,
        _narrow(PersonIdSetFilter(kind="person-id-set", ids=[])),
        None,
        params,
    )
    assert where == "WHERE 1=0"
    assert params == []


def test_person_id_set_remove_composes_as_and_not() -> None:
    # The canonical "remove anyone canvassed" shape.
    params: list = []
    where = criteria_to_where(
        CATALOG,
        Criteria(
            steps=[
                Step(verb="narrow", filter=EnumFilter(kind="enum", key="enrollment", values=["democratic"])),
                Step(verb="remove", filter=PersonIdSetFilter(kind="person-id-set", ids=["abc"])),
            ]
        ),
        None,
        params,
    )
    assert where == "WHERE (enrollment IN (?)) AND NOT (external_id IN (?))"
    assert params == ["democratic", "abc"]


def test_unresolved_canvass_outcome_filter_raises() -> None:
    # CanvassOutcomeFilter must be reduced to a PersonIdSetFilter in resolve.py
    # before compilation; reaching the compiler is a bug.
    with pytest.raises(CriteriaError):
        criteria_to_where(
            CATALOG,
            _narrow(CanvassOutcomeFilter(kind="canvass-outcome", outcomes=["canvassed"])),
            None,
            [],
        )


def test_unresolved_canvass_response_filter_raises() -> None:
    # Same contract as the result filter — must be resolved before compilation.
    with pytest.raises(CriteriaError):
        criteria_to_where(
            CATALOG,
            _narrow(CanvassResponseFilter(kind="canvass-response", questionId="q1", optionIds=["supportive"])),
            None,
            [],
        )
