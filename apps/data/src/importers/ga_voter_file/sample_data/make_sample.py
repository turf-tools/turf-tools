"""Write the Georgia sample: invented voters in the SOS voter-list CSV layout.

`file.csv` — quoted CSV with the SOS header. Each person exercises something
the import handles; the comment beside it says what.

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
    # DeKalb; different CD/SD/HD/ZIP so import filters have variety.
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
    # Unknown race/gender; American Indian sibling variety in another HD.
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
    # Other race; X gender; Ben Hill-style multi-word county isn't in this
    # Atlanta slice — keep Fulton with a third ZIP for filter variety.
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


def write_csv(path: Path, people: list[dict[str, str]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as out:
        writer = csv.DictWriter(out, fieldnames=LAYOUT, quoting=csv.QUOTE_ALL)
        writer.writeheader()
        for i, overrides in enumerate(people, start=1):
            row = {**DEFAULTS, **overrides, "Voter Registration Number": f"{10_000_000 + i}"}
            writer.writerow({field: row.get(field, "") for field in LAYOUT})


def main() -> None:
    write_csv(HERE / "file.csv", PEOPLE)
    print(f"wrote {HERE / 'file.csv'} ({len(PEOPLE)} people)")


if __name__ == "__main__":
    main()
