"""Unit tests for the voting-history parser and canonical-label maps."""

from src.transformations import NYS_ENROLLMENT_LABELS, NYS_REGISTRATION_STATUS_LABELS
from src.voting_history import (
    ELECTION_TYPE_LABELS,
    VOTING_METHOD_LABELS,
    parse_entry,
    parse_voting_history,
)


# ---------------------------------------------------------------------------
# parse_entry — strict patterns
# ---------------------------------------------------------------------------


def test_parse_entry_modern_format():
    """The dominant `YYYYMMDD CODE(STATUS)` format produces full record."""
    assert parse_entry("20221108 GE(P)") == {
        "year": 2022,
        "type": "general",
        "date": "2022-11-08",
        "method": "poll_site",
    }


def test_parse_entry_modern_all_election_codes():
    """Every documented two-letter election code maps to a canonical type."""
    cases = [
        ("20221108 GE(P)", "general"),
        ("20220628 PR(E)", "primary"),
        ("20200623 PP(A)", "presidential_primary"),
        ("20190226 SP(P)", "special"),
        ("20131001 RO(P)", "runoff"),
    ]
    for entry, expected_type in cases:
        result = parse_entry(entry)
        assert result is not None, entry
        assert result["type"] == expected_type, entry


def test_parse_entry_modern_all_method_codes():
    """Every documented one-letter voting-method code maps to a canonical label."""
    cases = [
        ("20221108 GE(P)", "poll_site"),
        ("20201103 GE(E)", "early_voting"),
        ("20221108 GE(A)", "absentee"),
        ("20141104 GE(F)", "affidavit"),
        ("20241105 GE(M)", "military"),
        ("20161108 GE(O)", "other"),
    ]
    for entry, expected_method in cases:
        result = parse_entry(entry)
        assert result is not None, entry
        assert result["method"] == expected_method, entry


def test_parse_entry_code_first_format():
    """`CODE YYYYMMDD(STATUS)` format (some county feeds use it)."""
    assert parse_entry("GE 20201103(A)") == {
        "year": 2020,
        "type": "general",
        "date": "2020-11-03",
        "method": "absentee",
    }


# ---------------------------------------------------------------------------
# parse_entry — loose fallback
# ---------------------------------------------------------------------------


def test_parse_entry_legacy_long_form_year_only():
    """Pre-2007 entries have a description + year but no full date."""
    result = parse_entry("General Election 2004(P)")
    assert result == {
        "year": 2004,
        "type": "general",
        "date": None,
        "method": "poll_site",
    }


def test_parse_entry_legacy_long_comma_separator():
    """Some legacy entries use a comma between description and year."""
    result = parse_entry("General Election, 2003(P)")
    assert result is not None
    assert result["year"] == 2003
    assert result["type"] == "general"
    assert result["date"] is None


def test_parse_entry_year_first_form():
    """`YYYY DESCRIPTION(STATUS)` — observed in a small fraction of feeds."""
    result = parse_entry("2016 GENERAL ELECTION(P)")
    assert result is not None
    assert result["year"] == 2016
    assert result["type"] == "general"


def test_parse_entry_two_digit_year_prefix():
    """Truncated 2-digit-year prefixes are expanded via SBOE-realistic pivot (0-26 → 2000s)."""
    result = parse_entry("24 GENERAL(A)")
    assert result is not None
    assert result["year"] == 2024
    assert result["type"] == "general"
    assert result["method"] == "absentee"


def test_parse_entry_classifier_picks_specific_over_general():
    """A description containing both 'presidential primary' and 'primary' resolves to presidential_primary."""
    result = parse_entry("Presidential Primary Election 2016(P)")
    assert result is not None
    assert result["type"] == "presidential_primary"


# ---------------------------------------------------------------------------
# parse_entry — failure modes
# ---------------------------------------------------------------------------


def test_parse_entry_no_year_returns_none():
    """Entries with no year anywhere (e.g. some county data quality issues) are dropped."""
    assert parse_entry("PRES PRIMARY ELECTION(P)") is None
    assert parse_entry("GENERAL ELECTION(P)") is None


def test_parse_entry_empty_returns_none():
    assert parse_entry("") is None
    assert parse_entry("   ") is None


def test_parse_entry_unknown_election_code_returns_none():
    """A strict-pattern entry with an unrecognized code (e.g. '??') is dropped."""
    assert parse_entry("20080205 ??(P)") is None


def test_parse_entry_unknown_method_code_buckets_to_other():
    """Method codes outside the documented set are bucketed as 'other' rather than dropped."""
    # 'D' and 'T' are observed in 1M sample with no documented meaning.
    result = parse_entry("20221108 GE(D)")
    assert result is not None
    assert result["method"] == "other"


# ---------------------------------------------------------------------------
# parse_voting_history — full-string parsing
# ---------------------------------------------------------------------------


def test_parse_voting_history_empty_inputs():
    """NULL or empty strings produce an empty list, not an error."""
    assert parse_voting_history(None) == []
    assert parse_voting_history("") == []


def test_parse_voting_history_splits_on_semicolons():
    result = parse_voting_history("20221108 GE(P);20220628 PR(P)")
    assert len(result) == 2
    assert result[0]["year"] == 2022 and result[0]["type"] == "general"
    assert result[1]["year"] == 2022 and result[1]["type"] == "primary"


def test_parse_voting_history_multi_primary_year():
    """NY ran two primaries in 2022 (state-local + federal). Both entries are preserved."""
    vh = "20221108 GE(P);20220823 PR(P);20220628 PR(P)"
    result = parse_voting_history(vh)
    primaries = [e for e in result if e["type"] == "primary" and e["year"] == 2022]
    assert len(primaries) == 2
    dates = {e["date"] for e in primaries}
    assert dates == {"2022-08-23", "2022-06-28"}


def test_parse_voting_history_mixes_modern_and_legacy():
    """A single voter's history can mix modern (full date) and legacy (year-only) entries."""
    vh = "20221108 GE(P);General Election 2004(P)"
    result = parse_voting_history(vh)
    assert len(result) == 2
    modern, legacy = result
    assert modern["date"] == "2022-11-08"
    assert legacy["date"] is None and legacy["year"] == 2004


def test_parse_voting_history_drops_unparseable_silently():
    """Unparseable entries are dropped; the rest still come through."""
    vh = "20221108 GE(P);PRES PRIMARY ELECTION(P);20210622 PR(P)"
    result = parse_voting_history(vh)
    assert len(result) == 2
    assert all(e["year"] in {2021, 2022} for e in result)


# ---------------------------------------------------------------------------
# Canonical label maps
# ---------------------------------------------------------------------------


def test_election_type_label_values_are_canonical_set():
    """Sanity-check the canonical labels don't drift from the documented enum."""
    assert set(ELECTION_TYPE_LABELS.values()) == {
        "general",
        "primary",
        "presidential_primary",
        "special",
        "runoff",
    }


def test_voting_method_label_values_are_canonical_set():
    assert set(VOTING_METHOD_LABELS.values()) == {
        "poll_site",
        "early_voting",
        "absentee",
        "affidavit",
        "military",
        "other",
    }


def test_registration_status_known_codes():
    assert NYS_REGISTRATION_STATUS_LABELS["A"] == "active"
    assert NYS_REGISTRATION_STATUS_LABELS["I"] == "inactive"
    assert NYS_REGISTRATION_STATUS_LABELS["AF"] == "federal_only"
    assert NYS_REGISTRATION_STATUS_LABELS["17"] == "preregistered"


def test_enrollment_top_level_codes():
    """Top-level NYS enrollment codes resolve without the OTH+other_party two-step."""
    assert NYS_ENROLLMENT_LABELS[("DEM", None)] == "democratic"
    assert NYS_ENROLLMENT_LABELS[("REP", None)] == "republican"
    assert NYS_ENROLLMENT_LABELS[("CON", None)] == "conservative"
    assert NYS_ENROLLMENT_LABELS[("WOR", None)] == "working_families"
    assert NYS_ENROLLMENT_LABELS[("BLK", None)] == "unaffiliated"


def test_enrollment_oth_resolves_to_specific_parties():
    """`OTH` + `other_party` resolves to specific cross-state-portable labels."""
    assert NYS_ENROLLMENT_LABELS[("OTH", "IND")] == "independence"
    assert NYS_ENROLLMENT_LABELS[("OTH", "Ind")] == "independence"  # case variant
    assert NYS_ENROLLMENT_LABELS[("OTH", "GRE")] == "green"
    assert NYS_ENROLLMENT_LABELS[("OTH", "LBT")] == "libertarian"
    assert NYS_ENROLLMENT_LABELS[("OTH", "REF")] == "reform"


def test_enrollment_defunct_ny_only_parties_bucket_to_other():
    """WEP and SAM are NY-only defunct ballot lines; bucketed to 'other'."""
    assert NYS_ENROLLMENT_LABELS[("OTH", "WEP")] == "other"
    assert NYS_ENROLLMENT_LABELS[("OTH", "SAM")] == "other"
