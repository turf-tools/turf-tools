"""The NYS importer on its committed fake samples (`sample_data/`).

Pins the raw decode's fidelity, the transform's canonical values for the edge-case
people in the sample, the input shapes that have no committed sample of their own
(a headerless `.csv`, a source carrying only the required fields), header
detection, and the user-facing errors. That every committed format yields the
same people is the shared contract's check (`test_importers.py`).
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from src.importers.base import SourceUnreadableError
from src.importers.nys_voter_file import NysVoterFileImporter
from src.importers.nys_voter_file.decode import COLUMNS, LAYOUT, REQUIRED_COLUMNS, csv_has_header, source_format
from src.tables import table_fqn

SAMPLE_DATA = Path(__file__).parent.parent / "src/importers/nys_voter_file/sample_data"
SAMPLE = SAMPLE_DATA / "sample.txt"
SCHEMA = "nys_voter_file_v1"
RAW = table_fqn(SCHEMA, "persons_raw")
VALIDATED = table_fqn(SCHEMA, "persons_validated")


class _Progress:
    def advance(self, n: int = 1) -> None:
        pass


def _load(conn, source: Path | str) -> None:
    NysVoterFileImporter().load({"file": str(source)}, SCHEMA, conn, _Progress())


def _rows(conn, table: str, key: str) -> dict[str, dict]:
    rel = conn.table(table)
    return {row[key]: row for row in (dict(zip(rel.columns, r, strict=True)) for r in rel.fetchall())}


def _people(conn) -> dict[str, dict]:
    """persons_validated keyed by first name (unique in the sample)."""
    return _rows(conn, VALIDATED, "first_name")


def _write_variant(conn, path: Path, select: str) -> None:
    """Write the decoded sample back out as a tabular file, columns per `select`."""
    fmt = "(FORMAT csv, HEADER true)" if path.suffix == ".csv" else "(FORMAT parquet)"
    conn.execute(f"COPY (SELECT {select} FROM {RAW}) TO '{path}' {fmt}")


def _layout_select(only: frozenset[str]) -> str:
    return ", ".join(f'{column} AS "{field}"' for field, column in zip(LAYOUT, COLUMNS, strict=True) if column in only)


# --- raw decode -----------------------------------------------------------------


def test_raw_decode_is_faithful(conn) -> None:
    _load(conn, SAMPLE)
    raw = _rows(conn, RAW, "firstname")

    assert len(raw) == 25
    assert raw["JOSÉ"]["lastname"] == "MUÑOZ"  # Latin-1 → UTF-8
    assert raw["AVERY"]["rstreetname"] == "AVENUE B"  # padding inside the quotes trimmed
    assert raw["AVERY"]["prevcounty"] is None  # whitespace-only → NULL
    assert raw["AVERY"]["middlename"] is None  # blank → NULL
    assert raw["AVERY"]["sboeid"] == "NY000000000000000001"
    assert raw["NOEL"]["prevname"] == 'NOEL "NOLLY" TESTER'  # doubled quote unescaped
    assert raw["OAKLEY"]["prevaddress"] == "12 OLD RD"  # C1 control byte dropped
    assert raw["KAI"]["dob"] == "1980013"  # codes and dates left as-is


# --- transform ------------------------------------------------------------------


def test_transform_canonicalizes_the_sample(conn) -> None:
    _load(conn, SAMPLE)
    people = _people(conn)

    assert people["AVERY"]["external_id"] == "NY000000000000000001"
    assert people["AVERY"]["external_id_type"] == "ny_sboe"
    assert people["AVERY"]["address_line_1"] == "120 AVENUE B"
    assert people["AVERY"]["address_line_2"] == "APT 4B"
    assert people["AVERY"]["zip4"] == "1234"
    assert people["AVERY"]["state"] == "NY"
    assert people["BLAKE"]["address_line_1"] == "211 E 7 ST"
    assert people["BLAKE"]["half_code"] == "1/2"
    assert people["MORGAN"]["address_line_1"] == "1 WASHINGTON SQ N"
    assert people["PAT"]["address_line_2"] is None  # apartment type without an apartment
    assert people["SAGE"]["address_line_2"] == "2"
    assert people["REESE"]["precinct"] == "50-007"
    assert people["AVERY"]["precinct"] == "65-039"

    enrollment = {
        "AVERY": "democratic",
        "BLAKE": "republican",
        "CASEY": "green",
        "DREW": "independence",
        "ELLIS": "independence",
        "FINLEY": "other",
        "GRAY": "unaffiliated",
        "HARPER": "conservative",
        "IVY": "working_families",
    }
    assert {name: people[name]["enrollment"] for name in enrollment} == enrollment
    assert people["AVERY"]["registration_status"] == "active"
    assert people["GRAY"]["registration_status"] == "inactive"
    assert people["HARPER"]["registration_status"] == "federal_only"
    assert people["IVY"]["registration_status"] == "preregistered"
    assert people["JULES"]["registration_status"] == "unknown"

    assert people["AVERY"]["date_of_birth"] == "1980-01-15"
    assert people["KAI"]["date_of_birth"] is None
    assert people["IVY"]["last_voted_date"] is None


def test_voting_history_is_parsed(conn) -> None:
    _load(conn, SAMPLE)
    people = _people(conn)

    assert people["IVY"]["voting_history"] == []
    assert [(e["year"], e["type"], e["method"]) for e in people["QUINN"]["voting_history"]] == [
        (2020, "general", "absentee"),
        (2004, "general", "poll_site"),
        (2003, "general", "poll_site"),
        (2022, "general", "affidavit"),
    ]


# --- accepted input shapes ------------------------------------------------------


def test_headerless_csv_reads_as_the_raw_layout(conn, tmp_path) -> None:
    _load(conn, SAMPLE)
    expected = conn.sql(f"SELECT * FROM {VALIDATED} ORDER BY external_id").fetchall()

    headerless = tmp_path / "sample.csv"
    shutil.copy(SAMPLE, headerless)
    _load(conn, headerless)

    assert conn.sql(f"SELECT * FROM {VALIDATED} ORDER BY external_id").fetchall() == expected


def test_optional_layout_fields_may_be_left_out(conn, tmp_path) -> None:
    _load(conn, SAMPLE)
    expected = conn.sql(f"SELECT * FROM {VALIDATED} ORDER BY external_id").fetchall()

    required_only = tmp_path / "required-only.parquet"
    _write_variant(conn, required_only, _layout_select(only=REQUIRED_COLUMNS))
    _load(conn, required_only)

    assert conn.sql(f"SELECT * FROM {VALIDATED} ORDER BY external_id").fetchall() == expected


def test_numeric_codes_in_a_parquet_keep_their_leading_zeros(conn, tmp_path) -> None:
    """A parquet that stores codes as numbers reads back as the layout's text:
    the Bronx's `3` → `03`, ZIP+4 `123.0` → `0123`, ED `7.0` → `7`."""
    _load(conn, SAMPLE)
    numeric = tmp_path / "numeric.parquet"
    as_numbers = {"countycode": "3::INTEGER", "rzip4": "123::DOUBLE", "ed": "TRY_CAST(ed AS DOUBLE)"}
    _write_variant(
        conn,
        numeric,
        ", ".join(
            f'{as_numbers.get(column, column)} AS "{field}"' for field, column in zip(LAYOUT, COLUMNS, strict=True)
        ),
    )
    _load(conn, numeric)

    assert conn.sql(f"SELECT DISTINCT countycode, rzip4 FROM {RAW}").fetchall() == [("03", "0123")]
    assert {r[0] for r in conn.sql(f"SELECT DISTINCT ed FROM {RAW}").fetchall()} == {"39", "7", "53"}
    assert conn.sql(f"SELECT DISTINCT county_fips FROM {VALIDATED}").fetchall() == [("36005",)]


def test_latin1_csv_with_a_header_reads_like_utf8(conn, tmp_path) -> None:
    _load(conn, SAMPLE)
    expected = conn.sql(f"SELECT * FROM {VALIDATED} ORDER BY external_id").fetchall()

    utf8 = tmp_path / "utf8.csv"
    _write_variant(conn, utf8, _layout_select(only=frozenset(COLUMNS)))
    latin1 = tmp_path / "latin1.csv"
    latin1.write_bytes(utf8.read_text(encoding="utf-8").encode("latin-1"))
    _load(conn, latin1)

    assert conn.sql(f"SELECT * FROM {VALIDATED} ORDER BY external_id").fetchall() == expected


def test_csv_header_detection(tmp_path) -> None:
    assert csv_has_header(str(SAMPLE_DATA / "sample.csv"))  # BOM + the layout's own spelling

    lowercase = tmp_path / "lowercase.csv"
    lowercase.write_text(",".join(field.lower() for field in LAYOUT) + "\n", encoding="utf-8")
    assert csv_has_header(str(lowercase))

    # A voter whose surname happens to be a layout field name is still data.
    voter = tmp_path / "voter.csv"
    voter.write_bytes(SAMPLE.read_bytes().split(b"\r\n")[0].replace(b'"TESTER"', b'"WARD"', 1) + b"\r\n")
    assert not csv_has_header(str(voter))


def test_source_format_reads_the_extension_off_the_url_path() -> None:
    assert source_format("https://bucket.example.com/voters.TXT?X-Amz-Signature=abc") == "txt"
    assert source_format("s3://bucket/voters.parquet") == "parquet"
    assert source_format("/data/voters.csv") == "csv"
    assert source_format("/data/voters.xlsx") is None


# --- errors ---------------------------------------------------------------------


def test_unsupported_extension_is_rejected_before_the_source_is_read() -> None:
    with pytest.raises(SourceUnreadableError, match=r"expected \.txt, \.csv, or \.parquet"):
        _load(None, "/nope/voters.xlsx")


def test_unrelated_columns_are_rejected(conn, tmp_path) -> None:
    _load(conn, SAMPLE)
    unrelated = tmp_path / "unrelated.parquet"
    _write_variant(conn, unrelated, "firstname AS given, lastname AS family")

    with pytest.raises(SourceUnreadableError, match="None of the file's columns match"):
        _load(conn, unrelated)


def test_missing_required_fields_are_named(conn, tmp_path) -> None:
    _load(conn, SAMPLE)
    partial = tmp_path / "partial.csv"
    _write_variant(conn, partial, _layout_select(only=REQUIRED_COLUMNS - {"rzip5", "sboeid"}))

    with pytest.raises(SourceUnreadableError, match="missing NYSVOTER layout fields: RZIP5, SBOEID"):
        _load(conn, partial)
