"""The contract every registered importer meets, run against its committed samples.

Each importer package ships one fake-data file per accepted format at
`sample_data/sample.<ext>`, all holding the same people. These tests load each one
through the importer and check what the shared pipeline and the app rely on, and
that every format yields identical people — so a new importer, or a new format,
is covered by adding its sample. Format-specific behaviour lives in each
importer's own test module.
"""

from __future__ import annotations

import inspect
from pathlib import Path

import pytest

from src.importers.base import ImportFilter
from src.importers.registry import IMPORTERS
from src.models import Person
from src.tables import table_fqn

SCHEMA = "contract_v1"


def _samples(importer_cls) -> list[Path]:
    return sorted((Path(inspect.getfile(importer_cls)).parent / "sample_data").glob("sample.*"))


importers = pytest.mark.parametrize("importer_cls", list(IMPORTERS.values()), ids=list(IMPORTERS))
samples = pytest.mark.parametrize(
    ("importer_cls", "sample"),
    [(cls, path) for cls in IMPORTERS.values() for path in _samples(cls)],
    ids=lambda v: v.name,  # importer name, sample filename
)


class _Progress:
    def __init__(self) -> None:
        self.steps = 0

    def advance(self, n: int = 1) -> None:
        self.steps += n


def _load(importer_cls, sample: Path, conn, filter: ImportFilter | None = None) -> _Progress:
    progress = _Progress()
    importer_cls().load(str(sample), SCHEMA, conn, progress, filter)
    return progress


def _people(conn) -> list[tuple]:
    return conn.sql(f"SELECT * FROM {table_fqn(SCHEMA, 'persons_validated')} ORDER BY external_id").fetchall()


def _columns(conn, table: str) -> set[str]:
    return set(conn.table(table_fqn(SCHEMA, table)).columns)


@samples
def test_progress_steps_match_the_declared_count(importer_cls, sample, conn) -> None:
    assert _load(importer_cls, sample, conn).steps == importer_cls.PROGRESS_STEPS


@samples
def test_output_carries_the_person_core_with_unique_ids(importer_cls, sample, conn) -> None:
    _load(importer_cls, sample, conn)
    assert set(Person.model_fields) <= _columns(conn, "persons_validated")
    total, distinct, nulls = conn.sql(
        f"SELECT count(*), count(DISTINCT external_id), count(*) - count(external_id) "
        f"FROM {table_fqn(SCHEMA, 'persons_validated')}"
    ).fetchone()
    assert total > 0
    assert distinct == total
    assert nulls == 0


@samples
def test_every_manifest_column_is_in_the_output(importer_cls, sample, conn) -> None:
    _load(importer_cls, sample, conn)
    columns = _columns(conn, "persons_validated")
    manifest_columns = {f.column for section in importer_cls().manifest().fields for f in section if f.column}
    assert manifest_columns <= columns


@samples
def test_filter_columns_exist_on_the_raw_table(importer_cls, sample, conn) -> None:
    _load(importer_cls, sample, conn)
    assert _columns(conn, "persons_raw") >= importer_cls.FILTER_COLUMNS


@samples
def test_filter_keeps_exactly_the_matching_rows(importer_cls, sample, conn) -> None:
    _load(importer_cls, sample, conn)
    raw = table_fqn(SCHEMA, "persons_raw")
    total = conn.sql(f"SELECT count(*) FROM {raw}").fetchone()[0]
    for column in sorted(importer_cls.FILTER_COLUMNS):
        value, expected = conn.sql(
            f"SELECT {column}, count(*) FROM {raw} WHERE {column} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 1"
        ).fetchone()
        # The sample has to vary on every filter column, or this proves nothing.
        assert expected < total, f"sample has a single value for filter column {column!r}"

        _load(importer_cls, sample, conn, ImportFilter(column=column, values=[value]))
        kept = conn.sql(f"SELECT count(*) FROM {table_fqn(SCHEMA, 'persons_validated')}").fetchone()[0]
        assert kept == expected, column


@importers
def test_importer_ships_a_sample(importer_cls) -> None:
    assert _samples(importer_cls), f"{importer_cls.name} has no sample_data/sample.* file"


@samples
def test_load_is_deterministic(importer_cls, sample, conn) -> None:
    _load(importer_cls, sample, conn)
    first = _people(conn)
    _load(importer_cls, sample, conn)
    assert _people(conn) == first


@importers
def test_every_format_yields_the_same_people(importer_cls, conn) -> None:
    reference, *others = _samples(importer_cls)
    _load(importer_cls, reference, conn)
    expected = _people(conn)
    for sample in others:
        _load(importer_cls, sample, conn)
        assert _people(conn) == expected, f"{sample.name} differs from {reference.name}"
