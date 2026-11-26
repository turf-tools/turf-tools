"""Write the Florida sample: invented voters in the extract's exact byte format.

- `detail.zip` — `DAD_20260101.txt` and `BRO_20260101.txt`: headerless,
  tab-delimited, CRLF, addresses padded the way the state pads them.
- `history.zip` — `DAD_H_20260101.txt` and `BRO_H_20260101.txt`.

Each person exists to exercise something the import handles; the comment beside
it says what. `write_registration_zip` and `write_history_zip` are also used by
tests that need a variation.

Run from apps/data/ after editing the rows:

    uv run python -m src.importers.fl_voter_file.sample_data.make_sample
"""

from __future__ import annotations

import zipfile
from collections import defaultdict
from pathlib import Path

from src.importers.fl_voter_file.decode import HISTORY_LAYOUT, REGISTRATION_LAYOUT

HERE = Path(__file__).parent
STAMP = "20260101"

# Values for every person unless the row overrides them. Keys are layout names.
DEFAULTS: dict[str, str] = {
    "County Code": "DAD",
    "Requested public records exemption": "N",
    "Residence City (USPS)": "Miami",
    "Residence State": "  ",
    "Residence Zipcode": "33139",
    "Gender": "F",
    "Race": "4",
    "Birth Date": "01/15/1980",
    "Registration Date": "09/15/2008",
    "Party Affiliation": "DEM",
    "Precinct": "033",
    "Precinct Group": "0",
    "Precinct Split": "033.0",
    "Voter Status": "ACT",
    "Congressional District": "25",
    "House District": "106",
    "Senate District": "36",
    "County Commission District": "5",
    "School Board District": "3",
}

# (layout field → value) overrides, one dict per person. Voter IDs are assigned
# from the row's position.
PEOPLE: list[dict[str, str]] = [
    # Padded line 1 (two spaces before the direction, trailing space), unit in line 2.
    {
        "Name Last": "Tester",
        "Name First": "Avery",
        "Residence Address Line 1": "1724  NW 38Th St ",
        "Residence Address Line 2": "APT 201",
    },
    # Half house number; Republican; male; phone with area code; email.
    {
        "Name Last": "Sample",
        "Name First": "Blake",
        "Name Middle": "Q",
        "Residence Address Line 1": "2215 1/2 NE 123Rd ST ",
        "Party Affiliation": "REP",
        "Gender": "M",
        "Daytime Area Code": "305",
        "Daytime Phone Number": "5551234",
        "Email address": "Blake.Sample@Example.com",
    },
    # Three spaces where the direction would be; no party; inactive.
    {
        "Name Last": "Placeholder",
        "Name First": "Casey",
        "Residence Address Line 1": "2001   Biscayne BLVD ",
        "Residence Address Line 2": "APT 3601",
        "Party Affiliation": "NPA",
        "Voter Status": "INA",
    },
    # Stray quote in a name (quoting is off); phone without an area code → no phone.
    {
        "Name Last": 'O"Example',
        "Name First": "Drew",
        "Residence Address Line 1": "45  SW 8Th St ",
        "Daytime Phone Number": "5550000",
    },
    # Minor party → other; suffix; Black.
    {
        "Name Last": "Fakerson",
        "Name First": "Ellis",
        "Name Suffix": "JR",
        "Residence Address Line 1": "300   Ocean DR ",
        "Party Affiliation": "AMF",
        "Race": "3",
        "Gender": "M",
    },
    # Independent Party of Florida (not "no party"); split precinct in another CD.
    {
        "Name Last": "Mockley",
        "Name First": "Finley",
        "Residence Address Line 1": "77  NE 2Nd AVE ",
        "Party Affiliation": "IND",
        "Precinct": "116",
        "Precinct Split": "116.1",
        "Congressional District": "24",
        "House District": "107",
        "Senate District": "34",
        "County Commission District": "4",
    },
    # ZIP+4 run together; ZIP not shared with anyone else.
    {
        "Name Last": "Dummy",
        "Name First": "Gray",
        "Residence Address Line 1": "9141  SW 122Nd AVE ",
        "Residence Zipcode": "331724778",
        "Precinct": "488",
        "Precinct Split": "488.0",
        "Congressional District": "28",
        "House District": "116",
        "Senate District": "39",
        "County Commission District": "12",
        "School Board District": "5",
    },
    # Malformed birth date → NULL date_of_birth; unknown gender; Libertarian.
    {
        "Name Last": "Baddate",
        "Name First": "Harper",
        "Residence Address Line 1": "140  NW 7Th ST ",
        "Birth Date": "13/45/1980",
        "Gender": "U",
        "Party Affiliation": "LPF",
    },
    # Broward: same precinct number as a Miami-Dade voter, different precinct.
    {
        "County Code": "BRO",
        "Name Last": "Surname",
        "Name First": "Ivy",
        "Residence Address Line 1": "600  SE 3Rd AVE ",
        "Residence City (USPS)": "FORT LAUDERDALE",
        "Residence Zipcode": "33301",
        "Precinct": "033",
        "Precinct Split": "033.0",
        "Congressional District": "23",
        "House District": "99",
        "Senate District": "32",
        "County Commission District": "8",
        "School Board District": "4",
        "Party Affiliation": "GRE",
        "Race": "5",
    },
    # Broward; Conservative; never voted.
    {
        "County Code": "BRO",
        "Name Last": "Novote",
        "Name First": "Jules",
        "Residence Address Line 1": "1  E Las Olas BLVD ",
        "Residence City (USPS)": "FORT LAUDERDALE",
        "Residence Zipcode": "33301",
        "Precinct": "041",
        "Precinct Split": "041.0",
        "Congressional District": "23",
        "House District": "99",
        "Senate District": "32",
        "County Commission District": "8",
        "School Board District": "4",
        "Party Affiliation": "CSV",
        "Race": "9",
    },
    # Requested a public-records exemption: protected fields are `*`; dropped.
    {
        "Requested public records exemption": "Y",
        **{
            field: "*"
            for field in REGISTRATION_LAYOUT[2:6]
            + REGISTRATION_LAYOUT[7:19]
            + ["Birth Date", "Precinct", "Precinct Group", "Precinct Split", "Precinct Suffix"]
            + REGISTRATION_LAYOUT[29:38]
        },
    },
]

# Voter ID → history rows (date, type, code). Voter IDs are 100000001 upward,
# in PEOPLE order.
HISTORY: dict[int, list[tuple[str, str, str]]] = {
    # Every counted method; a presidential primary; a local election (OTH).
    1: [
        ("11/05/2024", "GEN", "Y"),
        ("08/20/2024", "PRI", "E"),
        ("03/19/2024", "PPP", "A"),
        ("11/07/2023", "OTH", "Y"),
    ],
    # Two counted codes for one election → one entry, polls first.
    2: [("11/05/2024", "GEN", "A"), ("11/05/2024", "GEN", "Y"), ("11/08/2022", "GEN", "E")],
    # Ballots that didn't count (B, L, P) and "did not vote" (N) aren't votes.
    3: [("11/05/2024", "GEN", "B"), ("08/20/2024", "PRI", "L"), ("11/08/2022", "GEN", "P"), ("08/23/2022", "PRI", "N")],
    # A runoff; an exact duplicate row.
    4: [("06/02/2026", "RUN", "Y"), ("06/02/2026", "RUN", "Y"), ("11/05/2024", "GEN", "Y")],
    # History recorded under a previous county (BRO) for a Miami-Dade voter.
    5: [("11/08/2022", "GEN", "Y")],
    # Special elections coded GEN and PRI off the regular dates: a March
    # general in an even year, an odd-year primary, an odd-year general.
    6: [("11/05/2024", "GEN", "E"), ("03/24/2026", "GEN", "Y")],
    7: [("11/05/2024", "GEN", "A"), ("01/28/2025", "PRI", "E"), ("04/01/2025", "GEN", "Y")],
    8: [("11/05/2024", "GEN", "Y")],
    9: [("11/05/2024", "GEN", "Y"), ("08/20/2024", "PRI", "Y")],
    # A voter ID no longer on the rolls: ignored.
    99: [("11/05/2024", "GEN", "Y")],
}

# Voters whose history the file lists under a county other than their current one.
HISTORY_COUNTY: dict[int, str] = {5: "BRO"}


def voter_id(index: int) -> str:
    return str(100000000 + index)


def registration_rows(people: list[dict[str, str]]) -> dict[str, list[list[str]]]:
    """County code → rows in layout order."""
    by_county: dict[str, list[list[str]]] = defaultdict(list)
    for i, overrides in enumerate(people, start=1):
        person = {**DEFAULTS, **overrides, "Voter ID": voter_id(i)}
        by_county[person["County Code"]].append([person.get(field, "") for field in REGISTRATION_LAYOUT])
    return by_county


History = dict[int, list[tuple[str, str, str]]]


def history_rows(people: list[dict[str, str]], history: History) -> dict[str, list[list[str]]]:
    """County code → history rows in layout order."""
    counties = {i: {**DEFAULTS, **p}["County Code"] for i, p in enumerate(people, start=1)}
    by_county: dict[str, list[list[str]]] = defaultdict(list)
    for index, entries in history.items():
        county = HISTORY_COUNTY.get(index, counties.get(index, "DAD"))
        for date, kind, code in entries:
            by_county[county].append([county, voter_id(index), date, kind, code])
    return by_county


def _write_zip(path: Path, members: dict[str, list[list[str]]]) -> None:
    with zipfile.ZipFile(path, "w") as zf:
        for name, rows in sorted(members.items()):
            # A fixed timestamp keeps regenerated zips byte-identical.
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, "".join("\t".join(row) + "\r\n" for row in rows).encode("ascii"))


def write_registration_zip(path: Path, people: list[dict[str, str]]) -> None:
    rows = registration_rows(people)
    _write_zip(path, {f"{county}_{STAMP}.txt": r for county, r in rows.items()})


def write_history_zip(path: Path, people: list[dict[str, str]], history: History) -> None:
    rows = history_rows(people, history)
    assert all(len(r) == len(HISTORY_LAYOUT) for county_rows in rows.values() for r in county_rows)
    _write_zip(path, {f"{county}_H_{STAMP}.txt": r for county, r in rows.items()})


def main() -> None:
    write_registration_zip(HERE / "detail.zip", PEOPLE)
    write_history_zip(HERE / "history.zip", PEOPLE, HISTORY)
    print(f"Wrote {len(PEOPLE)} people to detail.zip and history.zip in {HERE}")


if __name__ == "__main__":
    main()
