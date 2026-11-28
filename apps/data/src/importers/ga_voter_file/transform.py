"""Georgia SOS voter list + history → the `Person` schema plus filterable fields.

Codes and labels come from SOS voter-list CSVs and mvp.sos.ga.gov voter-history
CSVs. Georgia does not register party; race and gender arrive spelled out; the
birth year is the only age signal (`year_of_birth`). History joins on the
8-digit registration number and becomes the canonical `voting_history` list.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from src.importers.history import VOTING_HISTORY_TYPE, one_vote_per_election_sql
from src.importers.sql import case_from_map, county_local_sql, where_sql

if TYPE_CHECKING:
    from src.importers.base import ImportFilter

# County name as the state spells it (uppercase, no spaces) → (display, FIPS).
GA_COUNTIES: dict[str, tuple[str, str]] = {
    "APPLING": ("Appling", "13001"),
    "ATKINSON": ("Atkinson", "13003"),
    "BACON": ("Bacon", "13005"),
    "BAKER": ("Baker", "13007"),
    "BALDWIN": ("Baldwin", "13009"),
    "BANKS": ("Banks", "13011"),
    "BARROW": ("Barrow", "13013"),
    "BARTOW": ("Bartow", "13015"),
    "BENHILL": ("Ben Hill", "13017"),
    "BERRIEN": ("Berrien", "13019"),
    "BIBB": ("Bibb", "13021"),
    "BLECKLEY": ("Bleckley", "13023"),
    "BRANTLEY": ("Brantley", "13025"),
    "BROOKS": ("Brooks", "13027"),
    "BRYAN": ("Bryan", "13029"),
    "BULLOCH": ("Bulloch", "13031"),
    "BURKE": ("Burke", "13033"),
    "BUTTS": ("Butts", "13035"),
    "CALHOUN": ("Calhoun", "13037"),
    "CAMDEN": ("Camden", "13039"),
    "CANDLER": ("Candler", "13043"),
    "CARROLL": ("Carroll", "13045"),
    "CATOOSA": ("Catoosa", "13047"),
    "CHARLTON": ("Charlton", "13049"),
    "CHATHAM": ("Chatham", "13051"),
    "CHATTAHOOCHEE": ("Chattahoochee", "13053"),
    "CHATTOOGA": ("Chattooga", "13055"),
    "CHEROKEE": ("Cherokee", "13057"),
    "CLARKE": ("Clarke", "13059"),
    "CLAY": ("Clay", "13061"),
    "CLAYTON": ("Clayton", "13063"),
    "CLINCH": ("Clinch", "13065"),
    "COBB": ("Cobb", "13067"),
    "COFFEE": ("Coffee", "13069"),
    "COLQUITT": ("Colquitt", "13071"),
    "COLUMBIA": ("Columbia", "13073"),
    "COOK": ("Cook", "13075"),
    "COWETA": ("Coweta", "13077"),
    "CRAWFORD": ("Crawford", "13079"),
    "CRISP": ("Crisp", "13081"),
    "DADE": ("Dade", "13083"),
    "DAWSON": ("Dawson", "13085"),
    "DECATUR": ("Decatur", "13087"),
    "DEKALB": ("DeKalb", "13089"),
    "DODGE": ("Dodge", "13091"),
    "DOOLY": ("Dooly", "13093"),
    "DOUGHERTY": ("Dougherty", "13095"),
    "DOUGLAS": ("Douglas", "13097"),
    "EARLY": ("Early", "13099"),
    "ECHOLS": ("Echols", "13101"),
    "EFFINGHAM": ("Effingham", "13103"),
    "ELBERT": ("Elbert", "13105"),
    "EMANUEL": ("Emanuel", "13107"),
    "EVANS": ("Evans", "13109"),
    "FANNIN": ("Fannin", "13111"),
    "FAYETTE": ("Fayette", "13113"),
    "FLOYD": ("Floyd", "13115"),
    "FORSYTH": ("Forsyth", "13117"),
    "FRANKLIN": ("Franklin", "13119"),
    "FULTON": ("Fulton", "13121"),
    "GILMER": ("Gilmer", "13123"),
    "GLASCOCK": ("Glascock", "13125"),
    "GLYNN": ("Glynn", "13127"),
    "GORDON": ("Gordon", "13129"),
    "GRADY": ("Grady", "13131"),
    "GREENE": ("Greene", "13133"),
    "GWINNETT": ("Gwinnett", "13135"),
    "HABERSHAM": ("Habersham", "13137"),
    "HALL": ("Hall", "13139"),
    "HANCOCK": ("Hancock", "13141"),
    "HARALSON": ("Haralson", "13143"),
    "HARRIS": ("Harris", "13145"),
    "HART": ("Hart", "13147"),
    "HEARD": ("Heard", "13149"),
    "HENRY": ("Henry", "13151"),
    "HOUSTON": ("Houston", "13153"),
    "IRWIN": ("Irwin", "13155"),
    "JACKSON": ("Jackson", "13157"),
    "JASPER": ("Jasper", "13159"),
    "JEFFDAVIS": ("Jeff Davis", "13161"),
    "JEFFERSON": ("Jefferson", "13163"),
    "JENKINS": ("Jenkins", "13165"),
    "JOHNSON": ("Johnson", "13167"),
    "JONES": ("Jones", "13169"),
    "LAMAR": ("Lamar", "13171"),
    "LANIER": ("Lanier", "13173"),
    "LAURENS": ("Laurens", "13175"),
    "LEE": ("Lee", "13177"),
    "LIBERTY": ("Liberty", "13179"),
    "LINCOLN": ("Lincoln", "13181"),
    "LONG": ("Long", "13183"),
    "LOWNDES": ("Lowndes", "13185"),
    "LUMPKIN": ("Lumpkin", "13187"),
    "MCDUFFIE": ("McDuffie", "13189"),
    "MCINTOSH": ("McIntosh", "13191"),
    "MACON": ("Macon", "13193"),
    "MADISON": ("Madison", "13195"),
    "MARION": ("Marion", "13197"),
    "MERIWETHER": ("Meriwether", "13199"),
    "MILLER": ("Miller", "13201"),
    "MITCHELL": ("Mitchell", "13205"),
    "MONROE": ("Monroe", "13207"),
    "MONTGOMERY": ("Montgomery", "13209"),
    "MORGAN": ("Morgan", "13211"),
    "MURRAY": ("Murray", "13213"),
    "MUSCOGEE": ("Muscogee", "13215"),
    "NEWTON": ("Newton", "13217"),
    "OCONEE": ("Oconee", "13219"),
    "OGLETHORPE": ("Oglethorpe", "13221"),
    "PAULDING": ("Paulding", "13223"),
    "PEACH": ("Peach", "13225"),
    "PICKENS": ("Pickens", "13227"),
    "PIERCE": ("Pierce", "13229"),
    "PIKE": ("Pike", "13231"),
    "POLK": ("Polk", "13233"),
    "PULASKI": ("Pulaski", "13235"),
    "PUTNAM": ("Putnam", "13237"),
    "QUITMAN": ("Quitman", "13239"),
    "RABUN": ("Rabun", "13241"),
    "RANDOLPH": ("Randolph", "13243"),
    "RICHMOND": ("Richmond", "13245"),
    "ROCKDALE": ("Rockdale", "13247"),
    "SCHLEY": ("Schley", "13249"),
    "SCREVEN": ("Screven", "13251"),
    "SEMINOLE": ("Seminole", "13253"),
    "SPALDING": ("Spalding", "13255"),
    "STEPHENS": ("Stephens", "13257"),
    "STEWART": ("Stewart", "13259"),
    "SUMTER": ("Sumter", "13261"),
    "TALBOT": ("Talbot", "13263"),
    "TALIAFERRO": ("Taliaferro", "13265"),
    "TATTNALL": ("Tattnall", "13267"),
    "TAYLOR": ("Taylor", "13269"),
    "TELFAIR": ("Telfair", "13271"),
    "TERRELL": ("Terrell", "13273"),
    "THOMAS": ("Thomas", "13275"),
    "TIFT": ("Tift", "13277"),
    "TOOMBS": ("Toombs", "13279"),
    "TOWNS": ("Towns", "13281"),
    "TREUTLEN": ("Treutlen", "13283"),
    "TROUP": ("Troup", "13285"),
    "TURNER": ("Turner", "13287"),
    "TWIGGS": ("Twiggs", "13289"),
    "UNION": ("Union", "13291"),
    "UPSON": ("Upson", "13293"),
    "WALKER": ("Walker", "13295"),
    "WALTON": ("Walton", "13297"),
    "WARE": ("Ware", "13299"),
    "WARREN": ("Warren", "13301"),
    "WASHINGTON": ("Washington", "13303"),
    "WAYNE": ("Wayne", "13305"),
    "WEBSTER": ("Webster", "13307"),
    "WHEELER": ("Wheeler", "13309"),
    "WHITE": ("White", "13311"),
    "WHITFIELD": ("Whitfield", "13313"),
    "WILCOX": ("Wilcox", "13315"),
    "WILKES": ("Wilkes", "13317"),
    "WILKINSON": ("Wilkinson", "13319"),
    "WORTH": ("Worth", "13321"),
}

GA_REGISTRATION_STATUSES: dict[str, str] = {"ACTIVE": "active", "INACTIVE": "inactive"}

GA_RACES: dict[str, str] = {
    "AMERICAN INDIAN": "american_indian_alaskan_native",
    "ALASKAN NATIVE": "american_indian_alaskan_native",
    "ASIAN/PACIFIC ISLANDER": "asian_pacific_islander",
    "BLACK": "black",
    "HISPANIC/LATINO": "hispanic",
    "WHITE": "white",
    "OTHER": "other",
    "UNKNOWN": "unknown",
}

GA_GENDERS: dict[str, str] = {"MALE": "M", "FEMALE": "F", "UNKNOWN": "U", "X": "X"}

# Last party ballot the voter took in a primary — Georgia has no party registration.
GA_LAST_PARTIES: dict[str, str] = {
    "DEMOCRAT": "democratic",
    "REPUBLICAN": "republican",
    "NON-PARTISAN": "non_partisan",
}

# History `Election Type` → canonical type, matched after uppercasing,
# collapsing hyphens and runs of spaces, and reading `RUN OFF` as `RUNOFF`.
# Unlisted labels are `other`.
GA_ELECTION_TYPES: dict[str, str] = {
    "GENERAL": "general",
    "GENERAL PRIMARY": "primary",
    "GENERAL PRIMARY RUNOFF": "primary_runoff",
    "GENERAL ELECTION RUNOFF": "general_runoff",
    "PRESIDENTIAL PREFERENCE PRIMARY": "presidential_primary",
    "SPECIAL ELECTION": "special",
    "SPECIAL ELECTION RUNOFF": "special",
    "SPECIAL PRIMARY": "special",
    "SPECIAL PRIMARY RUNOFF": "special",
}

# The label describes the contest on the voter's ballot, so a special election
# for a seat elected at the general is labelled `GENERAL`. A general is in
# November and its runoff in December or January; at any other time either is
# a special election.
_GENERAL_MONTHS: dict[str, tuple[int, ...]] = {"general": (11,), "general_runoff": (12, 1)}

# History `Ballot Style` → canonical voting method. Unlisted styles are `other`.
GA_VOTING_METHODS: dict[str, str] = {
    "ELECTION DAY (BMD)": "poll_site",
    "ELECTION DAY (PROVISIONAL)": "poll_site",
    "EARLY IN-PERSON": "early_voting",
    "ABSENTEE BY MAIL": "absentee",
    "ELECTRONIC BALLOT DELIVERY": "absentee",
}

# Filter columns whose raw text isn't compared as-is: a ZIP may be ZIP+4, so
# it's matched on its first five digits.
FILTER_EXPRESSIONS: dict[str, str] = {"residence_zipcode": "left(raw.residence_zipcode, 5)"}


def _timestamp_date_sql(col: str) -> str:
    """SOS timestamps look like `2022-08-22 00:00:00.000`; keep YYYY-MM-DD."""
    return f"strftime(try_strptime(left({col}, 10), '%Y-%m-%d'), '%Y-%m-%d')"


def _label_type_sql(label: str) -> str:
    """SQL mapping an `Election Type` label to its canonical type, before the
    month check."""
    normalized = (
        f"replace(trim(regexp_replace(upper(replace({label}, '-', ' ')), '\\s+', ' ', 'g')), 'RUN OFF', 'RUNOFF')"
    )
    return f"coalesce({case_from_map(normalized, GA_ELECTION_TYPES)}, 'other')"


def ga_votes_query(registration_table: str, history_table: str, filter: ImportFilter | None = None) -> str:
    """SQL reducing raw history to one counted vote per voter per election,
    restricted to the voters the filter keeps. Joined on registration number
    alone, since a history row's county is wherever the voter lived then."""
    off_month = " ".join(
        f"WHEN label_type = '{type_}' AND month(election_date) NOT IN ({', '.join(map(str, months))}) THEN 'special'"
        for type_, months in _GENERAL_MONTHS.items()
    )
    votes = f"""
    SELECT voter_id, election_date, CASE {off_month} ELSE label_type END AS type, method
    FROM (
        SELECT
            h.voter_registration_number AS voter_id,
            try_strptime(h.election_date, '%m/%d/%Y')::DATE AS election_date,
            {_label_type_sql("h.election_type")} AS label_type,
            coalesce({case_from_map("upper(h.ballot_style)", GA_VOTING_METHODS)}, 'other') AS method
        FROM {history_table} AS h
        WHERE h.voter_registration_number IN (
            SELECT raw.voter_registration_number
            FROM {registration_table} AS raw
            {where_sql(filter, FILTER_EXPRESSIONS)}
        )
    )
"""
    return one_vote_per_election_sql(votes)


def ga_last_party_query(registration_table: str, history_table: str, filter: ImportFilter | None = None) -> str:
    """SQL giving each voter's newest party ballot in history: its date and
    party. Only primary ballots carry a party."""
    return f"""
SELECT
    voter_id,
    CAST(split_part(newest, '|', 1) AS DATE) AS party_date,
    split_part(newest, '|', 2) AS party
FROM (
    SELECT
        h.voter_registration_number AS voter_id,
        max(strftime(try_strptime(h.election_date, '%m/%d/%Y'), '%Y-%m-%d') || '|' || upper(h.party)) AS newest
    FROM {history_table} AS h
    WHERE h.party IS NOT NULL
      AND try_strptime(h.election_date, '%m/%d/%Y') IS NOT NULL
      AND h.voter_registration_number IN (
          SELECT raw.voter_registration_number
          FROM {registration_table} AS raw
          {where_sql(filter, FILTER_EXPRESSIONS)}
      )
    GROUP BY 1
)
"""


def ga_transformation_query(
    registration_table: str,
    history_table: str,
    party_table: str,
    filter: ImportFilter | None = None,
) -> str:
    """SQL mapping the raw voter list, joined to the grouped history and each
    voter's newest party ballot (`ga_last_party_query`), to the Person schema."""
    county_fips = {code: fips for code, (_, fips) in GA_COUNTIES.items()}
    # The county as `GA_COUNTIES` spells it, whether or not the file spaces it.
    county_key = "replace(upper(raw.county), ' ', '')"
    return f"""
SELECT
    raw.voter_registration_number AS external_id,
    'ga_sos' AS external_id_type,
    raw.first_name AS first_name,
    raw.last_name AS last_name,
    raw.middle_name AS middle_name,
    raw.suffix AS name_suffix,
    concat_ws(
        ' ',
        raw.residence_street_number,
        raw.residence_pre_direction,
        raw.residence_street_name,
        raw.residence_street_type,
        raw.residence_post_direction
    ) AS address_line_1,
    raw.residence_apt_unit_number AS address_line_2,
    CAST(NULL AS VARCHAR) AS half_code,
    raw.residence_city AS city,
    'GA' AS state,
    left(regexp_replace(raw.residence_zipcode, '[^0-9]', '', 'g'), 5) AS zip5,
    CAST(NULL AS VARCHAR) AS zip4,
    {case_from_map("raw.gender", GA_GENDERS)} AS gender,
    {case_from_map("raw.race", GA_RACES)} AS race,
    CASE WHEN regexp_full_match(raw.birth_year, '[0-9]{{4}}') THEN CAST(raw.birth_year AS INTEGER) END AS year_of_birth,
    {_timestamp_date_sql("raw.registration_date")} AS registration_date,
    {case_from_map("raw.status", GA_REGISTRATION_STATUSES, default="unknown")} AS registration_status,
    -- The voter list and the history files are separate snapshots, so the
    -- newest vote in history can be later than the list's own date.
    greatest({_timestamp_date_sql("raw.last_vote_date")}, history.voting_history[-1].date) AS last_voted_date,
    -- A party ballot in history after the voter list's last vote is newer than
    -- the list's own Last Party Voted. No party ballot on record is `none`.
    CASE
        WHEN party.party_date > try_strptime(left(raw.last_vote_date, 10), '%Y-%m-%d')::DATE
          OR (party.party_date IS NOT NULL AND raw.last_vote_date IS NULL)
        THEN {case_from_map("party.party", GA_LAST_PARTIES)}
        WHEN raw.last_party_voted IS NULL THEN 'none'
        ELSE {case_from_map("raw.last_party_voted", GA_LAST_PARTIES)}
    END AS last_party_voted,
    {county_key} AS county_code,
    {case_from_map(county_key, county_fips)} AS county_fips,
    -- Codes numbered within a county get the county after them, the way the
    -- file writes city council districts (`05-ATLANTA`). Place names are
    -- uppercase without spaces in all three.
    {county_local_sql("raw.county_precinct", county_key, county_first=False)} AS precinct,
    raw.congressional_district AS congressional_district,
    raw.state_senate_district AS senate_district,
    raw.state_house_district AS house_district,
    {county_local_sql("raw.county_commission_district", county_key, county_first=False)} AS county_commission_district,
    replace(upper(raw.city_council_district), ' ', '') AS city_council_district,
    raw.municipality AS municipality,
    coalesce(history.voting_history, CAST([] AS {VOTING_HISTORY_TYPE})) AS voting_history
FROM {registration_table} AS raw
LEFT JOIN {history_table} AS history ON history.voter_id = raw.voter_registration_number
LEFT JOIN {party_table} AS party ON party.voter_id = raw.voter_registration_number
{where_sql(filter, FILTER_EXPRESSIONS)}
"""
