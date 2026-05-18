"""Curated voter-file transformation queries.

Each transformation maps a state/source-specific raw voter-file schema onto
the canonical `Person` schema (see `src/models.py`). The mapping decides
which raw fields land at the top level vs. inside ``other_properties``.

Curation rule: anything that's a filter primitive in the admin UI's
`OTHER_PROPERTY_KEYS` (apps/web/src/lib/voter-properties.ts) goes into
``other_properties``. Anything not used downstream stays out — we can
always re-add later without a schema change.

The same transformation is used both by tests (via
``apps/data/tests/test_hamilton_graphs.py``) and by the eventual
``seed-persons`` CLI command. Importing rather than duplicating keeps them
in lockstep.
"""

from __future__ import annotations


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
    -- Curated set: matches the filterable keys exposed by the admin UI's
    -- filters catalog. Native rendering picks its own subset. `party` is
    -- renamed from NYS's `enrollment` so the key matches the filter UI's
    -- vocabulary.
    --
    -- `ad_ed` is a derived composite of (assembly_district, election_district)
    -- in NYC's canonical "AA-EEE" form (e.g. "23-001"). Bare ED is
    -- meaningless without AD — ED numbers like 4 or 51 repeat across
    -- assembly districts — so the filter UI exposes `ad_ed` as the
    -- single field people actually mean when they say "ED 23-001".
    -- The raw `assembly_district` and `election_district` are kept
    -- alongside for any consumer that wants them.
    to_json({{
        party: raw.enrollment,
        gender: raw.gender,
        date_of_birth: raw.date_of_birth,
        county_code: raw.county_code,
        status: raw.status,
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
