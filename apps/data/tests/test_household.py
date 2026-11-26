"""Household Members steps: door/building fill, inactive outside add, cascade."""

from __future__ import annotations

import duckdb
from src.dsl.compile import cascade_sql, criteria_to_where
from src.dsl.criteria import (
    Criteria,
    EnumFilter,
    HouseholdFilter,
    NestedFilter,
    Step,
    build_field_catalog,
)
from src.importers.nys_voter_file.manifest import NYS_MANIFEST
from src.tables import resolve

NYS = build_field_catalog(NYS_MANIFEST)


def _conn() -> duckdb.DuckDBPyConnection:
    conn = duckdb.connect()
    # Building 1 has doors 1 and 2; building 2 has door 3 alone.
    conn.execute("""
        CREATE TABLE persons AS
        FROM (VALUES
            ('a1', 1, 1, 'democratic'),
            ('a2', 1, 1, 'democratic'),
            ('a3', 1, 1, 'republican'),
            ('b1', 2, 1, 'democratic'),
            ('b2', 2, 1, 'republican'),
            ('c1', 3, 2, 'democratic'),
            ('d1', 4, 3, 'republican')
        ) t(external_id, door_i, building_i, enrollment)
    """)
    return conn


def _local(sql: str) -> str:
    """Point the compiled `{persons_geocoded}` subqueries at the test table."""
    return sql.replace("{persons_geocoded}", "persons")


def _ids(conn: duckdb.DuckDBPyConnection, criteria: Criteria) -> set[str]:
    params: list = []
    where = _local(criteria_to_where(NYS, criteria, None, params))
    return {r[0] for r in conn.execute(f"SELECT external_id FROM persons {where}", params).fetchall()}


def _party(verb: str, party: str) -> Step:
    return Step(verb=verb, filter=EnumFilter(kind="enum", key="enrollment", values=[party]))


def _household(verb: str = "add", building: bool = False) -> Step:
    return Step(verb=verb, filter=HouseholdFilter(kind="household", building=building))


def test_fill_adds_everyone_at_the_door() -> None:
    criteria = Criteria(steps=[_party("narrow", "republican"), _household()])
    # Republicans a3, b2, d1 → everyone at doors 1, 2 and 4.
    assert _ids(_conn(), criteria) == {"a1", "a2", "a3", "b1", "b2", "d1"}


def test_fill_by_building_spans_doors() -> None:
    criteria = Criteria(steps=[_party("narrow", "republican"), _household(building=True)])
    # b2 is at door 2 of building 1, so building 1's door 1 comes too; c1's building has no republican.
    assert _ids(_conn(), criteria) == {"a1", "a2", "a3", "b1", "b2", "d1"}
    criteria = Criteria(steps=[_party("narrow", "democratic"), _household(building=True)])
    assert _ids(_conn(), criteria) == {"a1", "a2", "a3", "b1", "b2", "c1"}


def test_steps_after_a_fill_apply_to_the_filled_set() -> None:
    # Democrats → their households → drop the republicans the fill brought in.
    criteria = Criteria(steps=[_party("narrow", "democratic"), _household(), _party("remove", "republican")])
    assert _ids(_conn(), criteria) == {"a1", "a2", "b1", "c1"}


def test_params_bind_in_order_around_a_fill() -> None:
    criteria = Criteria(
        steps=[
            _party("narrow", "republican"),
            _household(),
            _party("remove", "democratic"),
            _party("add", "democratic"),
        ]
    )
    params: list = []
    criteria_to_where(NYS, criteria, None, params)
    assert params == ["republican", "democratic", "democratic"]
    assert _ids(_conn(), criteria) == {"a1", "a2", "a3", "b1", "b2", "c1", "d1"}


def test_stacked_fills() -> None:
    criteria = Criteria(steps=[_party("narrow", "republican"), _household(), _household(building=True)])
    assert _ids(_conn(), criteria) == {"a1", "a2", "a3", "b1", "b2", "d1"}


def test_first_step_fill_matches_everyone_until_a_step_precedes_it() -> None:
    assert criteria_to_where(NYS, Criteria(steps=[_household()]), None, []) == ""
    criteria = Criteria(steps=[_household(), _party("narrow", "republican")])
    assert _ids(_conn(), criteria) == {"a3", "b2", "d1"}
    _cascade_matches_prefixes(criteria)


def test_household_outside_add_is_inactive() -> None:
    for verb in ("narrow", "remove"):
        criteria = Criteria(steps=[_party("narrow", "republican"), _household(verb)])
        assert _ids(_conn(), criteria) == {"a3", "b2", "d1"}
    assert criteria_to_where(NYS, Criteria(steps=[_household("narrow")]), None, []) == ""


def test_fill_names_the_persons_placeholder() -> None:
    where = criteria_to_where(NYS, Criteria(steps=[_party("narrow", "republican"), _household()]), None, [])
    assert "{persons_geocoded}" in where
    assert "ducklake.testds_v1.persons_geocoded" in resolve(where, "testds_v1")


def _cascade_matches_prefixes(criteria: Criteria) -> None:
    conn = _conn()
    params: list = []
    sql = _local(cascade_sql(NYS, criteria, "persons", params))
    assert "AS c_" not in sql  # per-prefix path, not the single-scan columns
    got = list(conn.execute(sql, params).fetchone())
    expected = [conn.execute("SELECT count(*) FROM persons").fetchone()[0]]
    for i in range(1, len(criteria.steps) + 1):
        expected.append(len(_ids(conn, Criteria(steps=criteria.steps[:i]))))
    assert got == expected


def test_cascade_with_a_fill_matches_each_prefix() -> None:
    _cascade_matches_prefixes(
        Criteria(steps=[_party("narrow", "democratic"), _household(), _party("remove", "republican")])
    )


def test_cascade_with_a_fill_inside_a_nested_segment() -> None:
    nested = Step(
        verb="add",
        filter=NestedFilter(kind="nested", criteria=Criteria(steps=[_party("narrow", "democratic"), _household()])),
    )
    _cascade_matches_prefixes(Criteria(steps=[_party("narrow", "republican"), nested]))
