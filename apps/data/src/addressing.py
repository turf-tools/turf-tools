"""Street-name handling primitives shared across the geocoding pipeline.

A single home for everything used to tokenize, normalize, and compare
street names — so the rules stay in sync across the voter side
(`persons_decomposed`, `osm_only_matches`), the TIGER side
(`blockface_final`), and the OSM side (`osm_building_lookup`).

Contents:

- `tokenize_street_sql(col)`           — SQL fragment for tokenizing a
                                         lowercase alphanumeric token array
- `GENERIC_STREET_TOKENS`              — non-distinctive tokens to strip
                                         when building canonical_keys
- `EQUIVALENT_TOKEN_GROUPS`            — equivalency groups for the
                                         `address_tokens` table
- `STREET_REWRITES`                    — phrase-level regex rewrites applied
                                         before tokenization (e.g.
                                         "fdr" → "f d r")
"""


def street_rewrite_sql(col: str) -> str:
    """Return a DuckDB SQL expression that lowercases/trims `col` and
    applies all `STREET_REWRITES` patterns in order.

    Use this before tokenizing on any source — voter, TIGER, OSM — so
    every side converges on the same surface form.

    Example::

        SELECT {tokenize_street_sql(street_rewrite_sql("street_name_raw"))} AS tokens
        FROM voters
    """
    expr = f"lower(trim({col}))"
    for pat, rep in STREET_REWRITES:
        pat_sql = pat.replace("'", "''")
        rep_sql = rep.replace("'", "''")
        expr = f"regexp_replace({expr}, '{pat_sql}', '{rep_sql}', 'g')"
    return expr


def canonical_key_sql(tokens_col: str) -> str:
    """SQL fragment producing a `canonical_key` string from a token array.

    Sorts the (already-expanded) tokens and joins them with `|`. No
    stripping: every token participates so parallel-named streets
    ("60 Place", "60 Lane", "60 Street") get distinct keys. After
    `STREET_REWRITES` + equivalency expansion the canonical token set
    is already the same on every source side, so the strict-equality
    `(zip, canonical_key, housenumber_norm)` join still works.

    Stripping generics on top of expansion was the source of a
    Queens-style cross-street collision: any address whose distinctive
    tokens reduced to the same set (e.g. just `["60"]` or
    `["60", "60th"]`) would match an OSM record on a parallel street
    in the same zip with the same housenumber.

    Caller passes whatever token column it already has — typically the
    equivalency-expanded `street_name_tokens` from `blockface_final`,
    or the equivalent expansion built inline for a voter / OSM record.
    """
    return f"array_to_string(list_sort({tokens_col}), '|')"


def tokenize_street_sql(col: str) -> str:
    """Return a DuckDB SQL expression that tokenizes a street-name column.

    Produces a sorted, deduplicated array of lowercase alphanumeric tokens.
    `lower(trim(col))` is materialized three times in the source SQL
    (split on non-alphanumerics, then extract bare digit runs, then
    extract bare letter runs) so unusual punctuation, embedded numerics,
    and run-on letter sequences each get their own bite.

    Caller is responsible for any pre-rewrites (e.g. applying
    `STREET_REWRITES` before tokenizing) — wrap `col` in the rewrite
    expression first.

    Example::

        SELECT {tokenize_street_sql("street_name_raw")} AS tokens
        FROM voters
    """
    return (
        f"list_distinct(list_sort(list_filter("
        f"  list_concat("
        f"    list_concat("
        f"      regexp_split_to_array(lower(trim({col})), '[^a-z0-9]+'),"
        f"      regexp_extract_all(lower(trim({col})), '[0-9]+')"
        f"    ),"
        f"    regexp_extract_all(lower(trim({col})), '\\b[a-z]+')"
        f"  ),"
        f"  x -> length(x) > 0"
        f")))"
    )


# Tokens that don't identify a street — directionals, street-type suffixes,
# and generic words. Two streets sharing only these tokens (e.g. "East 1
# Street" and "East 11 Street" both share `east, street`) are NOT the same
# street, so candidate filtering requires at least one *non*-generic token
# in the overlap.
GENERIC_STREET_TOKENS: list[str] = [
    "e", "east", "w", "west", "n", "north", "s", "south",
    "ne", "northeast", "nw", "northwest", "se", "southeast", "sw", "southwest",
    "st", "street", "ave", "avenue", "av",
    "rd", "road", "dr", "drive",
    "pl", "place", "ct", "court", "ln", "lane",
    "blvd", "boulevard", "sq", "square", "ter", "terrace",
    "way", "mews", "saint",
    "pkwy", "parkway", "expy", "expressway", "hwy", "highway",
    "cir", "circle", "loop", "run", "walk", "trail", "path",
    "alley", "aly", "crescent", "cres",
]


# Each inner list is a group of tokens that should be treated as equivalent
# when matching voter address strings against TIGER blockface street names.
# Materialized into the `address_tokens` table by `tiger.address_tokens`.
EQUIVALENT_TOKEN_GROUPS: list[list[str]] = [
    # Cardinal directions
    ["n", "north"],
    ["s", "south"],
    ["e", "east"],
    ["w", "west"],
    ["ne", "northeast"],
    ["nw", "northwest"],
    ["se", "southeast"],
    ["sw", "southwest"],
    ["st", "street", "saint"],
    ["ave", "avenue", "av"],
    ["rd", "road"],
    ["dr", "drive"],
    ["ln", "lane"],
    ["ct", "court"],
    ["pl", "place"],
    ["blvd", "boulevard"],
    ["pkwy", "parkway"],
    ["expy", "expressway"],
    ["hwy", "highway"],
    ["cir", "circle"],
    ["ter", "terrace"],
    ["way"],
    ["sq", "square"],
    ["loop"],
    ["run"],
    ["walk"],
    ["trail"],
    ["path"],
    ["alley", "aly"],
    ["crescent", "cres"],
    ["bend"],
    ["grove"],
    ["hill"],
    ["ridge"],
    ["valley"],
    ["park"],
    ["gardens", "gdns"],
    ["heights", "hts"],
    ["ft", "fort"],
    ["mt", "mount"],
    ["apt", "apartment"],
    ["unit"],
    ["ste", "suite"],
    ["fl", "floor"],
    ["bldg", "building"],
    ["1st", "first"],
    ["2nd", "second"],
    ["3rd", "third"],
    ["4th", "fourth"],
    ["5th", "fifth"],
    ["6th", "sixth"],
    ["7th", "seventh"],
    ["8th", "eighth"],
    ["9th", "ninth"],
    ["10th", "tenth"],
    ["11th", "eleventh"],
    ["12th", "twelfth"],
    ["13th", "thirteenth"],
    ["14th", "fourteenth"],
    ["15th", "fifteenth"],
    ["16th", "sixteenth"],
    ["17th", "seventeenth"],
    ["18th", "eighteenth"],
    ["19th", "nineteenth"],
    ["20th", "twentieth"],
    ["21st", "twenty-first"],
    ["22nd", "twenty-second"],
    ["23rd", "twenty-third"],
    ["30th", "thirtieth"],
    ["40th", "fortieth"],
    ["50th", "fiftieth"],
    ["60th", "sixtieth"],
    ["70th", "seventieth"],
    ["80th", "eightieth"],
    ["90th", "ninetieth"],
    ["100th", "one-hundredth"],
]


# Phrase-level regex rewrites applied to street strings before tokenization.
# Convention: normalize toward TIGER's surface form so all sources (OSM,
# voter file) converge on the same tokens after `tokenize_street_sql`.
#
# Add an entry when you see voters falling back to `tiger_only` or
# `osm_only` on a specific named street where multiple spellings exist
# (FDR / Franklin D Roosevelt / F D R; JFK / John F Kennedy; etc.).
STREET_REWRITES: list[tuple[str, str]] = [
    # FDR Drive: OSM uses "FDR Drive", "Fdr Drive Service Road West/East";
    # rare full-name variants "Franklin D Roosevelt Drive" / "Franklin
    # Delano Roosevelt Drive" also collapse to the same form.
    (r"\bfdr\b", "f d r"),
    (r"\bfranklin\s+d(?:elano)?\s+roosevelt\b", "f d r"),
]
