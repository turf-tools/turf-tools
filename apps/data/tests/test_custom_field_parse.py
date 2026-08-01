"""Fixture-CSV tests for custom-field upload parsing/validation
(`parse_upload`) — the contract the Append dialog relies on. Pure in-memory
DuckDB; each test writes a small CSV and asserts the parse or the error."""

import pytest

import duckdb
from src.custom_fields import parse_upload


@pytest.fixture
def conn():
    c = duckdb.connect(":memory:")
    yield c
    c.close()


def _csv(tmp_path, text: str) -> str:
    f = tmp_path / "upload.csv"
    f.write_text(text)
    return str(f)


def _values(conn) -> dict[str, str]:
    return dict(conn.execute("SELECT external_id, value FROM _rows").fetchall())


def test_two_column_derives_label_from_header(conn, tmp_path):
    src = _csv(tmp_path, "id,support_score\n1,0.5\n2,0.9\n")
    label, rows, skipped = parse_upload(conn, src, "number", None, None)
    assert (label, rows, skipped) == ("support_score", 2, 0)
    assert _values(conn) == {"1": "0.5", "2": "0.9"}


def test_one_column_uses_dialog_label_and_value(conn, tmp_path):
    src = _csv(tmp_path, "id\n1\n2\n2\n")
    label, rows, skipped = parse_upload(conn, src, "enum", "employer", "amazon")
    assert (label, rows, skipped) == ("employer", 2, 0)  # deduped
    assert _values(conn) == {"1": "amazon", "2": "amazon"}


def test_one_column_requires_label(conn, tmp_path):
    src = _csv(tmp_path, "id\n1\n")
    with pytest.raises(ValueError, match="needs a field name"):
        parse_upload(conn, src, "enum", None, "amazon")


def test_one_column_requires_value(conn, tmp_path):
    src = _csv(tmp_path, "id\n1\n")
    with pytest.raises(ValueError, match="needs a value"):
        parse_upload(conn, src, "enum", "employer", None)


def test_three_columns_rejected(conn, tmp_path):
    src = _csv(tmp_path, "id,a,b\n1,2,3\n")
    with pytest.raises(ValueError, match="must have one"):
        parse_upload(conn, src, "text", None, None)


def test_blank_values_skipped_and_counted(conn, tmp_path):
    # Blank cells arrive as NULL from read_csv; quoted empties as '' — both skip.
    src = _csv(tmp_path, 'id,score\n1,0.5\n2,\n3,""\n4,1.5\n')
    label, rows, skipped = parse_upload(conn, src, "number", None, None)
    assert (rows, skipped) == (2, 2)
    assert _values(conn) == {"1": "0.5", "4": "1.5"}


def test_all_blank_values_is_no_usable_rows(conn, tmp_path):
    src = _csv(tmp_path, "id,score\n1,\n2,\n")
    with pytest.raises(ValueError, match="No usable rows"):
        parse_upload(conn, src, "number", None, None)


def test_duplicate_ids_keep_one_value(conn, tmp_path):
    src = _csv(tmp_path, "id,score\n1,2\n1,9\n")
    label, rows, skipped = parse_upload(conn, src, "number", None, None)
    assert rows == 1
    assert _values(conn) == {"1": "9"}  # max() — deterministic


def test_number_validation_fails_with_example(conn, tmp_path):
    src = _csv(tmp_path, "id,score\n1,0.5\n2,N/A\n3,1;2\n")
    with pytest.raises(ValueError, match=r"2 of 3 values aren't numbers"):
        parse_upload(conn, src, "number", None, None)


def test_number_accepts_scientific_rejects_commas(conn, tmp_path):
    ok = _csv(tmp_path, "id,score\n1,1e5\n2,-0.87\n")
    label, rows, _ = parse_upload(conn, ok, "number", None, None)
    assert rows == 2
    bad = tmp_path / "bad.csv"
    bad.write_text('id,score\n1,"1,234"\n')
    with pytest.raises(ValueError, match="aren't numbers"):
        parse_upload(conn, str(bad), "number", None, None)


def test_date_validation_iso_only(conn, tmp_path):
    ok = _csv(tmp_path, "id,canvassed\n1,2026-06-29\n")
    label, rows, _ = parse_upload(conn, ok, "date", None, None)
    assert rows == 1
    bad = tmp_path / "bad.csv"
    bad.write_text("id,canvassed\n1,06/29/2026\n")
    with pytest.raises(ValueError, match="aren't dates"):
        parse_upload(conn, str(bad), "date", None, None)


def test_enum_distinct_cap(conn, tmp_path):
    lines = "id,tag\n" + "\n".join(f"{i},v{i}" for i in range(101))
    src = _csv(tmp_path, lines + "\n")
    with pytest.raises(ValueError, match="too many"):
        parse_upload(conn, src, "enum", None, None)


def test_distinct_cap_is_category_only(conn, tmp_path):
    # The cap exists because Category builds a picker. Code has no picker, so
    # a large code set (statewide precincts, VAN ids) must go straight through
    # — it's the escalation the cap's error message points at.
    lines = "id,precinct\n" + "\n".join(f"{i},{i:05d}" for i in range(5000))
    src = _csv(tmp_path, lines + "\n")
    label, rows, skipped = parse_upload(conn, src, "text_multi", None, None)
    assert (label, rows, skipped) == ("precinct", 5000, 0)


def test_values_are_trimmed(conn, tmp_path):
    src = _csv(tmp_path, "id,employer\n 1 , amazon \n")
    parse_upload(conn, src, "enum", None, None)
    assert _values(conn) == {"1": "amazon"}


def test_leading_zero_ids_preserved(conn, tmp_path):
    src = _csv(tmp_path, "id,employer\n00123,amazon\n")
    parse_upload(conn, src, "enum", None, None)
    assert _values(conn) == {"00123": "amazon"}


def test_unknown_field_type_rejected(conn, tmp_path):
    src = _csv(tmp_path, "id\n1\n")
    with pytest.raises(ValueError, match="Unknown field type"):
        parse_upload(conn, src, "flag", "x", "y")


def test_numeric_value_column_header_allowed(conn, tmp_path):
    # Only the id column's name signals headerlessness — value columns may
    # legitimately be named "2024" etc.
    src = _csv(tmp_path, "id,2024\n1001,0.5\n")
    label, rows, _ = parse_upload(conn, src, "number", None, None)
    assert (label, rows) == ("2024", 1)


def test_parquet_upload_with_typed_columns(conn, tmp_path):
    # Parquet columns arrive typed (ints, doubles) — normalized through
    # VARCHAR so the value pipeline is format-agnostic.
    src = str(tmp_path / "u.parquet")
    conn.execute(f"COPY (SELECT * FROM (VALUES (101, 0.5), (102, 0.9)) t(id, score)) TO '{src}' (FORMAT parquet)")
    label, rows, skipped = parse_upload(conn, src, "number", None, None)
    assert (label, rows, skipped) == ("score", 2, 0)
    assert _values(conn) == {"101": "0.5", "102": "0.9"}
