"""The NYS voter-file field manifest.

This is the relocation of what was hardcoded and duplicated across
`apps/web/src/lib/filters.ts` (`FILTER_SECTIONS`) and `dsl/criteria.py`
(`FIELDS` + `KEY_GROUPS`) — the filterable fields a NYS voter file produces,
now owned by the importer that produces them. System filters (`all`,
`canvass-outcome`, `canvass-response`, `segment`) are dataset-independent and
live outside the manifest.

Not yet consumed for compilation — the editor + SQL compiler still read the
legacy catalogs until they're switched over to the manifest (that's the
manifest-consumption chunk). Defined here now to co-locate the fields with
their importer and validate the model against the real NYS field set.
"""

from __future__ import annotations

from src.importers.base import EnumValue, FieldDef, Manifest


def _enum(value: str, label: str) -> EnumValue:
    return EnumValue(value=value, label=label)


NYS_MANIFEST = Manifest(
    fields=[
        # Identity + demographics
        FieldDef(column="first_name", label="First name", filter_kind="text", op="contains"),
        FieldDef(column="last_name", label="Last name", filter_kind="text", op="contains"),
        FieldDef(column="address", label="Address", filter_kind="address"),
        # zip5 doubles as the `nyc_zips` boundary key (derivable from the address,
        # so any geocoded dataset can zone by zip).
        FieldDef(column="zip5", label="Zip Code", filter_kind="code-multi", key_group="nyc_zips"),
        FieldDef(
            column="county_code",
            label="County",
            filter_kind="enum",
            # Field is canonical; values are NYS-local (5 BOE county codes → boroughs).
            values=[
                _enum("03", "Bronx"),
                _enum("24", "Kings"),
                _enum("31", "New York"),
                _enum("41", "Queens"),
                _enum("43", "Richmond"),
            ],
        ),
        FieldDef(
            column="gender",
            label="Gender",
            filter_kind="enum",
            values=[_enum("M", "Male"), _enum("F", "Female"), _enum("U", "Unknown")],
        ),
        # A date column carrying the birthdate role → an age (number) filter.
        FieldDef(column="date_of_birth", label="Age", filter_kind="number", role="birthdate"),
        # Geographic divisions — precinct is the `nyc_eds` boundary key.
        FieldDef(column="precinct", label="Precinct", filter_kind="code-multi", key_group="nyc_eds"),
        FieldDef(column="assembly_district", label="Assembly District", filter_kind="code-multi"),
        FieldDef(column="senate_district", label="Senate District", filter_kind="code-multi"),
        FieldDef(column="congressional_district", label="Congressional District", filter_kind="code-multi"),
        # Voter behavior
        FieldDef(
            column="enrollment",
            label="Party",
            filter_kind="enum",
            values=[
                _enum("democratic", "Democratic"),
                _enum("republican", "Republican"),
                _enum("conservative", "Conservative"),
                _enum("working_families", "Working Families"),
                _enum("unaffiliated", "Unaffiliated"),
                _enum("independence", "Independence"),
                _enum("green", "Green"),
                _enum("libertarian", "Libertarian"),
                _enum("reform", "Reform"),
                _enum("other", "Other"),
            ],
        ),
        FieldDef(column="registration_date", label="Registration Date", filter_kind="date"),
        FieldDef(
            column="registration_status",
            label="Registration Status",
            filter_kind="enum",
            values=[
                _enum("active", "Active"),
                _enum("inactive", "Inactive"),
                _enum("federal_only", "Federal-only"),
                _enum("preregistered", "Pre-registered"),
                _enum("unknown", "Unknown"),
            ],
        ),
        FieldDef(column="voting_history", label="Voting History", filter_kind="voting-history"),
    ]
)
