"""Address-handling primitives shared across the geocoding pipeline.

A single home for the SQL fragments and lookup tables used to tokenize,
normalize, and compare street names and house numbers — so the rules
stay in sync across the voter side (`persons_decomposed`,
`osm_only_matches`), the TIGER side (`blockface_final`), and the OSM
side (`osm_addresses_keyed`).

Each public helper is a callable that returns a SQL fragment. Callers
embed the fragment in their own queries — no Python-side data movement.

Contents:

- `street_rewrite_sql(col)`           — apply `STREET_REWRITES` to a column
- `tokenize_street_sql(col)`          — tokenize a street name string
- `canonical_key_sql(tokens_col)`     — sort/join tokens for OSM lookup
- `housenumber_norm_sql(col)`         — normalize a house-number string for join keys
- `housenumber_display_sql(prefix, num, half)`
                                      — assemble a human-readable house-number string
- `unit_label_sql(col)`               — a unit line's standard spelling, which is
                                         also its door identity
- `ordinal_tokens_sql(tokens_col)`    — the ordinal form of each bare-number token
- `GENERIC_STREET_TOKENS`             — tokens treated as non-distinctive by
                                         the candidate-matching predicate
- `EQUIVALENT_TOKEN_GROUPS`           — synonym groups loaded into the
                                         `address_tokens` table
- `STREET_REWRITES`                   — phrase rewrites applied uniformly
                                         to every source before tokenization
- `UNIT_TYPE_WORDS`, `UNIT_WORDS`, `UNIT_SYNONYMS`, `UNIT_DIRECTIONS`
                                      — the word tables `unit_label_sql` reads
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
    set for the same street, so the strict-equality joins on
    `(canonical_key, housenumber_norm)` work (`src/osm_lookup.py`).

    Including every token (rather than dropping "generic" suffixes
    like `place`, `lane`, `avenue`) keeps parallel-named streets
    distinct: "60 Place" and "60 Lane" produce different keys, so a
    voter on one doesn't accidentally match an OSM building on the
    other in the same zip with the same housenumber.

    Caller passes whatever token column it already has — typically
    `blockface_final.street_tokens_lookup` on the voter side, or an
    inline equivalency expansion on the OSM side.
    """
    return f"array_to_string(list_sort({tokens_col}), '|')"


def housenumber_norm_sql(col: str) -> str:
    """SQL fragment producing the normalized house-number form for join keys.

    Two passes:
      1. Strip leading zeros immediately after `^` or `-` so zero-padded
         forms (`132-01`, `9-02`) collapse to (`132-1`, `9-2`).
      2. Strip all hyphens so hyphenated and unhyphenated notations
         (`132-1` / `1321`, `6-46` / `646`) collapse to the same string.

    Used on both sides of every `(canonical_key, housenumber_norm)`
    join so voters and OSM records agree regardless of which surface
    form was stored.
    """
    return f"regexp_replace(  regexp_replace({col}, '(^|-)0*([0-9])', '\\1\\2', 'g'),  '-', '', 'g')"


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


def unit_label_sql(col: str) -> str:
    """SQL fragment: a unit line (`address_line_2`) in its standard spelling,
    which is both what a door displays and what makes two voters' units the
    same door. Periods and slashes separate words (`BSMT.`, `BSMT/1`); stray
    leading punctuation and a leading type word go, and a number glued to a
    type word is that number (`APT 3B`, `#3B`, `NUM 3B` → `3B`; `1UNIT` → `1`;
    the display adds "Apt" back to a bare code); abbreviations take one spelling
    (`UNIT_SYNONYMS`); a direction next to a code takes its letter (`PH EAST`
    → `PH E`); unit words stand apart from what they label (`4FL`, `FRNT1`,
    `PHA`); a floor drops its ordinal; codes come after the words they belong
    to (`4TH FL` → `FL 4`, `8B NORTH TOWER` → `NORTH TOWER 8B`); and a code's
    pieces join across a space or hyphen (`6 D`, `6-D` → `6D`). A word is a
    unit word, a type word, or any four or more letters; anything else is a
    code. Spaces, hyphens, periods and slashes between two numbers stay: `2 2`
    and `22` can be different units, and `1/2` is a fraction. NULL when blank.

    The rules run twice: moving words to the front can expose a type word or
    a glued unit word for the earlier steps. Two passes settle every unit in
    the NYS and Florida files this was built from (a third changes nothing)."""
    return _unit_label_pass_sql(_unit_label_pass_sql(col))


def _unit_label_pass_sql(col: str) -> str:
    """One pass of the rules `unit_label_sql` runs."""
    types = "|".join(UNIT_TYPE_WORDS)
    words = "|".join(sorted(UNIT_WORDS, key=len, reverse=True))
    synonyms = [a for alts in UNIT_SYNONYMS.values() for a in alts]
    # `AP` stays out: in `1AP` it's more likely a code than "apartment 1".
    glued_types = [t for t in UNIT_TYPE_WORDS if t != "AP"]
    spellings = "|".join(sorted({*UNIT_WORDS, *synonyms, *glued_types}, key=len, reverse=True))
    ordinal = "(ST|ND|RD|TH)"
    e = f"upper(trim({col}))"
    # A period or slash separates words (`BSMT.`, `BSMT/1`) except inside a number (`1/2`).
    e = f"regexp_replace({e}, '([^0-9])[./]', '\\1 ', 'g')"
    e = f"regexp_replace({e}, '[./]([^0-9])', ' \\1', 'g')"
    e = f"regexp_replace(trim({e}), '\\s+', ' ', 'g')"
    e = f"regexp_replace({e}, '^[^0-9A-Z#]+', '')"
    e = f"regexp_replace({e}, '^#\\s*', '')"
    for _ in range(2):  # `NUM NUM 1`
        e = f"regexp_replace({e}, '^({types})[.#:\\s-]+', '')"
        e = f"regexp_replace({e}, '^({types})([0-9])', '\\2')"
    # Glued to one letter (`UNITB`, `APTG2`); `UNITED` and a bare `APTO` stay.
    e = f"regexp_replace({e}, '^UNIT([A-Z])([^A-Z]|$)', '\\1\\2')"
    e = f"regexp_replace({e}, '^APT([A-NP-Z])([^A-Z]|$)', '\\1\\2')"
    e = f"regexp_replace({e}, '([0-9])-([A-Z])', '\\1\\2', 'g')"
    e = f"regexp_replace({e}, '([A-Z])-([0-9A-Z])', '\\1\\2', 'g')"
    # A number glued to any spelling of a unit word (`4FLR`), so the renaming
    # below sees the word; renaming runs before the word-first splits, which
    # would otherwise read `FLR` as `FL` plus a letter.
    e = f"regexp_replace({e}, '([0-9]){ordinal}?({spellings})([^A-Z]|$)', '\\1\\2 \\3\\4', 'g')"
    for canon, alts in UNIT_SYNONYMS.items():
        e = f"regexp_replace({e}, '(^|[^A-Z])({'|'.join(alts)})([^A-Z]|$)', '\\1{canon}\\3', 'g')"
    # A direction next to a code takes its letter (`PH EAST`, `EAST 304`); one
    # that names a wing (`SOUTH TOWER`) or stands alone stays a word.
    for letter, word in UNIT_DIRECTIONS.items():
        e = f"regexp_replace({e}, '(^|[^A-Z]){word}( ?[0-9])', '\\1{letter}\\2', 'g')"
        e = f"regexp_replace({e}, '([^A-Z]){word}$', '\\1{letter}')"
    e = f"regexp_replace({e}, '(^|[^A-Z])({words})([0-9])', '\\1\\2 \\3', 'g')"
    e = f"regexp_replace({e}, '(^|[^A-Z])({words})([A-Z])([^A-Z0-9]|$)', '\\1\\2 \\3\\4', 'g')"
    # A floor drops its ordinal, written glued, spaced, or bare (`4TH FL`, `4 TH FL`, `4TH`).
    e = f"regexp_replace({e}, '(^|[^A-Z0-9])([0-9]+) ?{ordinal} FL([^A-Z]|$)', '\\1\\2 FL\\4', 'g')"
    e = f"regexp_replace({e}, '^([0-9]+) ?{ordinal}$', '\\1 FL')"
    # Leading codes move after the words (`4 FL` → `FL 4`), before a code's pieces join,
    # so `806 TOWER B` and `TOWER B 806` both become `TOWER B806`.
    known = ", ".join(f"'{w}'" for w in sorted({*UNIT_WORDS, *UNIT_TYPE_WORDS}))
    is_word = f"(list_contains([{known}], t) OR regexp_matches(t, '^[A-Z]{{4,}}$'))"
    e = (
        f"list_transform([string_split({e}, ' ')], ts -> CASE"
        f" WHEN list_position(list_transform(ts, t -> {is_word}), true) > 1"
        f" THEN array_to_string(list_concat("
        f"ts[list_position(list_transform(ts, t -> {is_word}), true):],"
        f" ts[:list_position(list_transform(ts, t -> {is_word}), true) - 1]), ' ')"
        f" ELSE array_to_string(ts, ' ') END)[1]"
    )
    e = f"regexp_replace({e}, '(^| )([0-9]+) ([A-Z])( |$)', '\\1\\2\\3\\4', 'g')"
    e = f"regexp_replace({e}, '(^| )([A-Z]) ([0-9]+)( |$)', '\\1\\2\\3\\4', 'g')"
    # With words in front, two letters after a number are a code (`2 RR`).
    e = f"regexp_replace({e}, '^([0-9]+) ([A-Z]{{2}})$', '\\1\\2')"
    return f"nullif(trim(regexp_replace({e}, ' +', ' ', 'g')), '')"


def ordinal_tokens_sql(tokens_col: str) -> str:
    """SQL fragment: the ordinal form of each bare-number token in a token
    array (`98` → `98th`, `1` → `1st`, `112` → `112th`), for street names
    written without the ordinal ("WEST 127 STREET" vs OSM's "West 127th
    Street")."""
    # The suffix reads the last digits as text, so a number of any length works.
    return (
        f"list_transform(list_filter({tokens_col}, t -> regexp_matches(t, '^[0-9]+$')),"
        f" t -> t || CASE WHEN regexp_matches(t, '1[123]$') THEN 'th'"
        f" WHEN right(t, 1) = '1' THEN 'st' WHEN right(t, 1) = '2' THEN 'nd'"
        f" WHEN right(t, 1) = '3' THEN 'rd' ELSE 'th' END)"
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
    "e",
    "east",
    "w",
    "west",
    "n",
    "north",
    "s",
    "south",
    "ne",
    "northeast",
    "nw",
    "northwest",
    "se",
    "southeast",
    "sw",
    "southwest",
    "st",
    "street",
    "ave",
    "avenue",
    "av",
    "rd",
    "road",
    "dr",
    "drive",
    "pl",
    "place",
    "ct",
    "court",
    "ln",
    "lane",
    "blvd",
    "boulevard",
    "sq",
    "square",
    "ter",
    "terrace",
    "way",
    "mews",
    "saint",
    "pkwy",
    "parkway",
    "expy",
    "expressway",
    "hwy",
    "highway",
    "cir",
    "circle",
    "loop",
    "run",
    "walk",
    "trail",
    "path",
    "alley",
    "aly",
    "crescent",
    "cres",
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


# Words that only say a unit line names a unit, dropped when they lead it:
# `APT 3B`, `NUM 3B`, `UNIT 3B` and `3B` are one apartment.
UNIT_TYPE_WORDS: list[str] = ["APARTMENT", "APTO", "APT", "AP", "NUM", "UNIT"]

# Words that say what kind of unit it is, kept apart from the number or letter
# they label: the USPS secondary unit designators plus voter-file forms, with
# FRONT spelled out because it reads better than FRNT.
UNIT_WORDS: list[str] = [
    "BLDG",
    "BOX",
    "BSMT",
    "DEPT",
    "FL",
    "FRONT",
    "GARDEN",
    "GRND",
    "GROUND",
    "HNGR",
    "HSE",
    "KEY",
    "LBBY",
    "LOT",
    "LOWR",
    "OFC",
    "PH",
    "PIER",
    "PVT",
    "REAR",
    "RM",
    "SIDE",
    "SLIP",
    "SPC",
    "STE",
    "STOP",
    "SUPT",
    "TOP",
    "TOWER",
    "TRLR",
    "UPPR",
    "WING",
]

# Spellings of one unit word found side by side in the same buildings of the
# NYS and Florida voter files, or misspelled there, each mapped to one form.
UNIT_SYNONYMS: dict[str, list[str]] = {
    "FL": ["FLR", "FLOOR"],
    "BSMT": [
        "BASEMENT",
        "BSMNT",
        "BASMT",
        "BSM",
        "BMT",
        "BST",
        "BSTM",
        "BAS",
        "BASE",
        "BASM",
        "BASEM",
        "BASMENT",
        "BASEMET",
        "BASEMEN",
        "BASEMNT",
        "BASEMT",
        "BMST",
        "BSMENT",
        "BMNT",
        "BAMT",
    ],
    "GARDEN": ["GRDN", "GDN"],
    "PH": ["PENTHOUSE"],
    "BLDG": ["BUILDING", "BLD", "BLG"],
    "FRONT": ["FRNT", "FRT"],
    "RM": ["ROOM"],
    "STE": ["SUITE"],
    "PVT": ["PRIVATE", "PRVT", "PRIV", "PRV"],
    "SUPT": ["SUP", "SUPER", "SUPR"],
    "LOWR": ["LOWER", "LWR"],
    "UPPR": ["UPPER"],
    "TOWER": ["TWR"],
}

# Directions, which take their letter next to a code so "PH EAST" reads like
# its neighbours "PH W" and "1E".
UNIT_DIRECTIONS: dict[str, str] = {"E": "EAST", "W": "WEST", "N": "NORTH", "S": "SOUTH"}
