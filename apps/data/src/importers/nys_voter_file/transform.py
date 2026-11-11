"""Curated voter-file transformation queries.

Each transformation maps a state/source-specific raw voter-file schema onto
the `Person` required core (see `src/models.py`) plus the dataset's filterable
fields. State-specific raw codes are normalized to canonical cross-state values
via the maps defined in this module.

Every field — the Person core and each filterable extra (enrollment, dates,
districts, …) — is a typed top-level column; the importer's manifest describes
which are filterable. There is no catch-all JSON blob.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from src.importers.dedupe import one_record_per_id_sql

if TYPE_CHECKING:
    from src.importers.base import ImportFilter

# NYS raw → canonical mappings used by the SQL CASE expressions below.
# Keys are NYS-specific codes, mapped to their cross-state canonical values.

NYS_REGISTRATION_STATUSES: dict[str, str] = {
    "A": "active",
    "I": "inactive",
    "AF": "federal_only",
    "17": "preregistered",
}

# NYS BOE county code → 5-digit county FIPS (state 36 + county), so the
# geo extent loads each voter's own county. BOE codes run alphabetically
# with St. Lawrence after Seneca; FIPS files it as "Saint", before Saratoga.
NYS_COUNTY_FIPS: dict[str, str] = {
    "01": "36001", "02": "36003", "03": "36005", "04": "36007", "05": "36009", "06": "36011",
    "07": "36013", "08": "36015", "09": "36017", "10": "36019", "11": "36021", "12": "36023",
    "13": "36025", "14": "36027", "15": "36029", "16": "36031", "17": "36033", "18": "36035",
    "19": "36037", "20": "36039", "21": "36041", "22": "36043", "23": "36045", "24": "36047",
    "25": "36049", "26": "36051", "27": "36053", "28": "36055", "29": "36057", "30": "36059",
    "31": "36061", "32": "36063", "33": "36065", "34": "36067", "35": "36069", "36": "36071",
    "37": "36073", "38": "36075", "39": "36077", "40": "36079", "41": "36081", "42": "36083",
    "43": "36085", "44": "36087", "45": "36091", "46": "36093", "47": "36095", "48": "36097",
    "49": "36099", "50": "36089", "51": "36101", "52": "36103", "53": "36105", "54": "36107",
    "55": "36109", "56": "36111", "57": "36113", "58": "36115", "59": "36117", "60": "36119",
    "61": "36121", "62": "36123",
}  # fmt: skip

# NYS encodes party as (ENROLLMENT, OTHERPARTY); flatten the two-step
# into a canonical label.
NYS_ENROLLMENTS: dict[tuple[str, str | None], str] = {
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
    branches = "\n            ".join(f"WHEN {col} = '{raw}' THEN '{canonical}'" for raw, canonical in mapping.items())
    else_clause = "NULL" if default is None else f"'{default}'"
    return f"CASE\n            {branches}\n            ELSE {else_clause}\n        END"


def _enrollment_case_sql() -> str:
    """SQL CASE resolving NY's (ENROLLMENT, OTHERPARTY) two-step into a
    canonical party label. Unmatched `OTH` + OTHERPARTY values fall back
    to `other`."""
    pairs_by_enrollment: dict[str, list[tuple[str | None, str]]] = {}
    for (enr, other), canonical in NYS_ENROLLMENTS.items():
        pairs_by_enrollment.setdefault(enr, []).append((other, canonical))

    parts: list[str] = []
    for enr, pairs in pairs_by_enrollment.items():
        if enr == "OTH":
            inner_branches = "\n                ".join(
                f"WHEN raw.otherparty = '{op}' THEN '{canonical}'" for op, canonical in pairs
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


# A voter who changes county keeps their statewide SBOEID and gets a new county
# registration, and an export can hold both. Keep the current one: active over
# inactive, then the latest registration. (Purged records are dropped on read.)
_CURRENT_RECORD_FIRST = "CASE WHEN r.status = 'I' THEN 1 ELSE 0 END, r.regdate DESC NULLS LAST, r.countycode"


def nys_sboe_transformation_query(
    source_table: str,
    filter: ImportFilter | None = None,
) -> str:
    """SQL transformation from NYS SBOE raw voter file → Person schema.

    Args:
        source_table: fully-qualified `persons_raw` table the query reads from,
            narrowed to one record per voter and aliased to ``raw`` so the column
            expressions below resolve.
        filter: optional row filter (`raw.<column> IN (values)`), the dataset's
            fixed import slice, applied after a voter's current record is
            picked. The column must already be allowlisted by the importer;
            values are compared as the file's own text.
    """
    where = ""
    if filter and filter.values:
        joined = ", ".join("'" + v.replace("'", "''") + "'" for v in filter.values)
        where = f"WHERE raw.{filter.column} IN ({joined})"

    enrollment_sql = _enrollment_case_sql()

    return f"""
SELECT
    raw.sboeid AS external_id,
    'ny_sboe' AS external_id_type,
    raw.firstname AS first_name,
    raw.lastname AS last_name,
    nullif(raw.middlename, '') AS middle_name,
    nullif(raw.namesuffix, '') AS name_suffix,
    -- concat_ws skips NULL but emits empty strings as separators-with-blanks,
    -- so wrap every column in nullif(CAST..., '') to convert empty inputs into
    -- NULL. Without this, an empty rpostdirection leaves a trailing space
    -- on address_line_1, and an empty middle field leaves a double space —
    -- both observed at meaningful rates in real SBOE data.
    concat_ws(
        ' ',
        nullif(raw.raddnumber, ''),
        nullif(CAST(raw.rpredirection AS VARCHAR), ''),
        nullif(raw.rstreetname, ''),
        nullif(CAST(raw.rpostdirection AS VARCHAR), '')
    ) AS address_line_1,
    CASE
        WHEN raw.rapartment IS NOT NULL AND raw.rapartment != ''
        THEN concat_ws(
            ' ',
            nullif(CAST(raw.rapartmenttype AS VARCHAR), ''),
            raw.rapartment
        )
        ELSE NULL
    END AS address_line_2,
    -- Kept out of address_line_1 so street-name tokenisation doesn't see
    -- the "1/2" digits as match material (they'd cross-match "1st St" /
    -- "2nd St"). Reassembled into the canonical address downstream.
    nullif(CAST(raw.rhalfcode AS VARCHAR), '') AS half_code,
    raw.rcity AS city,
    'NY' AS state,
    raw.rzip5 AS zip5,
    nullif(raw.rzip4, '') AS zip4,
    -- Canonical voter-file scalars. Top-level columns so filters on them
    -- hit Parquet column pruning + Bloom filters.
    {enrollment_sql} AS enrollment,
    raw.gender AS gender,
    {_iso_date_sql("raw.dob")} AS date_of_birth,
    {_iso_date_sql("raw.regdate")} AS registration_date,
    {_case_from_map("raw.status", NYS_REGISTRATION_STATUSES, default="unknown")} AS registration_status,
    {_iso_date_sql("raw.lastvoterdate")} AS last_voted_date,
    raw.countycode AS county_code,
    {_case_from_map("raw.countycode", NYS_COUNTY_FIPS)} AS county_fips,
    -- `precinct` is the smallest political unit. NYC uses the
    -- "AA-EEE" assembly+election composite; a bare ED is
    -- meaningless across assembly districts.
    (lpad(CAST(raw.ad AS VARCHAR), 2, '0')
        || '-' || lpad(CAST(raw.ed AS VARCHAR), 3, '0')) AS precinct,
    raw.ad AS assembly_district,
    raw.sd AS senate_district,
    raw.cd AS congressional_district,
    -- Transient raw column; the importer's load parses it into the structured
    -- `voting_history` STRUCT[] and drops it.
    raw.voterhistory AS voter_history
FROM {one_record_per_id_sql(source_table, "sboeid", _CURRENT_RECORD_FIRST)} AS raw
{where}
"""
