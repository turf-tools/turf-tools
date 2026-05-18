"""Curated voter-file transformation queries.

Each transformation maps a state/source-specific raw voter-file schema onto
the canonical `Person` schema (see `src/models.py`). State-specific raw
codes are normalized to canonical cross-state labels via the maps defined
in this module.

Curation rule: anything that's a filter primitive in the admin UI's
filters catalog (apps/web/src/lib/voter-properties.ts) goes into
``other_properties``.
"""

from __future__ import annotations

# NYS raw → canonical mappings used by the SQL CASE expressions below.
# Keys are NYS-specific codes; values are cross-state canonical labels.

NYS_REGISTRATION_STATUS_LABELS: dict[str, str] = {
    "A": "active",
    "I": "inactive",
    "AF": "federal_only",
    "17": "preregistered",
}

# NYS encodes party as (enrollment, other_party); flatten the two-step
# into a canonical label.
NYS_ENROLLMENT_LABELS: dict[tuple[str, str | None], str] = {
    ("DEM", None): "democratic",
    ("REP", None): "republican",
    ("CON", None): "conservative",
    ("WOR", None): "working_families",
    ("BLK", None): "unaffiliated",
    ("OTH", "IND"): "independence",
    ("OTH", "Ind"): "independence",
    ("OTH", "GRE"): "green",
    ("OTH", "LBT"): "libertarian",
    ("OTH", "REF"): "reform",
    ("OTH", "OTH"): "other",
    ("OTH", "WEP"): "other",
    ("OTH", "SAM"): "other",
}


def _case_from_map(col: str, mapping: dict[str, str], default: str | None = None) -> str:
    """SQL CASE mapping `col`'s values via `mapping`. `default` is the label for
    unmatched values (None → NULL)."""
    branches = "\n            ".join(
        f"WHEN {col} = '{raw}' THEN '{canonical}'" for raw, canonical in mapping.items()
    )
    else_clause = "NULL" if default is None else f"'{default}'"
    return f"CASE\n            {branches}\n            ELSE {else_clause}\n        END"


def _enrollment_case_sql() -> str:
    """SQL CASE resolving NY's (enrollment, other_party) two-step into a
    canonical party label. Unmatched `OTH` + other_party values fall back
    to `other`."""
    pairs_by_enrollment: dict[str, list[tuple[str | None, str]]] = {}
    for (enr, other), canonical in NYS_ENROLLMENT_LABELS.items():
        pairs_by_enrollment.setdefault(enr, []).append((other, canonical))

    parts: list[str] = []
    for enr, pairs in pairs_by_enrollment.items():
        if enr == "OTH":
            inner_branches = "\n                ".join(
                f"WHEN raw.other_party = '{op}' THEN '{canonical}'"
                for op, canonical in pairs
            )
            parts.append(
                f"WHEN raw.enrollment = 'OTH' THEN CASE\n"
                f"                {inner_branches}\n"
                f"                ELSE 'other'\n"
                f"            END"
            )
        else:
            assert len(pairs) == 1
            _, canonical = pairs[0]
            parts.append(f"WHEN raw.enrollment = '{enr}' THEN '{canonical}'")

    joined = "\n            ".join(parts)
    return f"CASE\n            {joined}\n            ELSE NULL\n        END"


def _iso_date_sql(col: str) -> str:
    """SQL converting a YYYYMMDD VARCHAR to YYYY-MM-DD. NULL on malformed input."""
    return (
        f"CASE WHEN {col} ~ '^[0-9]{{8}}$' "
        f"THEN substring({col}, 1, 4) || '-' || substring({col}, 5, 2) || '-' || substring({col}, 7, 2) "
        f"ELSE NULL END"
    )


def nys_sboe_transformation_query(
    county_codes: list[str] | None = None,
    zip5_filter: list[str] | None = None,
) -> str:
    """SQL transformation from NYS SBOE raw voter file → Person schema.

    Args:
        county_codes: optional list of NYS BOE county codes (e.g. ``['31']``
            for Manhattan). When provided, the query restricts to those
            counties and to active voters (status = 'A').
        zip5_filter: optional list of residential ZIP5 codes to keep. Used to
            scope dev runs to a small geographic slice.
    """
    where_clauses = []
    if county_codes:
        joined = ", ".join(f"'{c}'" for c in county_codes)
        where_clauses.append(f"raw.county_code IN ({joined})")
        where_clauses.append("raw.status = 'A'")
    if zip5_filter:
        joined = ", ".join(f"'{z}'" for z in zip5_filter)
        where_clauses.append(f"raw.res_zip5 IN ({joined})")
    where = "WHERE " + " AND ".join(where_clauses) if where_clauses else ""

    enrollment_sql = _enrollment_case_sql()

    return f"""
SELECT
    raw.sboe_id AS external_id,
    'ny_sboe' AS external_id_type,
    raw.first_name,
    raw.last_name,
    -- concat_ws skips NULL but emits empty strings as separators-with-blanks,
    -- so wrap every column in nullif(CAST..., '') to convert empty inputs into
    -- NULL. Without this, an empty res_post_direction leaves a trailing space
    -- on address_line_1, and an empty middle field leaves a double space —
    -- both observed at meaningful rates in real SBOE data.
    concat_ws(
        ' ',
        nullif(raw.res_house_number, ''),
        nullif(CAST(raw.res_pre_direction AS VARCHAR), ''),
        nullif(raw.res_street_name, ''),
        nullif(CAST(raw.res_post_direction AS VARCHAR), '')
    ) AS address_line_1,
    CASE
        WHEN raw.res_apartment IS NOT NULL AND raw.res_apartment != ''
        THEN concat_ws(
            ' ',
            nullif(CAST(raw.res_apartment_type AS VARCHAR), ''),
            raw.res_apartment
        )
        ELSE NULL
    END AS address_line_2,
    -- Kept out of address_line_1 so street-name tokenisation doesn't see
    -- the "1/2" digits as match material (they'd cross-match "1st St" /
    -- "2nd St"). Reassembled into the canonical address downstream.
    nullif(CAST(raw.res_half_code AS VARCHAR), '') AS half_code,
    raw.res_city AS city,
    'NY' AS state,
    raw.res_zip5 AS zip5,
    nullif(raw.res_zip4, '') AS zip4,
    -- `voting_history` lands here as a raw string and is parsed into a
    -- structured list by the downstream `persons_voting_history` node.
    -- `ad_ed` is the canonical NYC "AA-EEE" form; bare ED is meaningless
    -- without AD since ED numbers repeat across assembly districts.
    to_json({{
        enrollment: {enrollment_sql},
        gender: raw.gender,
        date_of_birth: {_iso_date_sql('raw.date_of_birth')},
        registration_date: {_iso_date_sql('raw.registration_date')},
        registration_status: {_case_from_map('raw.status', NYS_REGISTRATION_STATUS_LABELS, default='unknown')},
        last_voted_date: {_iso_date_sql('raw.last_voted_date')},
        voting_history: raw.voter_history,
        county_code: raw.county_code,
        election_district: raw.election_district,
        assembly_district: raw.assembly_district,
        ad_ed: lpad(CAST(raw.assembly_district AS VARCHAR), 2, '0')
            || '-' || lpad(CAST(raw.election_district AS VARCHAR), 3, '0'),
        senate_district: raw.senate_district,
        congressional_district: raw.congressional_district
    }}) AS other_properties
FROM raw
{where}
"""
