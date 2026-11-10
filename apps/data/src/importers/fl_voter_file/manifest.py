"""The Florida voter-file field manifest: the filterable fields a Florida
import produces, in the sections the segment and zone editors render."""

from __future__ import annotations

from src.importers.base import EnumValue, FieldDef, Manifest
from src.importers.fl_voter_file.transform import FL_COUNTIES


def _enum(value: str, label: str) -> EnumValue:
    return EnumValue(value=value, label=label)


FL_MANIFEST = Manifest(
    fields=[
        # Identity + demographics
        [
            FieldDef(column="first_name", label="First Name", filter_kind="text"),
            FieldDef(column="last_name", label="Last Name", filter_kind="text"),
            FieldDef(key="address", label="Address", filter_kind="address"),
            FieldDef(
                column="zip5",
                label="Zip Code",
                filter_kind="text-multi",
                key_group="fl_zips",
                key_group_label="ZIP codes",
            ),
            FieldDef(
                column="county_code",
                label="County",
                filter_kind="enum",
                values=[_enum(code, name) for code, (name, _) in sorted(FL_COUNTIES.items(), key=lambda c: c[1][0])],
            ),
            FieldDef(
                column="gender",
                label="Gender",
                filter_kind="enum",
                values=[_enum("M", "Male"), _enum("F", "Female"), _enum("U", "Unknown")],
            ),
            FieldDef(
                column="race",
                label="Race",
                filter_kind="enum",
                values=[
                    _enum("american_indian_alaskan_native", "American Indian or Alaskan Native"),
                    _enum("asian_pacific_islander", "Asian or Pacific Islander"),
                    _enum("black", "Black, not Hispanic"),
                    _enum("hispanic", "Hispanic"),
                    _enum("white", "White, not Hispanic"),
                    _enum("multiracial", "Multi-racial"),
                    _enum("other", "Other"),
                    _enum("unknown", "Unknown"),
                ],
            ),
            FieldDef(column="date_of_birth", label="Age", filter_kind="age-range"),
        ],
        # Contact
        [
            FieldDef(column="phone", label="Phone", filter_kind="phone"),
            FieldDef(column="email", label="Email", filter_kind="email"),
        ],
        # Geographic divisions — precinct is the `fl_precincts` boundary key.
        # Precincts carry their county (`DAD-135`).
        [
            FieldDef(
                column="precinct",
                label="Precinct",
                filter_kind="text-multi",
                key_group="fl_precincts",
                key_group_label="Precincts",
            ),
            FieldDef(column="house_district", label="House District", filter_kind="text-multi"),
            FieldDef(column="senate_district", label="Senate District", filter_kind="text-multi"),
            FieldDef(column="congressional_district", label="Congressional District", filter_kind="text-multi"),
        ],
        # Voter behavior
        [
            FieldDef(
                column="enrollment",
                label="Party",
                filter_kind="enum",
                values=[
                    _enum("democratic", "Democratic"),
                    _enum("republican", "Republican"),
                    _enum("unaffiliated", "No Party Affiliation"),
                    _enum("independent", "Independent Party"),
                    _enum("libertarian", "Libertarian"),
                    _enum("green", "Green"),
                    _enum("conservative", "Conservative"),
                    _enum("other", "Other"),
                ],
            ),
            FieldDef(column="registration_date", label="Registration Date", filter_kind="date-range"),
            FieldDef(
                column="registration_status",
                label="Registration Status",
                filter_kind="enum",
                values=[_enum("active", "Active"), _enum("inactive", "Inactive"), _enum("unknown", "Unknown")],
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
