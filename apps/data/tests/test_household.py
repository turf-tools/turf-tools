"""Householding criteria: narrow / fill / remove (+ last-name key) and cascade."""

from __future__ import annotations

import pytest

import duckdb
from src.dsl.compile import cascade_sql, criteria_to_where
from src.dsl.criteria import (
    Criteria,
    EnumFilter,
    HouseholdFilter,
    Step,
    build_field_catalog,
)
from src.dsl.expand import SegmentLike, SegmentRefError, expand_segment_refs
from src.importers.fl_voter_file.manifest import FL_MANIFEST
from src.importers.nys_voter_file.manifest import NYS_MANIFEST

NYS = build_field_catalog(NYS_MANIFEST)
FL = build_field_catalog(FL_MANIFEST)


def _conn() -> duckdb.DuckDBPyConnection:
    conn = duckdb.connect()
    # building-A has two doors (door-1, door-2); building-B has door-3 alone.
    # d1 is a republican with no door_id — fill must keep them via seed ∪ members.
    conn.execute("""
        CREATE TABLE persons AS
        FROM (VALUES
            ('a1', 'door-1', 'bldg-A', 'Smith', 'democratic', '555-1111'),
            ('a2', 'door-1', 'bldg-A', 'Smith', 'democratic', '555-1111'),
            ('a3', 'door-1', 'bldg-A', 'Jones', 'republican', NULL),
            ('b1', 'door-2', 'bldg-A', 'Lee',   'democratic', '555-2222'),
            ('b2', 'door-2', 'bldg-A', 'Lee',   'republican', '555-2222'),
            ('c1', 'door-3', 'bldg-B', 'Ng',    'democratic', NULL),
            ('d1', NULL,     NULL,     'Orphan','republican', NULL)
        ) t(external_id, door_id, building_id, last_name, enrollment, phone)
    """)
    return conn


def _ids(conn: duckdb.DuckDBPyConnection, criteria: Criteria, catalog=NYS) -> set[str]:
    params: list = []
    where = criteria_to_where(catalog, criteria, None, params, persons_table="persons")
    rows = conn.execute(f"SELECT external_id FROM persons {where}", params).fetchall()
    return {r[0] for r in rows}


def test_narrow_one_person_per_door() -> None:
    conn = _conn()
    criteria = Criteria(
        steps=[
            Step(
                verb="narrow",
                filter=EnumFilter(kind="enum", key="enrollment", values=["democratic"]),
            ),
            Step(
                verb="narrow",
                filter=HouseholdFilter(
                    kind="household",
                    groupBy="door_id",
                    matchLastName=False,
                ),
            ),
        ]
    )
    # Democrats: a1, a2, b1, c1 — doors 1/2/3 → one each (lowest external_id).
    assert _ids(conn, criteria) == {"a1", "b1", "c1"}


def test_narrow_with_last_name_splits_household() -> None:
    conn = _conn()
    criteria = Criteria(
        steps=[
            Step(
                verb="narrow",
                filter=HouseholdFilter(
                    kind="household",
                    groupBy="door_id",
                    matchLastName=True,
                ),
            ),
        ]
    )
    # door-1 has Smith + Jones → two keepers; door-2 Lee → one; door-3 Ng → one.
    assert _ids(conn, criteria) == {"a1", "a3", "b1", "c1"}


def test_fill_expands_to_full_household() -> None:
    conn = _conn()
    criteria = Criteria(
        steps=[
            Step(
                verb="narrow",
                filter=EnumFilter(kind="enum", key="enrollment", values=["republican"]),
            ),
            Step(
                verb="add",
                filter=HouseholdFilter(
                    kind="household",
                    groupBy="door_id",
                    matchLastName=False,
                ),
            ),
        ]
    )
    # Republicans a3/b2/d1 ∪ everyone at door-1/door-2. d1 kept despite null door_id.
    assert _ids(conn, criteria) == {"a1", "a2", "a3", "b1", "b2", "d1"}


def test_fill_by_building_id_spans_doors() -> None:
    conn = _conn()
    criteria = Criteria(
        steps=[
            Step(
                verb="narrow",
                filter=EnumFilter(kind="enum", key="enrollment", values=["republican"]),
            ),
            Step(
                verb="add",
                filter=HouseholdFilter(
                    kind="household",
                    groupBy="building_id",
                    matchLastName=False,
                ),
            ),
        ]
    )
    # Republicans in bldg-A (+ doorless d1) → every door in bldg-A, not bldg-B.
    assert _ids(conn, criteria) == {"a1", "a2", "a3", "b1", "b2", "d1"}


def test_remove_drops_keys_in_other_segment() -> None:
    conn = _conn()
    other = Criteria(
        steps=[
            Step(
                verb="narrow",
                filter=EnumFilter(kind="enum", key="enrollment", values=["republican"]),
            ),
        ]
    )
    criteria = Criteria(
        steps=[
            Step(
                verb="narrow",
                filter=EnumFilter(kind="enum", key="enrollment", values=["democratic"]),
            ),
            Step(
                verb="remove",
                filter=HouseholdFilter(
                    kind="household",
                    groupBy="door_id",
                    matchLastName=False,
                    otherCriteria=other,
                ),
            ),
        ]
    )
    # Democrats whose door also has a republican (door-1, door-2) drop; c1 stays.
    assert _ids(conn, criteria) == {"c1"}


def test_remove_inactive_without_other_is_noop() -> None:
    conn = _conn()
    criteria = Criteria(
        steps=[
            Step(
                verb="narrow",
                filter=EnumFilter(kind="enum", key="enrollment", values=["democratic"]),
            ),
            Step(
                verb="remove",
                filter=HouseholdFilter(
                    kind="household",
                    groupBy="door_id",
                    otherSegmentId=None,
                    otherCriteria=None,
                ),
            ),
        ]
    )
    assert _ids(conn, criteria) == {"a1", "a2", "b1", "c1"}


def test_phone_group_by_requires_phone_field() -> None:
    # NYS has no phone field → phone householding is inactive (universe).
    params: list = []
    where = criteria_to_where(
        NYS,
        Criteria(
            steps=[
                Step(
                    verb="narrow",
                    filter=HouseholdFilter(
                        kind="household",
                        groupBy="phone",
                    ),
                ),
            ]
        ),
        None,
        params,
        persons_table="persons",
    )
    assert where == ""


def test_phone_narrow_on_fl_catalog() -> None:
    conn = _conn()
    criteria = Criteria(
        steps=[
            Step(
                verb="narrow",
                filter=HouseholdFilter(
                    kind="household",
                    groupBy="phone",
                    matchLastName=False,
                ),
            ),
        ]
    )
    # Null phones never seed a key; 555-1111 → a1; 555-2222 → b1.
    assert _ids(conn, criteria, catalog=FL) == {"a1", "b1"}


def test_household_where_placeholders_resolve_for_fqn_paths() -> None:
    """Call sites that interpolate an already-FQN persons table (publish,
    progress targets, results) must resolve the WHERE fragment so household
    subqueries don't keep the ``{persons_geocoded}`` token."""
    from src.tables import resolve as resolve_sql

    params: list = []
    where = criteria_to_where(
        NYS,
        Criteria(
            steps=[
                Step(
                    verb="narrow",
                    filter=EnumFilter(kind="enum", key="enrollment", values=["democratic"]),
                ),
                Step(
                    verb="add",
                    filter=HouseholdFilter(
                        kind="household",
                        groupBy="door_id",
                    ),
                ),
            ]
        ),
        None,
        params,
    )
    assert "{persons_geocoded}" in where
    resolved = resolve_sql(where, "testds_v1")
    assert "{persons_geocoded}" not in resolved
    assert "ducklake.testds_v1.persons_geocoded" in resolved


def test_cascade_with_household_matches_prefix_where() -> None:
    conn = _conn()
    criteria = Criteria(
        steps=[
            Step(
                verb="narrow",
                filter=EnumFilter(kind="enum", key="enrollment", values=["democratic"]),
            ),
            Step(
                verb="narrow",
                filter=HouseholdFilter(
                    kind="household",
                    groupBy="door_id",
                ),
            ),
            Step(
                verb="add",
                filter=HouseholdFilter(
                    kind="household",
                    groupBy="door_id",
                ),
            ),
        ]
    )
    params: list = []
    sql = cascade_sql(NYS, criteria, "persons", params)
    assert "{persons_geocoded}" not in sql
    got = list(conn.execute(sql, params).fetchone())

    expected = [conn.execute("SELECT count(*) FROM persons").fetchone()[0]]
    for i in range(1, len(criteria.steps) + 1):
        p: list = []
        where = criteria_to_where(NYS, Criteria(steps=criteria.steps[:i]), None, p, persons_table="persons")
        expected.append(conn.execute(f"SELECT count(*) FROM persons {where}", p).fetchone()[0])
    assert got == expected


def test_cascade_nested_household_resolves_persons_table() -> None:
    """Householding inside a NestedFilter (expanded segment) must use the
    cascade persons_table, not the unresolved ``{persons_geocoded}`` placeholder."""
    from src.dsl.criteria import NestedFilter

    conn = _conn()
    nested = Criteria(
        steps=[
            Step(
                verb="narrow",
                filter=EnumFilter(kind="enum", key="enrollment", values=["democratic"]),
            ),
            Step(
                verb="add",
                filter=HouseholdFilter(
                    kind="household",
                    groupBy="door_id",
                ),
            ),
        ]
    )
    criteria = Criteria(
        steps=[
            Step(
                verb="narrow",
                filter=EnumFilter(kind="enum", key="enrollment", values=["republican"]),
            ),
            Step(verb="add", filter=NestedFilter(kind="nested", criteria=nested)),
        ]
    )
    params: list = []
    sql = cascade_sql(NYS, criteria, "persons", params)
    assert "{persons_geocoded}" not in sql
    assert "AS c_" not in sql  # household forces prefix-restatement path
    got = list(conn.execute(sql, params).fetchone())

    expected = [conn.execute("SELECT count(*) FROM persons").fetchone()[0]]
    for i in range(1, len(criteria.steps) + 1):
        p: list = []
        where = criteria_to_where(NYS, Criteria(steps=criteria.steps[:i]), None, p, persons_table="persons")
        expected.append(conn.execute(f"SELECT count(*) FROM persons {where}", p).fetchone()[0])
    assert got == expected


def test_expand_household_remove_inlines_other_segment() -> None:
    other = SegmentLike(
        segment_id="other",
        name="Other",
        criteria=Criteria(
            steps=[
                Step(
                    verb="narrow",
                    filter=EnumFilter(kind="enum", key="enrollment", values=["republican"]),
                ),
            ]
        ),
    )
    outer = Criteria(
        steps=[
            Step(
                verb="remove",
                filter=HouseholdFilter(
                    kind="household",
                    groupBy="door_id",
                    otherSegmentId="other",
                ),
            ),
        ]
    )
    expanded = expand_segment_refs(outer, {"other": other})
    hh = expanded.steps[0].filter
    assert isinstance(hh, HouseholdFilter)
    assert hh.other_criteria is not None
    assert hh.other_criteria.steps[0].filter.kind == "enum"


def test_expand_household_remove_cycle() -> None:
    a = SegmentLike(
        segment_id="a",
        name="A",
        criteria=Criteria(
            steps=[
                Step(
                    verb="remove",
                    filter=HouseholdFilter(
                        kind="household",
                        groupBy="door_id",
                        otherSegmentId="b",
                    ),
                ),
            ]
        ),
    )
    b = SegmentLike(
        segment_id="b",
        name="B",
        criteria=Criteria(
            steps=[
                Step(
                    verb="remove",
                    filter=HouseholdFilter(
                        kind="household",
                        groupBy="door_id",
                        otherSegmentId="a",
                    ),
                ),
            ]
        ),
    )
    with pytest.raises(SegmentRefError) as exc:
        expand_segment_refs(a.criteria, {"a": a, "b": b})
    assert exc.value.kind == "cycle"
