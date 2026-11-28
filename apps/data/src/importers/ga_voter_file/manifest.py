"""The Georgia voter-list field manifest: filterable fields a Georgia import
produces, in the sections the segment and zone editors render."""

from __future__ import annotations

from src.importers.base import EnumValue, FieldDef, Manifest
from src.importers.ga_voter_file.transform import GA_COUNTIES


def _enum(value: str, label: str) -> EnumValue:
    return EnumValue(value=value, label=label)


GA_MANIFEST = Manifest(
    fields=[
        [
            FieldDef(column="first_name", label="First Name", filter_kind="text"),
            FieldDef(column="last_name", label="Last Name", filter_kind="text"),
            FieldDef(key="address", label="Address", filter_kind="address"),
            FieldDef(
                column="zip5",
                label="Zip Code",
                filter_kind="text-multi",
                key_group="ga_zips",
                key_group_label="ZIP codes",
            ),
            FieldDef(
                column="county_code",
                label="County",
                filter_kind="enum",
                values=[_enum(code, name) for code, (name, _) in sorted(GA_COUNTIES.items(), key=lambda c: c[1][0])],
            ),
            FieldDef(
                column="gender",
                label="Gender",
                filter_kind="enum",
                values=[
                    _enum("M", "Male"),
                    _enum("F", "Female"),
                    _enum("X", "X"),
                    _enum("U", "Unknown"),
                ],
            ),
            FieldDef(
                column="race",
                label="Race",
                filter_kind="enum",
                values=[
                    _enum("american_indian_alaskan_native", "American Indian"),
                    _enum("asian_pacific_islander", "Asian or Pacific Islander"),
                    _enum("black", "Black"),
                    _enum("hispanic", "Hispanic/Latino"),
                    _enum("white", "White"),
                    _enum("other", "Other"),
                    _enum("unknown", "Unknown"),
                ],
            ),
            FieldDef(column="year_of_birth", label="Age", filter_kind="age-range"),
        ],
        [
            FieldDef(
                column="precinct",
                label="Precinct",
                filter_kind="text-multi",
                key_group="ga_precincts",
                key_group_label="Precincts",
            ),
            FieldDef(column="house_district", label="House District", filter_kind="text-multi"),
            FieldDef(column="senate_district", label="Senate District", filter_kind="text-multi"),
            FieldDef(
                column="congressional_district",
                label="Congressional District",
                filter_kind="text-multi",
            ),
            FieldDef(
                column="county_commission_district",
                label="County Commission District",
                filter_kind="text-multi",
            ),
            FieldDef(
                column="city_council_district",
                label="City Council District",
                filter_kind="text-multi",
            ),
            FieldDef(column="municipality", label="Municipality", filter_kind="text-multi"),
        ],
        [
            FieldDef(column="registration_date", label="Registration Date", filter_kind="date-range"),
            FieldDef(
                column="registration_status",
                label="Registration Status",
                filter_kind="enum",
                values=[_enum("active", "Active"), _enum("inactive", "Inactive"), _enum("unknown", "Unknown")],
            ),
            FieldDef(column="last_voted_date", label="Last Voted", filter_kind="date-range"),
            FieldDef(
                column="last_party_voted",
                label="Last Party Voted",
                filter_kind="enum",
                values=[
                    _enum("democratic", "Democrat"),
                    _enum("republican", "Republican"),
                    _enum("non_partisan", "Non-Partisan"),
                    _enum("none", "None"),
                ],
            ),
            FieldDef(
                column="voting_history",
                key="voting_history_count",
                label="Voting History Count",
                filter_kind="voting-history-count",
            ),
            FieldDef(
                column="voting_history",
                key="voting_history_detail",
                label="Voting History Detail",
                filter_kind="voting-history-detail",
            ),
        ],
    ]
)
