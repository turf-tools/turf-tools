"""Address-handling primitives shared across the geocoding pipeline.

A single home for the SQL fragments and lookup tables used to tokenize,
normalize, and compare street names and house numbers — so the rules
stay in sync across the voter side (`persons_decomposed`,
`osm_only_matches`), the TIGER side (`blockface_final`), and the OSM
side (`osm_building_lookup`).

Each public helper is a callable that returns a SQL fragment. Callers
embed the fragment in their own queries — no Python-side data movement.

Contents:

- `street_rewrite_sql(col)`           — apply `STREET_REWRITES` to a column
- `tokenize_street_sql(col)`          — tokenize a street name string
- `canonical_key_sql(tokens_col)`     — sort/join tokens for OSM lookup
- `housenumber_norm_sql(col)`         — normalize a house-number string for join keys
- `housenumber_display_sql(prefix, num, half)`
                                      — assemble a human-readable house-number string
- `GENERIC_STREET_TOKENS`             — tokens treated as non-distinctive by
                                         the candidate-matching predicate
- `EQUIVALENT_TOKEN_GROUPS`           — synonym groups loaded into the
                                         `address_tokens` table
- `STREET_REWRITES`                   — phrase rewrites applied uniformly
                                         to every source before tokenization
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

    Sorts the (already-expanded) tokens and joins them with `|`. Every
    token participates — no stripping. After `STREET_REWRITES` +
    equivalency expansion, every source side produces the same token
    set for the same street, so the strict-equality
    `(zip, canonical_key, housenumber_norm)` join works.

    Including every token (rather than dropping "generic" suffixes
    like `place`, `lane`, `avenue`) keeps parallel-named streets
    distinct: "60 Place" and "60 Lane" produce different keys, so a
    voter on one doesn't accidentally match an OSM building on the
    other in the same zip with the same housenumber.

    Caller passes whatever token column it already has — typically
    the equivalency-expanded `street_name_tokens` from
    `blockface_final`, or the equivalent expansion built inline for a
    voter / OSM record.
    """
    return f"array_to_string(list_sort({tokens_col}), '|')"


def housenumber_norm_sql(col: str) -> str:
    """SQL fragment producing the normalized house-number form for join keys.

    Two passes:
      1. Strip leading zeros immediately after `^` or `-` so zero-padded
         forms (`132-01`, `9-02`) collapse to (`132-1`, `9-2`).
      2. Strip all hyphens so hyphenated and unhyphenated notations
         (`132-1` / `1321`, `6-46` / `646`) collapse to the same string.

    Used on both sides of every `(zip, canonical_key, housenumber_norm)`
    join so voters and OSM records agree regardless of which surface
    form was stored.
    """
    return (
        f"regexp_replace("
        f"  regexp_replace({col}, '(^|-)0*([0-9])', '\\1\\2', 'g'),"
        f"  '-', '', 'g'"
        f")"
    )


def housenumber_display_sql(prefix_col: str, number_col: str, half_col: str) -> str:
    """SQL fragment producing the human-readable house-number string.

    Concatenates `prefix || number || ' ' || half_code` (omitting the
    space + half_code when there's no half-code). This is the string
    used in `address_line_1` for display and `building_id` derivation,
    not for joins.

    `prefix_col` and `half_col` are coalesced to `''` so NULLs don't
    poison the concat; `number_col` is cast to VARCHAR.
    """
    return (
        f"COALESCE({prefix_col}, '') || CAST({number_col} AS VARCHAR)"
        f" || CASE WHEN {half_col} IS NOT NULL AND {half_col} != ''"
        f"         THEN ' ' || {half_col} ELSE '' END"
    )


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
