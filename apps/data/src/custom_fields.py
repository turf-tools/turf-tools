"""Custom-field lake storage.

One long-format table per dataset, beside (not inside) the version schemas —
`ducklake.main.<slug>_custom_fields (external_id, field_id, value, upload_id)`
— which is what makes floating-across-versions visible in the layout itself.
One row per (person, field) that has a value; `value` is a string cast at
query time. Mutated directly (insert/upsert/delete) — history comes from
DuckLake snapshots, not a hand-rolled journal.

Used by the synchronous append and clear endpoints in `main.py`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from src.dsl.criteria import FieldCatalog, build_field_catalog
from src.duckdb import OPERATIONAL_PG_ALIAS, attach_operational_postgres, heal_stale_attach
from src.settings import get_settings
from src.tables import (
    NoActiveDatasetError,
    ResolvedVersion,
    dataset_version_schema,
    resolve_version_by_id,
    table_fqn,
)
from src.timing import timed

if TYPE_CHECKING:
    import duckdb

# Dataset-scoped custom-field tables live in the catalog's default schema.
_SCHEMA = "main"

# Enum option sets above this are almost certainly not pickable — fail loudly
# rather than silently building a 5,000-toggle picker. The error names both
# escalations since only the caller knows whether the values are identifiers
# (Code) or free text (Text).
_ENUM_VALUES_CAP = 100

_FIELD_TYPES = ("number", "date", "text", "text_multi", "enum")

# Display names for error messages — mirrors the UI's FIELD_TYPE_META.
_TYPE_LABELS = {
    "number": "Number",
    "date": "Date",
    "text": "Text",
    "text_multi": "Code",
    "enum": "Category",
}


def custom_fields_fqn(dataset_slug: str) -> str:
    return table_fqn(_SCHEMA, f"{dataset_slug}_custom_fields")


def ensure_custom_fields_table(conn: duckdb.DuckDBPyConnection, dataset_slug: str) -> None:
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {custom_fields_fqn(dataset_slug)} (
            external_id VARCHAR, field_id VARCHAR, value VARCHAR, upload_id VARCHAR
        )
        """
    )


# Existence probes cached per dataset — the answer is monotonic (the values
# table is created by `append_custom_fields` and never dropped; `clear` only
# deletes rows), so only the None→exists transition invalidates, on append.
# Saves a catalog round trip — or a raised-and-swallowed exception — per
# criteria request.
_values_table_cache: dict[str, str | None] = {}


def custom_fields_table_for(conn: duckdb.DuckDBPyConnection, dataset_slug: str) -> str | None:
    """FQN of the dataset's values table, or None before any append — custom
    filters then compile to match-nothing rather than erroring."""
    if dataset_slug in _values_table_cache:
        return _values_table_cache[dataset_slug]
    fqn = custom_fields_fqn(dataset_slug)
    try:
        conn.execute(f"SELECT 1 FROM {fqn} LIMIT 0")
    except Exception:  # noqa: BLE001 — missing table is the expected miss
        _values_table_cache[dataset_slug] = None
        return None
    _values_table_cache[dataset_slug] = fqn
    return fqn


def sync_registry(conn: duckdb.DuckDBPyConnection, dataset_slug: str, *, include_values: bool = True) -> None:
    """Mirror per-field coverage (and enum option sets) onto the Postgres
    registry. Safe as a cache: values only change through the two callers
    (append ingest, clear) — no third writer to drift against. Simple
    per-row statements: the postgres ATTACH doesn't reliably support
    UPDATE...FROM joined against lake tables, and the registry is small."""
    attach_operational_postgres(conn, get_settings())
    counts = conn.execute(
        f"SELECT field_id, count(DISTINCT external_id) FROM {custom_fields_fqn(dataset_slug)} GROUP BY field_id"
    ).fetchall()
    conn.execute(
        f"""
        UPDATE {OPERATIONAL_PG_ALIAS}.app.custom_fields SET person_count = 0
        WHERE dataset_id = (SELECT dataset_id FROM {OPERATIONAL_PG_ALIAS}.app.datasets WHERE slug = ?)
        """,
        [dataset_slug],
    )
    for field_id, n in counts:
        conn.execute(
            f"UPDATE {OPERATIONAL_PG_ALIAS}.app.custom_fields SET person_count = ? WHERE custom_field_id = ?::UUID",
            [n, field_id],
        )
    # Enum option sets are owned by APPEND (derived from the data at ingest)
    # and never touched by clear — a cleared field keeps its last-known
    # options so open filter cards stay renderable (matching no one) instead
    # of stranding selections against an empty picker.
    if not include_values:
        return
    enum_fields = conn.execute(
        f"""
        SELECT f.custom_field_id::VARCHAR FROM {OPERATIONAL_PG_ALIAS}.app.custom_fields f
        JOIN {OPERATIONAL_PG_ALIAS}.app.datasets d ON d.dataset_id = f.dataset_id
        WHERE d.slug = ? AND f.field_type = 'enum'
        """,
        [dataset_slug],
    ).fetchall()
    for (field_id,) in enum_fields:
        values = [
            r[0]
            for r in conn.execute(
                f"SELECT DISTINCT value FROM {custom_fields_fqn(dataset_slug)} WHERE field_id = ? ORDER BY value",
                [field_id],
            ).fetchall()
        ]
        conn.execute(
            f"UPDATE {OPERATIONAL_PG_ALIAS}.app.custom_fields SET values = ? WHERE custom_field_id = ?::UUID",
            [values, field_id],
        )


def query_context(conn: duckdb.DuckDBPyConnection, org_slug: str) -> tuple[ResolvedVersion, FieldCatalog]:
    """The active version + compiler catalog for an org, in one operational-PG
    round trip. Everything that can change between requests — the active
    pointer, the custom-field registry (fields are created/renamed by web-side
    writes this process never sees; archived included, saved segments must
    still compile) — is read fresh together; the version payload and the
    values-table probe come from caches (immutable / monotonic)."""
    with timed("resolve"):
        attach_operational_postgres(conn, get_settings())
        rows = heal_stale_attach(
            conn,
            lambda: conn.execute(
                f"""
                SELECT o.active_dataset_version_id, f.custom_field_id::VARCHAR, f.field_type
                FROM {OPERATIONAL_PG_ALIAS}.app.organizations o
                LEFT JOIN {OPERATIONAL_PG_ALIAS}.app.dataset_versions v
                    ON v.dataset_version_id = o.active_dataset_version_id
                LEFT JOIN {OPERATIONAL_PG_ALIAS}.app.custom_fields f ON f.dataset_id = v.dataset_id
                WHERE o.slug = ?
                """,
                [org_slug],
            ).fetchall(),
        )
        if not rows or rows[0][0] is None:
            raise NoActiveDatasetError(org_slug)
        version = resolve_version_by_id(conn, str(rows[0][0]))
    with timed("catalog"):
        custom_fields = {fid: ftype for (_vid, fid, ftype) in rows if fid is not None}
        if not custom_fields:
            return version, build_field_catalog(version.manifest)
        return version, build_field_catalog(
            version.manifest,
            custom_table=custom_fields_table_for(conn, version.dataset_slug),
            custom_fields=custom_fields,
        )


def catalog_for(conn: duckdb.DuckDBPyConnection, version: ResolvedVersion) -> FieldCatalog:
    """The compiler catalog for a resolved version: manifest fields plus the
    dataset's custom fields (archived included — saved segments referencing an
    archived field must still compile). One small PG read + one table probe
    per request."""
    with timed("catalog"):
        return _catalog_for(conn, version)


def _catalog_for(conn: duckdb.DuckDBPyConnection, version: ResolvedVersion) -> FieldCatalog:
    attach_operational_postgres(conn, get_settings())
    rows = conn.execute(
        f"""
        SELECT f.custom_field_id::VARCHAR, f.field_type
        FROM {OPERATIONAL_PG_ALIAS}.app.custom_fields f
        JOIN {OPERATIONAL_PG_ALIAS}.app.datasets d ON d.dataset_id = f.dataset_id
        WHERE d.slug = ?
        """,
        [version.dataset_slug],
    ).fetchall()
    return build_field_catalog(
        version.manifest,
        custom_table=custom_fields_table_for(conn, version.dataset_slug),
        custom_fields={r[0]: r[1] for r in rows},
    )


def load_upload_table(conn: duckdb.DuckDBPyConnection, path: str) -> list[str]:
    """Load an uploaded file into the `_upload` temp table and return its
    column names. Format by magic bytes: parquet ("PAR1") or CSV (header row
    required, all_varchar so ids keep leading zeros). The single parser for
    both the inspect and append endpoints — one place for format logic and
    errors."""
    with open(path, "rb") as f:
        magic = f.read(4)
    if magic == b"PAR1":
        conn.execute("CREATE OR REPLACE TEMP TABLE _upload AS SELECT * FROM read_parquet(?)", [path])
    else:
        conn.execute(
            "CREATE OR REPLACE TEMP TABLE _upload AS SELECT * FROM read_csv(?, all_varchar = true, header = true)",
            [path],
        )
    cols = [r[0] for r in conn.execute("DESCRIBE _upload").fetchall()]
    if not cols:
        raise ValueError("Uploaded file has no columns.")
    if len(cols) > 2:
        raise ValueError(f"File has {len(cols)} columns, must have one (IDs only) or two (IDs and values).")
    return cols


def parse_upload(
    conn: duckdb.DuckDBPyConnection,
    source: str,
    field_type: str,
    label_arg: str | None,
    value: str | None,
) -> tuple[str, int, int]:
    """Load → normalize → validate one upload file. Leaves the normalized
    rows in the `_rows` temp table for the caller and returns
    (label, row_count, skipped_count). Pure DuckDB — tests run it against an
    in-memory connection with fixture CSVs."""
    if field_type not in _FIELD_TYPES:
        raise ValueError(f"Unknown field type {field_type!r}.")
    cols = load_upload_table(conn, source)
    # Two-column files: the field name IS the value column's header.
    if len(cols) == 2:
        label = cols[1].strip()
        if not label:
            raise ValueError("The value column needs a header name.")
    else:
        label = label_arg.strip() if label_arg else None
        if not label:
            raise ValueError("A one-column file needs a field name.")
    id_col = f'CAST("{cols[0]}" AS VARCHAR)'

    # Normalize to (external_id, label, value); trim, drop empties, dedupe.
    # Two columns → per-person values; one column → the dialog's constant
    # ("everyone in this list gets X").
    if len(cols) >= 2:
        # One value per person: on in-file duplicates, keep max() —
        # deterministic, and dup ids in a scalar file are a data smell
        # rather than a supported feature.
        conn.execute(
            f"""
            CREATE OR REPLACE TEMP TABLE _rows AS
            SELECT trim({id_col}) AS external_id, ? AS label,
                max(trim(CAST("{cols[1]}" AS VARCHAR))) AS value
            FROM _upload
            WHERE trim({id_col}) <> '' AND trim(CAST("{cols[1]}" AS VARCHAR)) <> ''
            GROUP BY trim({id_col})
            """,
            [label],
        )
    else:
        value = value.strip() if value else None
        if not value:
            raise ValueError("A one-column file needs a value, which will applied to everyone in the list.")
        conn.execute(
            f"""
            CREATE OR REPLACE TEMP TABLE _rows AS
            SELECT DISTINCT trim({id_col}) AS external_id, ? AS label, ? AS value
            FROM _upload WHERE trim({id_col}) <> ''
            """,
            [label, value],
        )
    row = conn.execute("SELECT count(*) FROM _rows").fetchone()
    row_count = row[0] if row else 0
    if row_count == 0:
        raise ValueError("No usable rows in the uploaded file.")
    # Two-column rows with an id but a blank value are ignored entirely
    # (no write, prior values survive) — counted so the dialog can say so.
    skipped_count = 0
    if len(cols) == 2:
        # Blank CSV cells arrive as NULL (not '') — count both shapes.
        skipped = conn.execute(
            f"""SELECT count(*) FROM _upload
            WHERE trim({id_col}) <> ''
                AND ("{cols[1]}" IS NULL OR trim(CAST("{cols[1]}" AS VARCHAR)) = '')"""
        ).fetchone()
        skipped_count = skipped[0] if skipped else 0

    # Typed values are validated at ingest — fail loudly with an example
    # rather than storing values that silently never match at query time
    # (query-side try_cast is the same arbiter: plain or scientific
    # notation for numbers, ISO YYYY-MM-DD for dates).
    if field_type in ("number", "date"):
        cast = "DOUBLE" if field_type == "number" else "DATE"
        bad = conn.execute(
            f"SELECT count(*), any_value(value) FROM _rows WHERE try_cast(value AS {cast}) IS NULL"
        ).fetchone()
        if bad and bad[0] > 0:
            kind = "numbers" if field_type == "number" else "dates (expected YYYY-MM-DD)"
            raise ValueError(f'{bad[0]} of {row_count} values aren\'t {kind} — e.g. "{bad[1]}".')

    if field_type == "enum":
        distinct = conn.execute("SELECT count(DISTINCT value) FROM _rows").fetchone()[0]
        if distinct > _ENUM_VALUES_CAP:
            raise ValueError(
                f"{distinct} distinct values is too many for a Category field "
                f"(max {_ENUM_VALUES_CAP}). Use Code to match whole values "
                f"(like districts), or Text to search within them (like names)."
            )

    return label, row_count, skipped_count


def append_custom_fields(
    conn: duckdb.DuckDBPyConnection,
    *,
    dataset_id: str,
    dataset_slug: str,
    upload_id: str,
    source: str,
    field_type: str,
    label: str | None,
    value: str | None,
) -> dict[str, Any]:
    """One synchronous append: parse the file at `source`, upsert the registry,
    write values into the lake (latest wins), sync coverage/enum options, and
    return `{fields, rowCount, skippedCount, matchedCount}` for the dialog.
    Raises ValueError with a user-facing message on any parse/validation
    failure — nothing is written in that case."""
    attach_operational_postgres(conn, get_settings())
    label, row_count, skipped_count = parse_upload(conn, source, field_type, label, value)

    _upsert_registry(conn, dataset_id, field_type)
    conn.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE _rows_ids AS
        SELECT r.external_id, f.custom_field_id::VARCHAR AS field_id, r.value
        FROM _rows r
        JOIN {OPERATIONAL_PG_ALIAS}.app.custom_fields f
            ON f.label = r.label AND f.dataset_id = ?::UUID
        """,
        [dataset_id],
    )
    matched_count = _matched_count(conn, dataset_slug)

    ensure_custom_fields_table(conn, dataset_slug)
    # The table now exists — drop any cached "no values table" miss.
    _values_table_cache.pop(dataset_slug, None)
    values_table = custom_fields_fqn(dataset_slug)
    conn.execute("BEGIN TRANSACTION")
    try:
        # Latest wins: replace the listed people's values for this field.
        conn.execute(
            f"""
            DELETE FROM {values_table}
            WHERE field_id IN (SELECT DISTINCT field_id FROM _rows_ids)
                AND external_id IN (SELECT external_id FROM _rows_ids)
            """
        )
        conn.execute(
            f"INSERT INTO {values_table} SELECT external_id, field_id, value, ? FROM _rows_ids",
            [upload_id],
        )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise

    sync_registry(conn, dataset_slug)
    labels = [r[0] for r in conn.execute("SELECT DISTINCT label FROM _rows ORDER BY label").fetchall()]
    # The label is for the dialog's success message; the id keys the
    # provenance row (labels are display-only and renameable).
    field_id = conn.execute("SELECT DISTINCT field_id FROM _rows_ids").fetchone()
    return {
        "fields": labels,
        "customFieldId": field_id[0] if field_id else None,
        "rowCount": row_count,
        "skippedCount": skipped_count,
        "matchedCount": matched_count,
    }


def _upsert_registry(conn: duckdb.DuckDBPyConnection, dataset_id: str, field_type: str) -> None:
    """Ensure a registry row per label in `_rows`: insert missing (typed),
    revive archived, and reject type conflicts — a label can't be a number in
    one upload and a date in the next."""
    conflict = conn.execute(
        f"""
        SELECT f.label, f.field_type, f.archived_at IS NOT NULL
        FROM {OPERATIONAL_PG_ALIAS}.app.custom_fields f
        WHERE f.dataset_id = ?::UUID AND f.field_type <> ?
            AND f.label IN (SELECT DISTINCT label FROM _rows)
        LIMIT 1
        """,
        [dataset_id, field_type],
    ).fetchone()
    if conflict is not None:
        label, existing_type, archived = conflict
        kind = f"{'an archived' if archived else 'a'} {_TYPE_LABELS.get(existing_type, existing_type)}"
        raise ValueError(
            f'Field "{label}" already exists as {kind} field. Rename that field to use this name for a different type.'
        )
    conn.execute(
        f"""
        INSERT INTO {OPERATIONAL_PG_ALIAS}.app.custom_fields (custom_field_id, dataset_id, label, field_type)
        SELECT uuid(), ?::UUID, label, ? FROM (SELECT DISTINCT label FROM _rows)
        WHERE label NOT IN (
            SELECT label FROM {OPERATIONAL_PG_ALIAS}.app.custom_fields WHERE dataset_id = ?::UUID
        )
        """,
        [dataset_id, field_type, dataset_id],
    )
    conn.execute(
        f"""
        UPDATE {OPERATIONAL_PG_ALIAS}.app.custom_fields SET archived_at = NULL
        WHERE dataset_id = ?::UUID AND archived_at IS NOT NULL
            AND label IN (SELECT DISTINCT label FROM _rows)
        """,
        [dataset_id],
    )


def _matched_count(conn: duckdb.DuckDBPyConnection, dataset_slug: str) -> int | None:
    """Distinct uploaded ids present in the dataset's latest ready version, or
    None when the dataset has no ready version yet. Informational — unmatched
    ids are kept; they may match a later version."""
    row = conn.execute(
        f"""
        SELECT max(v.version_number)
        FROM {OPERATIONAL_PG_ALIAS}.app.dataset_versions v
        JOIN {OPERATIONAL_PG_ALIAS}.app.datasets d ON d.dataset_id = v.dataset_id
        WHERE d.slug = ? AND v.status = 'ready'
        """,
        [dataset_slug],
    ).fetchone()
    if row is None or row[0] is None:
        return None
    persons = table_fqn(dataset_version_schema(dataset_slug, row[0]), "persons_geocoded")
    matched = conn.execute(
        f"""
        SELECT count(DISTINCT r.external_id) FROM _rows r
        WHERE r.external_id IN (SELECT external_id FROM {persons})
        """
    ).fetchone()
    return matched[0] if matched else 0
