"""Georgia SOS voter-list raw columns → the `Person` schema plus filterable fields.

Codes and labels come from recent SOS voter-list CSVs (county and statewide).
Georgia does not register party; race/gender arrive spelled out; birth year is
the only age signal (stored as YYYY-01-01 for age-range filters).
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

_FILTER_EXPRESSIONS: dict[str, str] = {
    "residence_zipcode": "left(raw.residence_zipcode, 5)",
}


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


def ga_transformation_query(registration_table: str, filter: ImportFilter | None = None) -> str:
    """SQL mapping the raw Georgia voter-list table to the Person schema."""
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
    raw.municipality AS municipality
FROM {registration_table} AS raw
{_where_sql(filter)}
"""
