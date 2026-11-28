"""Write the Georgia sample: invented voters + optional history.

`file.csv` — quoted CSV with the SOS voter-list header.
`history.csv` — mvp.sos.ga.gov-style history for a subset of those voters.

Run from apps/data/ after editing the rows:

    uv run python -m src.importers.ga_voter_file.sample_data.make_sample
"""

from __future__ import annotations

import csv
from pathlib import Path

from src.importers.ga_voter_file.decode import LAYOUT

HERE = Path(__file__).parent

DEFAULTS: dict[str, str] = {
    "County": "FULTON",
    "Status": "ACTIVE",
    "Status Reason": "",
    "Middle Name": "",
    "Suffix": "",
    "Birth Year": "1985",
    "Residence Street Number": "100",
    "Residence Pre Direction": "",
    "Residence Street Name": "PEACHTREE",
    "Residence Street Type": "ST",
    "Residence Post Direction": "NE",
    "Residence Apt Unit Number": "",
    "Residence City": "ATLANTA",
    "Residence Zipcode": "30308",
    "County Precinct": "01A",
    "County Precinct Description": "SAMPLE PRECINCT",
    "Municipal Precinct": "01A",
    "Municipal Precinct Description": "SAMPLE PRECINCT",
    "Congressional District": "005",
    "State Senate District": "036",
    "State House District": "057",
    "Judicial District": "ATLA",
    "County Commission District": "3",
    "School Board District": "",
    "City Council District": "02-ATLANTA",
    "Municipal School Board District": "",
    "Water Board District": "",
    "Super Council District": "",
    "Super Commissioner District": "",
    "Super School Board District": "",
    "Fire District": "",
    "Municipality": "ATLANTA",
    "Combo": "01001",
    "Land Lot": "001",
    "Land District": "14",
    "Registration Date": "2016-03-15 00:00:00.000",
    "Race": "WHITE",
    "Gender": "FEMALE",
    "Last Modified Date": "2024-01-01 00:00:00.000",
    "Date of Last Contact": "2024-01-01 00:00:00.000",
    "Last Party Voted": "DEMOCRAT",
    "Last Vote Date": "2024-11-05 00:00:00.000",
    "Voter Created Date": "2016-03-15 00:00:00.000",
    "Mailing Street Number": "",
    "Mailing Street Name": "",
    "Mailing Apt Unit Number": "",
    "Mailing City": "",
    "Mailing Zipcode": "",
    "Mailing State": "GA",
    "Mailing Country": "",
}

# (layout field → value) overrides. Registration numbers are assigned by row.
PEOPLE: list[dict[str, str]] = [
    # Baseline Fulton active Democrat.
    {
        "Last Name": "TESTER",
        "First Name": "AVERY",
        "Residence Street Number": "1724",
        "Residence Street Name": "PIEDMONT",
        "Residence Street Type": "AVE",
        "Residence Apt Unit Number": "201",
    },
    # DeKalb, outside Atlanta; different CD/SD/HD/ZIP so import filters have variety.
    {
        "Last Name": "SAMPLE",
        "First Name": "BLAKE",
        "Middle Name": "Q",
        "County": "DEKALB",
        "Residence Street Number": "4041",
        "Residence Street Name": "CONWAY VALLEY",
        "Residence Street Type": "RD",
        "Residence Post Direction": "NW",
        "Residence City": "ATLANTA",
        "Residence Zipcode": "30327",
        "County Precinct": "JA",
        "Congressional District": "006",
        "State Senate District": "014",
        "State House District": "054",
        "Judicial District": "STMT",
        "County Commission District": "2",
        "Gender": "MALE",
        "Race": "BLACK",
        "Last Party Voted": "REPUBLICAN",
        "Municipality": "BROOKHAVEN",
        "City Council District": "",
    },
    # Inactive with returned mail; non-partisan last ballot; no last vote.
    {
        "Last Name": "PLACEHOLDER",
        "First Name": "CASEY",
        "Status": "INACTIVE",
        "Status Reason": "RETURNED MAIL",
        "Residence Street Number": "2001",
        "Residence Street Name": "BISCAYNE",
        "Residence Street Type": "BLVD",
        "Last Party Voted": "NON-PARTISAN",
        "Last Vote Date": "",
        "Race": "HISPANIC/LATINO",
    },
    # Pre-direction + suffix; Asian; older birth year.
    {
        "Last Name": "FAKERSON",
        "First Name": "DREW",
        "Suffix": "JR",
        "Residence Street Number": "45",
        "Residence Pre Direction": "SW",
        "Residence Street Name": "8TH",
        "Residence Street Type": "ST",
        "Residence Post Direction": "",
        "Race": "ASIAN/PACIFIC ISLANDER",
        "Gender": "MALE",
        "Birth Year": "1952",
        "Congressional District": "005",
        "State Senate District": "039",
        "State House District": "056",
        "Residence Zipcode": "30303",
    },
    # American Indian; unknown gender; another house district; a lettered precinct.
    {
        "Last Name": "MOCKLEY",
        "First Name": "ELLIS",
        "Residence Street Number": "982",
        "Residence Street Name": "MEMORIAL",
        "Residence Street Type": "DR",
        "Residence Post Direction": "SE",
        "Residence Apt Unit Number": "415",
        "Residence Zipcode": "30316",
        "Race": "AMERICAN INDIAN",
        "Gender": "UNKNOWN",
        "State House District": "058",
        "County Precinct": "03P1A",
    },
    # Other race; X gender; a third ZIP; no party ballot on record.
    {
        "Last Name": "EXAMPLE",
        "First Name": "FINN",
        "Residence Street Number": "300",
        "Residence Street Name": "OCEAN",
        "Residence Street Type": "DR",
        "Residence Zipcode": "30309",
        "Race": "OTHER",
        "Gender": "X",
        "State Senate District": "038",
        "State House District": "055",
        "Last Party Voted": "",
    },
]


def voter_registration_number(index: int) -> str:
    """1-based sample person → registration number as the voter list spells it."""
    return f"{10_000_000 + index}"


# The order mvp.sos.ga.gov's recent per-election files use.
HISTORY_HEADER = [
    "Election Date",
    "County Name",
    "Voter Registration Number",
    "Election Type",
    "Party",
    "Ballot Style",
    "Absentee",
    "Provisional",
    "Supplemental",
]


def _vote(
    voter: str, date: str, county: str, type_: str, party: str, style: str, absentee: str, provisional: str
) -> dict[str, str]:
    return {
        "Election Date": date,
        "County Name": county,
        "Voter Registration Number": voter,
        "Election Type": type_,
        "Party": party,
        "Ballot Style": style,
        "Absentee": absentee,
        "Provisional": provisional,
        "Supplemental": "N",
    }


HISTORY_ROWS: list[dict[str, str]] = [
    # Avery: a full regular cycle — primary, primary runoff, general, general runoff.
    _vote("10000001", "05/21/2024", "FULTON", "GENERAL PRIMARY", "DEMOCRAT", "ABSENTEE BY MAIL", "Y", ""),
    _vote("10000001", "06/18/2024", "FULTON", "GENERAL PRIMARY RUNOFF", "DEMOCRAT", "EARLY IN-PERSON", "Y", ""),
    _vote("10000001", "11/05/2024", "FULTON", "GENERAL", "", "ELECTION DAY (BMD)", "N", "N"),
    _vote("10000001", "12/03/2024", "FULTON", "GENERAL ELECTION RUNOFF", "", "ELECTION DAY (BMD)", "N", "N"),
    # Blake: an overseas ballot, then a primary after the voter list's last vote.
    _vote("10000002", "11/05/2024", "DEKALB", "GENERAL", "", "ELECTRONIC BALLOT DELIVERY", "Y", ""),
    _vote("10000002", "05/19/2026", "DEKALB", "GENERAL PRIMARY", "DEMOCRAT", "EARLY IN-PERSON", "Y", ""),
    # Drew: two methods for one election (poll site wins), then a July special labelled GENERAL and its August runoff.
    _vote("10000004", "11/05/2024", "FULTON", "GENERAL", "", "EARLY IN-PERSON", "Y", ""),
    _vote("10000004", "11/05/2024", "FULTON", "GENERAL", "", "ELECTION DAY (BMD)", "N", "N"),
    _vote("10000004", "07/28/2026", "FULTON", "GENERAL", "", "ABSENTEE BY MAIL", "Y", ""),
    _vote("10000004", "08/25/2026", "FULTON", "GENERAL ELECTION RUNOFF", "", "ELECTION DAY (PROVISIONAL)", "N", "N"),
    # Ellis: an older presidential preference primary, an unlisted label, and an unlisted ballot style.
    _vote(
        "10000005", "03/12/2024", "FULTON", "PRESIDENTIAL PREFERENCE PRIMARY", "REPUBLICAN", "EARLY IN-PERSON", "Y", ""
    ),
    _vote("10000005", "04/16/2024", "FULTON", "RECALL", "", "ELECTION DAY (BMD)", "N", "N"),
    _vote("10000005", "11/05/2024", "FULTON", "GENERAL", "", "ELECTION DAY (PAPER)", "N", "N"),
    # Finn: a special-election runoff, a row with no type, and an exact duplicate.
    _vote("10000006", "06/09/2026", "FULTON", "SPECIAL ELECTION RUNOFF", "", "ABSENTEE BY MAIL", "Y", ""),
    _vote("10000006", "11/03/2026", "FULTON", "", "", "EARLY IN-PERSON", "Y", ""),
    _vote("10000006", "06/09/2026", "FULTON", "SPECIAL ELECTION RUNOFF", "", "ABSENTEE BY MAIL", "Y", ""),
    # A voter elsewhere in the state: history files cover every county.
    _vote("20000001", "11/05/2024", "LOWNDES", "GENERAL", "", "EARLY IN-PERSON", "Y", ""),
]


def write_csv(path: Path, people: list[dict[str, str]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as out:
        writer = csv.DictWriter(out, fieldnames=LAYOUT, quoting=csv.QUOTE_ALL)
        writer.writeheader()
        for i, overrides in enumerate(people, start=1):
            row = {**DEFAULTS, **overrides, "Voter Registration Number": voter_registration_number(i)}
            writer.writerow({field: row.get(field, "") for field in LAYOUT})


def write_history(path: Path, rows: list[dict[str, str]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as out:
        writer = csv.DictWriter(out, fieldnames=HISTORY_HEADER, quoting=csv.QUOTE_MINIMAL)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    write_csv(HERE / "file.csv", PEOPLE)
    write_history(HERE / "history.csv", HISTORY_ROWS)
    print(f"wrote {HERE / 'file.csv'} ({len(PEOPLE)} people)")
    print(f"wrote {HERE / 'history.csv'} ({len(HISTORY_ROWS)} history rows)")


if __name__ == "__main__":
    main()
