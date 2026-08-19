"""The metadata-resolution split: mutable pointers and the custom-field
registry read fresh per call, immutable version payloads cached by id, the
values-table probe cached monotonically. Pins the correctness story:
activation (a pointer move) takes effect on the very next call, while the
expensive manifest fetch+parse runs once per version, ever."""

from __future__ import annotations

import json

import pytest

from src import custom_fields, tables
from src.custom_fields import custom_fields_table_for, query_context
from src.tables import NoActiveDatasetError, resolve_version

MANIFEST = {
    "datasetSlug": "probe",
    "fields": [],
}


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


class _StubConn:
    """Duck-typed connection: serves the pointer/merged and version-payload
    queries from attributes, counting how often the (expensive) payload
    query runs."""

    def __init__(self, active: str | None = "v-1", fields: list[tuple[str, str]] | None = None):
        self.active = active
        self.fields = fields or []
        self.version_fetches = 0

    def execute(self, sql: str, params: list | None = None):
        if "custom_field_id" in sql and "organizations" in sql:  # merged context query
            if self.active is None:
                return _Result([(None, None, None)])
            if self.fields:
                return _Result([(self.active, fid, ftype) for fid, ftype in self.fields])
            return _Result([(self.active, None, None)])
        if "active_dataset_version_id FROM" in sql:  # pointer-only query
            return _Result([(self.active,)])
        self.version_fetches += 1  # version-payload query
        assert params is not None
        number = int(params[0].removeprefix("v-"))  # "v-2" → version 2
        return _Result([("probe", number, json.dumps(MANIFEST), None)])


@pytest.fixture(autouse=True)
def _isolated_caches(monkeypatch):
    monkeypatch.setattr(tables, "_resolved_versions", {})
    monkeypatch.setattr(custom_fields, "_values_table_cache", {})
    monkeypatch.setattr(tables, "attach_operational_postgres", lambda conn, settings: None)
    monkeypatch.setattr(custom_fields, "attach_operational_postgres", lambda conn, settings: None)


def test_version_payload_fetched_once_and_cached() -> None:
    conn = _StubConn()
    a = resolve_version(conn, None, "default")
    b = resolve_version(conn, None, "default")
    assert a is b
    assert a.version_number == 1
    assert conn.version_fetches == 1


def test_activation_takes_effect_on_next_call() -> None:
    conn = _StubConn()
    assert resolve_version(conn, None, "default").version_number == 1
    conn.active = "v-2"  # the pointer moved (web-side activate)
    assert resolve_version(conn, None, "default").version_number == 2


def test_no_active_version_raises_empty_state() -> None:
    conn = _StubConn(active=None)
    with pytest.raises(NoActiveDatasetError):
        resolve_version(conn, None, "default")


def test_query_context_registers_custom_fields(monkeypatch) -> None:
    monkeypatch.setattr(custom_fields, "custom_wide_table_for", lambda conn, slug: "cf_wide")
    conn = _StubConn(fields=[("f-1", "enum"), ("f-2", "number")])
    version, catalog = query_context(conn, "default")
    assert version.dataset_slug == "probe"
    assert "f-1" in catalog.fields
    assert "f-2" in catalog.fields
    # The payload rides the same immutable cache as resolve_version.
    query_context(conn, "default")
    assert conn.version_fetches == 1


def test_query_context_skips_probe_without_custom_fields(monkeypatch) -> None:
    def _boom(conn, slug):
        raise AssertionError("probe must not run when the registry is empty")

    monkeypatch.setattr(custom_fields, "custom_wide_table_for", _boom)
    _version, catalog = query_context(_StubConn(), "default")
    assert catalog.fields is not None


def test_query_context_no_active_version_raises() -> None:
    with pytest.raises(NoActiveDatasetError):
        query_context(_StubConn(active=None), "default")


class _ProbeConn:
    def __init__(self, exists: bool):
        self.exists = exists
        self.probes = 0

    def execute(self, sql: str, params: list | None = None):
        self.probes += 1
        if not self.exists:
            raise RuntimeError("no such table")
        return _Result([(1,)])


def test_values_table_probe_cached_both_ways() -> None:
    hit = _ProbeConn(exists=True)
    assert custom_fields_table_for(hit, "ds") is not None
    assert custom_fields_table_for(hit, "ds") is not None
    assert hit.probes == 1

    miss = _ProbeConn(exists=False)
    assert custom_fields_table_for(miss, "ds-2") is None
    assert custom_fields_table_for(miss, "ds-2") is None
    assert miss.probes == 1
    # Append creates the table and drops the cached miss.
    custom_fields._values_table_cache.pop("ds-2", None)
    miss.exists = True
    assert custom_fields_table_for(miss, "ds-2") is not None


class _StaleConn(_StubConn):
    """First operational query raises the stale-catalog error; healthy after
    `pg_clear_cache` runs — the fresh-deployment poisoned-attach shape."""

    def __init__(self):
        super().__init__()
        self.cleared = False

    def execute(self, sql: str, params: list | None = None):
        if "pg_clear_cache" in sql:
            self.cleared = True
            return _Result([])
        if not self.cleared and "organizations" in sql:
            import duckdb

            raise duckdb.CatalogException('Table with name "app.organizations" does not exist')
        return super().execute(sql, params)


def test_stale_attach_healed_once_and_retried() -> None:
    conn = _StaleConn()
    version, _catalog = query_context(conn, "default")
    assert conn.cleared
    assert version.version_number == 1


def test_resolve_version_heals_stale_attach() -> None:
    conn = _StaleConn()
    assert resolve_version(conn, None, "default").version_number == 1
    assert conn.cleared
