"""Write the NYS samples: the same invented people in each accepted format.

- `file.txt` — the raw NYSVOTER export's exact byte format: headerless, every
  field quoted, CRLF line endings, Latin-1, street names padded inside their
  quotes, `PREVCOUNTY` sometimes two spaces.
- `file.csv` — a spreadsheet-style export: UTF-8 with a BOM, a header row of
  the layout's field names as the layout spells them, minimal quoting, CRLF.
- `file.parquet` — lowercase layout names, text columns, blanks as NULL.

The tabular files hold what a converted export would: the C1 garbage the raw
decode drops is already gone. Each person exists to exercise something the
import handles; the comment beside it says what.

Run from apps/data/ after editing the rows:

    uv run python -m src.importers.nys_voter_file.sample_data.make_sample
"""

from __future__ import annotations

import csv
from pathlib import Path

import duckdb
from src.importers.nys_voter_file.decode import LAYOUT
from src.importers.streams import C1_STRIP_TABLE

HERE = Path(__file__).parent

# Values for every person unless the row overrides them. Keys are layout names.
DEFAULTS: dict[str, str] = {
    "RCITY": "NEW YORK",
    "RZIP5": "10009",
    "DOB": "19800115",
    "GENDER": "F",
    "ENROLLMENT": "DEM",
    "COUNTYCODE": "31",
    "ED": "39",
    "LD": "",
    "TOWNCITY": "NEW YORK",
    "CD": "12",
    "SD": "27",
    "AD": "65",
    "LASTVOTERDATE": "20241105",
    "PREVCOUNTY": "  ",
    "REGDATE": "20080915",
    "VRSOURCE": "MAIL",
    "IDREQUIRED": "N",
    "IDMET": "Y",
    "STATUS": "A",
    "VoterHistory": "20241105 GE(P);20240625 PR(E);20221108 GE(P)",
}

# (layout field → value) overrides, one dict per person. SBOEID and COUNTYVRNUMBER
# are assigned from the row's position.
PEOPLE: list[dict[str, str]] = [
    # Apartment with type, ZIP+4.
    {
        "LASTNAME": "TESTER",
        "FIRSTNAME": "AVERY",
        "RADDNUMBER": "120",
        "RSTREETNAME": "AVENUE B",
        "RAPARTMENTTYPE": "APT",
        "RAPARTMENT": "4B",
        "RZIP4": "1234",
    },
    # Half code + pre-direction; Republican; male.
    {
        "LASTNAME": "SAMPLE",
        "FIRSTNAME": "BLAKE",
        "MIDDLENAME": "Q",
        "RADDNUMBER": "211",
        "RHALFCODE": "1/2",
        "RPREDIRECTION": "E",
        "RSTREETNAME": "7 ST",
        "ENROLLMENT": "REP",
        "GENDER": "M",
    },
    # Latin-1 accented names.
    {
        "LASTNAME": "MUÑOZ",
        "FIRSTNAME": "JOSÉ",
        "RADDNUMBER": "45",
        "RSTREETNAME": "CLINTON ST",
        "RZIP5": "10002",
        "GENDER": "M",
    },
    # Green (OTH + GRE).
    {
        "LASTNAME": "PLACEHOLDER",
        "FIRSTNAME": "CASEY",
        "RADDNUMBER": "300",
        "RSTREETNAME": "E 10 ST",
        "ENROLLMENT": "OTH",
        "OTHERPARTY": "GRE",
    },
    # Independence, both spellings of the code.
    {
        "LASTNAME": "EXAMPLE",
        "FIRSTNAME": "DREW",
        "RADDNUMBER": "18",
        "RSTREETNAME": "ST MARKS PL",
        "ENROLLMENT": "OTH",
        "OTHERPARTY": "IND",
    },
    {
        "LASTNAME": "EXAMPLE",
        "FIRSTNAME": "ELLIS",
        "RADDNUMBER": "18",
        "RSTREETNAME": "ST MARKS PL",
        "ENROLLMENT": "OTH",
        "OTHERPARTY": "Ind",
    },
    # Unlisted minor party → other.
    {
        "LASTNAME": "FAKERSON",
        "FIRSTNAME": "FINLEY",
        "RADDNUMBER": "77",
        "RSTREETNAME": "AVENUE A",
        "ENROLLMENT": "OTH",
        "OTHERPARTY": "XYZ",
    },
    # Unaffiliated, inactive.
    {
        "LASTNAME": "MOCKLEY",
        "FIRSTNAME": "GRAY",
        "RADDNUMBER": "500",
        "RSTREETNAME": "E 14 ST",
        "ENROLLMENT": "BLK",
        "STATUS": "I",
        "LASTVOTERDATE": "20161108",
        "VoterHistory": "20161108 GE(A)",
    },
    # Conservative, federal-only.
    {
        "LASTNAME": "DUMMY",
        "FIRSTNAME": "HARPER",
        "RADDNUMBER": "9",
        "RSTREETNAME": "BOWERY",
        "RZIP5": "10003",
        "ENROLLMENT": "CON",
        "STATUS": "AF",
    },
    # Working Families, preregistered: never voted, no history.
    {
        "LASTNAME": "NOVOTE",
        "FIRSTNAME": "IVY",
        "RADDNUMBER": "61",
        "RSTREETNAME": "AVENUE C",
        "DOB": "20090301",
        "ENROLLMENT": "WOR",
        "STATUS": "17",
        "LASTVOTERDATE": "",
        "REGDATE": "20250410",
        "VoterHistory": "",
    },
    # Purged → dropped on read.
    {"LASTNAME": "PURGED", "FIRSTNAME": "JULES", "RADDNUMBER": "88", "RSTREETNAME": "E 4 ST", "STATUS": "P"},
    # Status outside the map → unknown.
    {"LASTNAME": "UNMAPPED", "FIRSTNAME": "ROWAN", "RADDNUMBER": "90", "RSTREETNAME": "E 4 ST", "STATUS": "AU"},
    # Malformed (7-digit) birth date → NULL date_of_birth.
    {"LASTNAME": "BADDATE", "FIRSTNAME": "KAI", "RADDNUMBER": "140", "RSTREETNAME": "AVENUE B", "DOB": "1980013"},
    # Suffix, blank middle.
    {
        "LASTNAME": "SURNAME",
        "FIRSTNAME": "LANE",
        "NAMESUFFIX": "JR",
        "RADDNUMBER": "230",
        "RSTREETNAME": "E 9 ST",
        "GENDER": "M",
    },
    # Post-direction.
    {
        "LASTNAME": "PLACEMENT",
        "FIRSTNAME": "MORGAN",
        "RADDNUMBER": "1",
        "RSTREETNAME": "WASHINGTON SQ",
        "RPOSTDIRECTION": "N",
        "RZIP5": "10003",
    },
    # Apostrophe in the name; doubled quote in a free-form field.
    {
        "LASTNAME": "O'TESTER",
        "FIRSTNAME": "NOEL",
        "RADDNUMBER": "52",
        "RSTREETNAME": "AVENUE A",
        "PREVNAME": 'NOEL "NOLLY" TESTER',
    },
    # Stray C1 control byte in a legacy field (dropped by the decode).
    {
        "LASTNAME": "CONTROLBYTE",
        "FIRSTNAME": "OAKLEY",
        "RADDNUMBER": "64",
        "RSTREETNAME": "E 3 ST",
        "PREVADDRESS": "12 OLD\x85 RD",
    },
    # Apartment type without an apartment → no address_line_2.
    {"LASTNAME": "NOUNIT", "FIRSTNAME": "PAT", "RADDNUMBER": "33", "RSTREETNAME": "AVENUE D", "RAPARTMENTTYPE": "APT"},
    # Legacy voting-history formats: code-first, description + year, comma variant.
    {
        "LASTNAME": "OLDTIMER",
        "FIRSTNAME": "QUINN",
        "RADDNUMBER": "410",
        "RSTREETNAME": "E 6 ST",
        "DOB": "19400704",
        "REGDATE": "19700101",
        "VoterHistory": "GE 20201103(A);General Election 2004(P);General Election, 2003(P);20221108 GE(F)",
    },
    # Single-digit election district → zero-padded precinct; Brooklyn, CD 7.
    {
        "LASTNAME": "BROOKLYNITE",
        "FIRSTNAME": "REESE",
        "RADDNUMBER": "99",
        "RSTREETNAME": "BEDFORD AVE",
        "RCITY": "BROOKLYN",
        "RZIP5": "11211",
        "COUNTYCODE": "24",
        "TOWNCITY": "BROOKLYN",
        "ED": "7",
        "AD": "50",
        "SD": "59",
        "CD": "7",
    },
    {
        "LASTNAME": "BROOKLYNITE",
        "FIRSTNAME": "SAGE",
        "RADDNUMBER": "99",
        "RSTREETNAME": "BEDFORD AVE",
        "RAPARTMENT": "2",
        "RCITY": "BROOKLYN",
        "RZIP5": "11211",
        "COUNTYCODE": "24",
        "TOWNCITY": "BROOKLYN",
        "ED": "7",
        "AD": "50",
        "SD": "59",
        "CD": "7",
    },
    # Queens, CD 14: the import filter's other slice.
    {
        "LASTNAME": "QUEENSIDE",
        "FIRSTNAME": "TATUM",
        "RADDNUMBER": "31-15",
        "RSTREETNAME": "STEINWAY ST",
        "RCITY": "ASTORIA",
        "RZIP5": "11103",
        "COUNTYCODE": "41",
        "TOWNCITY": "QUEENS",
        "ED": "53",
        "AD": "36",
        "SD": "12",
        "CD": "14",
    },
    {
        "LASTNAME": "QUEENSIDE",
        "FIRSTNAME": "UMA",
        "RADDNUMBER": "31-15",
        "RSTREETNAME": "STEINWAY ST",
        "RAPARTMENTTYPE": "FL",
        "RAPARTMENT": "3",
        "RCITY": "ASTORIA",
        "RZIP5": "11103",
        "COUNTYCODE": "41",
        "TOWNCITY": "QUEENS",
        "ED": "53",
        "AD": "36",
        "SD": "12",
        "CD": "14",
        "GENDER": "X",
    },
    # Unknown gender code passes through.
    {"LASTNAME": "GENERIC", "FIRSTNAME": "VAL", "RADDNUMBER": "205", "RSTREETNAME": "AVENUE B", "GENDER": "U"},
    # Plain records filling out the Manhattan slice.
    {"LASTNAME": "ORDINARY", "FIRSTNAME": "WREN", "RADDNUMBER": "150", "RSTREETNAME": "E 2 ST"},
    {
        "LASTNAME": "ORDINARY",
        "FIRSTNAME": "XEN",
        "RADDNUMBER": "150",
        "RSTREETNAME": "E 2 ST",
        "RAPARTMENTTYPE": "APT",
        "RAPARTMENT": "1F",
    },
]

# Width the real file pads street names to, inside their quotes.
_STREET_PAD = 28


def _field(layout: str, value: str) -> str:
    if layout == "RSTREETNAME" and value:
        value = value.ljust(_STREET_PAD)
    return '"' + value.replace('"', '""') + '"'


def _records() -> list[list[str]]:
    """Each person's 47 layout values, in layout order."""
    records = []
    for n, person in enumerate(PEOPLE, start=1):
        record = {**DEFAULTS, **person, "SBOEID": f"NY{n:018d}", "COUNTYVRNUMBER": f"{900000 + n}"}
        records.append([record.get(field, "") for field in LAYOUT])
    return records


def write_txt(records: list[list[str]]) -> None:
    lines = [",".join(_field(field, v) for field, v in zip(LAYOUT, r, strict=True)) for r in records]
    (HERE / "file.txt").write_bytes(("\r\n".join(lines) + "\r\n").encode("latin-1"))


def write_csv(records: list[list[str]]) -> None:
    with open(HERE / "file.csv", "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f, lineterminator="\r\n")
        writer.writerow(LAYOUT)
        writer.writerows([v.translate(C1_STRIP_TABLE) for v in r] for r in records)


def write_parquet(records: list[list[str]]) -> None:
    names = [field.lower() for field in LAYOUT]
    conn = duckdb.connect()
    conn.execute(f"CREATE TABLE sample ({', '.join(f'{n} VARCHAR' for n in names)})")
    conn.executemany(
        f"INSERT INTO sample VALUES ({', '.join('?' for _ in names)})",
        [[v.translate(C1_STRIP_TABLE) or None for v in r] for r in records],
    )
    conn.execute(f"COPY sample TO '{HERE / 'file.parquet'}' (FORMAT parquet)")
    conn.close()


def main() -> None:
    records = _records()
    write_txt(records)
    write_csv(records)
    write_parquet(records)
    print(f"Wrote {len(records)} people to file.txt, file.csv, file.parquet in {HERE}")


if __name__ == "__main__":
    main()
