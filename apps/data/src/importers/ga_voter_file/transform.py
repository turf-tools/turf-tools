"""Georgia SOS voter-list + history → the `Person` schema plus filterable fields.

Codes and labels come from recent SOS voter-list CSVs (county and statewide)
and mvp.sos.ga.gov voter-history CSVs. Georgia does not register party;
race/gender arrive spelled out; birth year is the only age signal (stored as
YYYY-01-01 for age-range filters). Optional history joins on registration
number and becomes the canonical `voting_history` STRUCT[].
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from src.importers.base import ImportFilter

# County name as the file spells it (uppercase, no spaces) → (display, FIPS).
# Lookup normalizes spaces away so "BEN HILL" and "BENHILL" both match.
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
    "ASIAN/PACIFIC ISLANDER": "asian_pacific_islander",
    "BLACK": "black",
    "HISPANIC/LATINO": "hispanic",
    "WHITE": "white",
    "OTHER": "other",
    "UNKNOWN": "unknown",
}

GA_GENDERS: dict[str, str] = {
    "MALE": "M",
    "FEMALE": "F",
    "UNKNOWN": "U",
    "X": "X",
}

# Last party ballot the voter took in a primary — Georgia has no party registration.
GA_LAST_PARTIES: dict[str, str] = {
    "DEMOCRAT": "democratic",
    "REPUBLICAN": "republican",
    "NON-PARTISAN": "non_partisan",
}

# mvp.sos.ga.gov Election Type strings → canonical type. Matched after
# uppercasing and collapsing runs of spaces/hyphens to a single space.
GA_ELECTION_TYPES: dict[str, str] = {
    "GENERAL": "general",
    "GENERAL ELECTION": "general",
    "GENERAL PRIMARY": "primary",
    "PRIMARY": "primary",
    "GENERAL PRIMARY RUN OFF": "runoff",
    "GENERAL PRIMARY RUNOFF": "runoff",
    "GENERAL ELECTION RUN OFF": "runoff",
    "GENERAL ELECTION RUNOFF": "runoff",
    "GENERAL RUN OFF": "runoff",
    "GENERAL RUNOFF": "runoff",
    "SPECIAL ELECTION": "special",
    "SPECIAL ELECTION RUN OFF": "runoff",
    "SPECIAL ELECTION RUNOFF": "runoff",
    "SPECIAL RUN OFF": "runoff",
    "SPECIAL RUNOFF": "runoff",
    "SPECIAL PRIMARY": "special",
    "SPECIAL PRIMARY RUN OFF": "runoff",
    "SPECIAL PRIMARY RUNOFF": "runoff",
    "PPP": "presidential_primary",
    "PRESIDENTIAL PREFERENCE PRIMARY": "presidential_primary",
    "PRESIDENTIAL PRIMARY": "presidential_primary",
    "NON PARTISAN": "other",
    "NONPARTISAN": "other",
    "RECALL": "other",
    "MUNICIPAL": "other",
}

# When one voter has several history rows for one election, keep the first.
_METHOD_PRIORITY = ("poll_site", "early_voting", "absentee")

_FILTER_EXPRESSIONS: dict[str, str] = {
    "residence_zipcode": "left(raw.residence_zipcode, 5)",
}

VOTING_HISTORY_TYPE = "STRUCT(year INT, type VARCHAR, date VARCHAR, method VARCHAR)[]"

# Votes grouped into lists per pass — same budget as Florida.
VOTES_PER_BATCH = 5_000_000


def _case_from_map(col: str, mapping: dict[str, str], default: str | None = None) -> str:
    branches = " ".join(f"WHEN {col} = '{raw}' THEN '{label}'" for raw, label in mapping.items())
    else_clause = "NULL" if default is None else f"CASE WHEN {col} IS NULL THEN NULL ELSE '{default}' END"
    return f"CASE {branches} ELSE {else_clause} END"


def _timestamp_date_sql(col: str) -> str:
    """SOS timestamps look like `2022-08-22 00:00:00.000`; keep YYYY-MM-DD."""
    return f"try_strptime(left({col}, 10), '%Y-%m-%d')::DATE::VARCHAR"


def _where_sql(filter: ImportFilter | None) -> str:
    if not filter or not filter.values:
        return ""
    joined = ", ".join("'" + v.replace("'", "''") + "'" for v in filter.values)
    expression = _FILTER_EXPRESSIONS.get(filter.column, f"raw.{filter.column}")
    return f"WHERE {expression} IN ({joined})"


def _voter_id_key(col: str) -> str:
    """Normalize a registration number for joining (strip leading zeros)."""
    return f"nullif(regexp_replace({col}, '^0+', ''), '')"


def _election_type_sql(col: str) -> str:
    """Map a free-text Election Type onto the canonical type labels."""
    normalized = f"trim(regexp_replace(upper(replace({col}, '-', ' ')), '\\s+', ' ', 'g'))"
    branches = " ".join(f"WHEN {normalized} = '{raw}' THEN '{label}'" for raw, label in GA_ELECTION_TYPES.items())
    return f"CASE {branches} ELSE NULL END"


def _voting_method_sql(ballot_style: str) -> str:
    """Map Ballot Style onto poll_site / early_voting / absentee."""
    style = f"upper(coalesce({ballot_style}, ''))"
    return f"""
CASE
    WHEN {style} LIKE '%EARLY%' THEN 'early_voting'
    WHEN {style} LIKE '%ABSENTEE%' OR {style} LIKE '%MAIL%'
      OR {style} LIKE '%ELECTRONIC%' THEN 'absentee'
    WHEN {style} LIKE '%ELECTION DAY%' OR {style} LIKE '%REGULAR%'
      OR {style} LIKE '%PROVISIONAL%' OR {style} LIKE '%PAPER%'
      OR {style} LIKE '%BMD%' THEN 'poll_site'
    ELSE NULL
END
""".strip()


def ga_votes_query(registration_table: str, history_table: str, filter: ImportFilter | None = None) -> str:
    """SQL reducing raw history to one counted vote per voter per election.

    Restricted to voters the registration filter keeps. Joined on registration
    number alone (history county is where they lived at the time). Duplicate
    rows collapse; several methods for one election keep poll_site first.
    """
    method_rank = " ".join(f"WHEN '{method}' THEN {i}" for i, method in enumerate(_METHOD_PRIORITY))
    return f"""
SELECT voter_id, election_date, type, arg_min(method, rank) AS method
FROM (
    SELECT
        voter_id,
        election_date,
        type,
        method,
        CASE method {method_rank} END AS rank
    FROM (
        SELECT
            {_voter_id_key("h.voter_registration_number")} AS voter_id,
            try_strptime(h.election_date, '%m/%d/%Y')::DATE AS election_date,
            {_election_type_sql("h.election_type")} AS type,
            {_voting_method_sql("h.ballot_style")} AS method
        FROM {history_table} AS h
        WHERE {_voter_id_key("h.voter_registration_number")} IN (
            SELECT {_voter_id_key("raw.voter_registration_number")}
            FROM {registration_table} AS raw
            {_where_sql(filter)}
        )
    )
)
WHERE election_date IS NOT NULL AND type IS NOT NULL AND method IS NOT NULL
GROUP BY ALL
"""


def ga_history_batch_query(votes_table: str, batches: int, batch: int) -> str:
    """SQL grouping one batch of voters' votes into one `voting_history` list."""
    return f"""
SELECT
    voter_id,
    list_transform(
        list_sort(list({{
            'date': strftime(election_date, '%Y-%m-%d'),
            'type': type,
            'method': method
        }})),
        e -> {{'year': CAST(left(e.date, 4) AS INT), 'type': e.type, 'date': e.date, 'method': e.method}}
    )::{VOTING_HISTORY_TYPE} AS voting_history
FROM {votes_table}
WHERE hash(voter_id) % {batches} = {batch}
GROUP BY voter_id
"""


def ga_transformation_query(
    registration_table: str,
    history_table: str,
    filter: ImportFilter | None = None,
) -> str:
    """SQL mapping the raw Georgia voter-list table, joined to grouped history,
    to the Person schema."""
    county_fips = {code: fips for code, (_, fips) in GA_COUNTIES.items()}
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
        nullif(raw.residence_street_number, ''),
        nullif(raw.residence_pre_direction, ''),
        nullif(raw.residence_street_name, ''),
        nullif(raw.residence_street_type, ''),
        nullif(raw.residence_post_direction, '')
    ) AS address_line_1,
    raw.residence_apt_unit_number AS address_line_2,
    CAST(NULL AS VARCHAR) AS half_code,
    raw.residence_city AS city,
    'GA' AS state,
    left(regexp_replace(raw.residence_zipcode, '[^0-9]', '', 'g'), 5) AS zip5,
    CAST(NULL AS VARCHAR) AS zip4,
    {_case_from_map("raw.gender", GA_GENDERS)} AS gender,
    {_case_from_map("raw.race", GA_RACES)} AS race,
    CASE
        WHEN regexp_full_match(raw.birth_year, '[0-9]{{4}}')
        THEN raw.birth_year || '-01-01'
    END AS date_of_birth,
    {_timestamp_date_sql("raw.registration_date")} AS registration_date,
    {_case_from_map("raw.status", GA_REGISTRATION_STATUSES, default="unknown")} AS registration_status,
    {_timestamp_date_sql("raw.last_vote_date")} AS last_voted_date,
    {_case_from_map("raw.last_party_voted", GA_LAST_PARTIES)} AS last_party_voted,
    raw.county AS county_code,
    {_case_from_map(county_key, county_fips)} AS county_fips,
    CASE
        WHEN raw.county_precinct IS NULL THEN NULL
        ELSE raw.county || '-' || raw.county_precinct
    END AS precinct,
    raw.congressional_district AS congressional_district,
    raw.state_senate_district AS senate_district,
    raw.state_house_district AS house_district,
    raw.county_commission_district AS county_commission_district,
    raw.city_council_district AS city_council_district,
    raw.municipality AS municipality,
    coalesce(history.voting_history, CAST([] AS {VOTING_HISTORY_TYPE})) AS voting_history
FROM {registration_table} AS raw
LEFT JOIN {history_table} AS history
  ON history.voter_id = {_voter_id_key("raw.voter_registration_number")}
{_where_sql(filter)}
"""
