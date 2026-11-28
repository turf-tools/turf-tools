"""Florida raw registration + history → the `Person` schema plus filterable fields.

Codes come from the Division of Elections' "Voter Extract File Layout" (May 2026).
State-specific codes map to the canonical cross-state values NYS uses where the
meaning matches (parties, statuses, election types, voting methods), and to
Florida's own values otherwise.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from src.importers.history import VOTING_HISTORY_TYPE, one_vote_per_election_sql
from src.importers.sql import case_from_map, county_local_sql, where_sql

if TYPE_CHECKING:
    from src.importers.base import ImportFilter

# DOS county code → (county name, 5-digit Census county FIPS). Names as the
# layout spells them; FIPS from the Census Bureau's 2020 Florida county list.
FL_COUNTIES: dict[str, tuple[str, str]] = {
    "ALA": ("Alachua", "12001"),
    "BAK": ("Baker", "12003"),
    "BAY": ("Bay", "12005"),
    "BRA": ("Bradford", "12007"),
    "BRE": ("Brevard", "12009"),
    "BRO": ("Broward", "12011"),
    "CAL": ("Calhoun", "12013"),
    "CHA": ("Charlotte", "12015"),
    "CIT": ("Citrus", "12017"),
    "CLA": ("Clay", "12019"),
    "CLL": ("Collier", "12021"),
    "CLM": ("Columbia", "12023"),
    "DAD": ("Miami-Dade", "12086"),
    "DES": ("Desoto", "12027"),
    "DIX": ("Dixie", "12029"),
    "DUV": ("Duval", "12031"),
    "ESC": ("Escambia", "12033"),
    "FLA": ("Flagler", "12035"),
    "FRA": ("Franklin", "12037"),
    "GAD": ("Gadsden", "12039"),
    "GIL": ("Gilchrist", "12041"),
    "GLA": ("Glades", "12043"),
    "GUL": ("Gulf", "12045"),
    "HAM": ("Hamilton", "12047"),
    "HAR": ("Hardee", "12049"),
    "HEN": ("Hendry", "12051"),
    "HER": ("Hernando", "12053"),
    "HIG": ("Highlands", "12055"),
    "HIL": ("Hillsborough", "12057"),
    "HOL": ("Holmes", "12059"),
    "IND": ("Indian River", "12061"),
    "JAC": ("Jackson", "12063"),
    "JEF": ("Jefferson", "12065"),
    "LAF": ("Lafayette", "12067"),
    "LAK": ("Lake", "12069"),
    "LEE": ("Lee", "12071"),
    "LEO": ("Leon", "12073"),
    "LEV": ("Levy", "12075"),
    "LIB": ("Liberty", "12077"),
    "MAD": ("Madison", "12079"),
    "MAN": ("Manatee", "12081"),
    "MRN": ("Marion", "12083"),
    "MRT": ("Martin", "12085"),
    "MON": ("Monroe", "12087"),
    "NAS": ("Nassau", "12089"),
    "OKA": ("Okaloosa", "12091"),
    "OKE": ("Okeechobee", "12093"),
    "ORA": ("Orange", "12095"),
    "OSC": ("Osceola", "12097"),
    "PAL": ("Palm Beach", "12099"),
    "PAS": ("Pasco", "12101"),
    "PIN": ("Pinellas", "12103"),
    "POL": ("Polk", "12105"),
    "PUT": ("Putnam", "12107"),
    "SAN": ("Santa Rosa", "12113"),
    "SAR": ("Sarasota", "12115"),
    "SEM": ("Seminole", "12117"),
    "STJ": ("St. Johns", "12109"),
    "STL": ("St. Lucie", "12111"),
    "SUM": ("Sumter", "12119"),
    "SUW": ("Suwannee", "12121"),
    "TAY": ("Taylor", "12123"),
    "UNI": ("Union", "12125"),
    "VOL": ("Volusia", "12127"),
    "WAK": ("Wakulla", "12129"),
    "WAL": ("Walton", "12131"),
    "WAS": ("Washington", "12133"),
}

# Party code → canonical enrollment. The six NYS also has share its values;
# IND is the Independent Party of Florida, not NYS's Independence Party. Every
# other registered party is `other`.
FL_ENROLLMENTS: dict[str, str] = {
    "DEM": "democratic",
    "REP": "republican",
    "NPA": "unaffiliated",
    "IND": "independent",
    "LPF": "libertarian",
    "GRE": "green",
    "CSV": "conservative",
}

FL_RACES: dict[str, str] = {
    "1": "american_indian_alaskan_native",
    "2": "asian_pacific_islander",
    "3": "black",
    "4": "hispanic",
    "5": "white",
    "6": "other",
    "7": "multiracial",
    "9": "unknown",
}

FL_REGISTRATION_STATUSES: dict[str, str] = {"ACT": "active", "INA": "inactive"}

# Election type code → canonical type. GEN and PRI also mark special
# elections, so they're classified by date (`_election_type_sql`). OTH lumps
# special, local, and municipal elections together, so it gets its own `other`
# type rather than passing as a special.
FL_ELECTION_TYPES: dict[str, str] = {
    "PPP": "presidential_primary",
    "RUN": "primary_runoff",
    "OTH": "other",
}

# Florida's regular elections fall on fixed months of even years: the primary
# in August and the general in November. A GEN or PRI on any other date is a
# special election.
_REGULAR_ELECTION_MONTHS: dict[str, tuple[str, int]] = {"GEN": ("general", 11), "PRI": ("primary", 8)}

# History code → voting method, for ballots that counted. B, L, and P are
# ballots not counted and N is "did not vote", so they aren't votes.
FL_VOTING_METHODS: dict[str, str] = {"Y": "poll_site", "E": "early_voting", "A": "absentee"}

# Filter columns whose raw text isn't compared as-is: a ZIP may be ZIP+4 run
# together, so it's matched on its first five digits.
FILTER_EXPRESSIONS: dict[str, str] = {"residence_zipcode": "left(raw.residence_zipcode, 5)"}


def _election_type_sql(code: str, date: str) -> str:
    """SQL mapping an election type code and its DATE to the canonical type."""
    regular = " ".join(
        f"WHEN {code} = '{c}' THEN CASE WHEN month({date}) = {m} AND year({date}) % 2 = 0 "
        f"THEN '{label}' ELSE 'special' END"
        for c, (label, m) in _REGULAR_ELECTION_MONTHS.items()
    )
    others = " ".join(f"WHEN {code} = '{c}' THEN '{label}'" for c, label in FL_ELECTION_TYPES.items())
    return f"CASE {regular} {others} ELSE NULL END"


def _iso_date_sql(col: str) -> str:
    """SQL converting an MM/DD/YYYY VARCHAR to YYYY-MM-DD. NULL on malformed input."""
    return f"strftime(try_strptime({col}, '%m/%d/%Y'), '%Y-%m-%d')"


def fl_votes_query(registration_table: str, history_table: str, filter: ImportFilter | None = None) -> str:
    """SQL reducing raw history to one counted vote per voter per election.

    Restricted to the voters the filter keeps, and joined on voter ID alone,
    since a history row's county is wherever the voter lived at the time.
    """
    counted = ", ".join(f"'{code}'" for code in FL_VOTING_METHODS)
    votes = f"""
    SELECT
        voter_id,
        election_date,
        {_election_type_sql("election_type", "election_date")} AS type,
        {case_from_map("history_code", FL_VOTING_METHODS)} AS method
    FROM (
        SELECT
            h.voter_id,
            try_strptime(h.election_date, '%m/%d/%Y')::DATE AS election_date,
            h.election_type,
            h.history_code
        FROM {history_table} AS h
        WHERE h.history_code IN ({counted})
          AND h.voter_id IN (
              SELECT raw.voter_id FROM {registration_table} AS raw {where_sql(filter, FILTER_EXPRESSIONS)}
          )
    )
"""
    return one_vote_per_election_sql(votes)


def fl_transformation_query(
    registration_table: str,
    history_table: str,
    filter: ImportFilter | None = None,
) -> str:
    """SQL mapping the raw registration table, joined to the grouped history,
    to the Person schema.

    Args:
        registration_table: fully-qualified raw registration table (`persons_raw`).
        history_table: fully-qualified grouped history table, one
            `voting_history` per voter (`group_votes`).
        filter: optional row filter on a raw registration column, the dataset's
            fixed import slice.
    """
    county_fips = {code: fips for code, (_, fips) in FL_COUNTIES.items()}
    return f"""
WITH reg AS (
    SELECT
        raw.*,
        regexp_replace(raw.residence_address_line_1, '\\s+', ' ', 'g') AS line_1,
        regexp_replace(raw.residence_zipcode, '[^0-9]', '', 'g') AS zip_digits
    FROM {registration_table} AS raw
    {where_sql(filter, FILTER_EXPRESSIONS)}
)
SELECT
    raw.voter_id AS external_id,
    'fl_dos' AS external_id_type,
    raw.name_first AS first_name,
    raw.name_last AS last_name,
    raw.name_middle AS middle_name,
    raw.name_suffix AS name_suffix,
    -- A `1/2` after the house number is kept out of address_line_1, so street
    -- tokenisation doesn't read it as match material; reassembled downstream.
    trim(regexp_replace(raw.line_1, '^(\\S+) [0-9]/[0-9] ', '\\1 ')) AS address_line_1,
    raw.residence_address_line_2 AS address_line_2,
    nullif(regexp_extract(raw.line_1, '^\\S+ ([0-9]/[0-9]) ', 1), '') AS half_code,
    raw.residence_city_usps AS city,
    -- The extract leaves the residence state blank; every voter lives in Florida.
    'FL' AS state,
    left(raw.zip_digits, 5) AS zip5,
    CASE WHEN length(raw.zip_digits) = 9 THEN right(raw.zip_digits, 4) END AS zip4,
    {case_from_map("raw.party_affiliation", FL_ENROLLMENTS, default="other")} AS enrollment,
    raw.gender AS gender,
    {case_from_map("raw.race", FL_RACES)} AS race,
    {_iso_date_sql("raw.birth_date")} AS date_of_birth,
    {_iso_date_sql("raw.registration_date")} AS registration_date,
    {case_from_map("raw.voter_status", FL_REGISTRATION_STATUSES, default="unknown")} AS registration_status,
    raw.county_code AS county_code,
    {case_from_map("raw.county_code", county_fips)} AS county_fips,
    {county_local_sql("raw.precinct", "raw.county_code")} AS precinct,
    raw.congressional_district AS congressional_district,
    raw.house_district AS house_district,
    raw.senate_district AS senate_district,
    CASE
        WHEN regexp_full_match(raw.daytime_area_code, '[0-9]{{3}}')
         AND regexp_full_match(raw.daytime_phone_number, '[0-9]{{7}}')
        THEN raw.daytime_area_code || raw.daytime_phone_number
    END AS phone,
    CASE WHEN contains(raw.email_address, '@') THEN lower(raw.email_address) END AS email,
    coalesce(history.voting_history, CAST([] AS {VOTING_HISTORY_TYPE})) AS voting_history
FROM reg AS raw
LEFT JOIN {history_table} AS history ON history.voter_id = raw.voter_id
"""
