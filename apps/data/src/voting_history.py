"""Voting-history parsing and canonical-label maps.

The parser handles the NYS SBOE `voter_history` column's five legacy
formats. The label maps normalize state-specific raw codes to canonical
cross-state labels; `transformations.py` consumes them to generate SQL
CASE expressions.
"""

from __future__ import annotations

import re

ELECTION_TYPE_LABELS: dict[str, str] = {
    "GE": "general",
    "PR": "primary",
    "PP": "presidential_primary",
    "SP": "special",
    "RO": "runoff",
}

VOTING_METHOD_LABELS: dict[str, str] = {
    "P": "poll_site",
    "E": "early_voting",
    "A": "absentee",
    "F": "affidavit",
    "M": "military",
    "O": "other",
}


_RE_MODERN = re.compile(r"^(\d{8})\s+([A-Z]{1,4})\(([A-Z])\)$")
_RE_CODE_FIRST = re.compile(r"^([A-Z]{1,4})\s+(\d{8})\(([A-Z])\)$")
_RE_TRAILING_STATUS = re.compile(r"^(.*)\(([A-Za-z])\)$")
_RE_YEAR_4 = re.compile(r"(?<!\d)((?:19|20)\d{2})(?!\d)")
_RE_YEAR_2_PREFIX = re.compile(r"^(\d{2})(?!\d)")


def _classify_description(desc: str) -> str | None:
    d = desc.lower()
    if "presidential primary" in d or "pres primary" in d:
        return "presidential_primary"
    if "runoff" in d or "run-off" in d:
        return "runoff"
    if "special" in d:
        return "special"
    if "primary" in d:
        return "primary"
    if "general" in d:
        return "general"
    return None


def _expand_two_digit_year(y: int) -> int:
    # SBOE-realistic pivot: 0-26 → 2000s, else 1900s.
    return 2000 + y if y <= 26 else 1900 + y


def _yyyymmdd_to_iso(date: str | None) -> str | None:
    return f"{date[:4]}-{date[4:6]}-{date[6:8]}" if date else None


def parse_entry(entry: str) -> dict | None:
    """Parse one voter_history entry. Returns dict with year/type/date/method, or None."""
    entry = entry.strip()
    if not entry:
        return None

    if m := _RE_MODERN.match(entry):
        date, code, method = m.groups()
        etype = ELECTION_TYPE_LABELS.get(code)
        if etype is None:
            return None
        return {
            "year": int(date[:4]),
            "type": etype,
            "date": _yyyymmdd_to_iso(date),
            "method": VOTING_METHOD_LABELS.get(method, "other"),
        }

    if m := _RE_CODE_FIRST.match(entry):
        code, date, method = m.groups()
        etype = ELECTION_TYPE_LABELS.get(code)
        if etype is None:
            return None
        return {
            "year": int(date[:4]),
            "type": etype,
            "date": _yyyymmdd_to_iso(date),
            "method": VOTING_METHOD_LABELS.get(method, "other"),
        }

    m = _RE_TRAILING_STATUS.match(entry)
    if not m:
        return None
    body, method_raw = m.groups()
    method_raw = method_raw.upper()

    if ym := _RE_YEAR_4.search(body):
        year = int(ym.group(1))
    elif ym := _RE_YEAR_2_PREFIX.match(body):
        year = _expand_two_digit_year(int(ym.group(1)))
    else:
        return None

    etype = _classify_description(body)
    if etype is None:
        return None

    return {
        "year": year,
        "type": etype,
        "date": None,
        "method": VOTING_METHOD_LABELS.get(method_raw, "other"),
    }


def parse_voting_history(raw: str | None) -> list[dict]:
    """Parse a semicolon-separated voter_history string into a list of
    structured entries. Unparseable entries are silently dropped."""
    if not raw:
        return []
    out: list[dict] = []
    for token in raw.split(";"):
        p = parse_entry(token.strip())
        if p is not None:
            out.append(p)
    return out
