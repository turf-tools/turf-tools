"""Quickwit client — per-version person index creation + search.

The data server is the only thing that talks to Quickwit (web/native route
through it). Bulk indexing writes via the CLI `local-ingest` (see
`dags/quickwit.py`) sharing a Postgres metastore; this module owns the HTTP side:
creating the per-version index on the searcher and querying it.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from src.settings import Settings

# Index mapping template; `index_id` is swapped per dataset version.
_INDEX_TEMPLATE = Path(__file__).resolve().parent.parent / "quickwit" / "persons.yaml"

# Stored fields returned for a person hit (everything in the mapping).
PERSON_FIELDS = (
    "external_id",
    "external_id_type",
    "first_name",
    "last_name",
    "address_line_1",
    "address_line_2",
    "city",
    "state",
    "zip5",
    "zip4",
)


def persons_index_id(schema: str) -> str:
    """The Quickwit index for a dataset version, named off its lake schema so it's
    unique per version (e.g. `persons_new_york_city_voter_file_v7`)."""
    return f"persons_{schema}"


# Quickwit query-language characters that must be escaped inside a term.
_QUERY_SPECIAL = set(r'+-&|!(){}[]^"~*?:\/ ')


def _escape_term(term: str) -> str:
    return "".join(f"\\{ch}" if ch in _QUERY_SPECIAL else ch for ch in term)


def _prefix_clause(field: str, value: str) -> str | None:
    """AND of prefix matches over the value's whitespace tokens, so typing part
    of a name/address matches (`free` → `freeman`). None if the value is blank."""
    tokens = [t for t in re.split(r"\s+", value.strip()) if t]
    if not tokens:
        return None
    return " AND ".join(f"{field}:{_escape_term(tok)}*" for tok in tokens)


def build_person_query(
    *,
    first_name: str = "",
    last_name: str = "",
    address: str = "",
    city: str = "",
    zip5: str = "",
    external_id: str = "",
) -> str:
    """Build a Quickwit query from the Lookup form's filled fields, AND-ed
    together. Name/address are prefix-matched (partial); zip and id are exact.
    Returns "" when nothing is filled (caller should short-circuit to empty)."""
    clauses: list[str] = []
    for field, value in (
        ("first_name", first_name),
        ("last_name", last_name),
        ("address_line_1", address),
        ("city", city),
    ):
        clause = _prefix_clause(field, value)
        if clause:
            clauses.append(f"({clause})")
    if zip5.strip():
        clauses.append(f"zip5:{_escape_term(zip5.strip())}")
    if external_id.strip():
        clauses.append(f"external_id:{_escape_term(external_id.strip())}")
    return " AND ".join(clauses)


def _request(method: str, url: str, data: bytes | None = None, content_type: str | None = None) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=data, method=method)
    if content_type:
        req.add_header("content-type", content_type)
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 — internal service URL
        return resp.status, resp.read()


def ensure_index(settings: Settings, index_id: str) -> None:
    """Create a fresh per-version index on the running Quickwit node via its REST
    control plane (index management must go through the node, not a competing
    standalone `index create` process). The node serves the same metastore
    `local-ingest` writes to, so create + ingest agree — provided the searcher
    runs with the same config (`quickwit run --config quickwit/node.yaml`).

    Delete-then-create makes it idempotent: the batched local-ingest *appends*,
    so a re-build must start from an empty index."""
    try:
        _request("DELETE", f"{settings.quickwit_url}/api/v1/indexes/{index_id}")
    except urllib.error.HTTPError as exc:
        if exc.code != 404:  # 404 = didn't exist yet, which is fine
            raise RuntimeError(f"quickwit: delete index {index_id!r} failed ({exc.code})") from exc
    mapping = _INDEX_TEMPLATE.read_text(encoding="utf-8").replace("index_id: persons", f"index_id: {index_id}")
    try:
        _request("POST", f"{settings.quickwit_url}/api/v1/indexes", mapping.encode("utf-8"), "application/yaml")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"quickwit: create index {index_id!r} failed ({exc.code}): {body}") from exc


def search(
    settings: Settings,
    index_id: str,
    query: str,
    max_hits: int = 20,
    start_offset: int = 0,
    sort_by: str | None = None,
) -> dict[str, Any]:
    """Search a version's index. Returns ``{numHits, hits: [{...person fields}]}``.
    A missing index (nothing indexed for that version yet) returns empty rather
    than erroring. ``sort_by`` is a Quickwit sort spec over one or two fast fields
    (comma-separated); omit for relevance order. Note 0.8.2's direction is
    inverted from the newer docs: ``-field`` ascends, bare/``+field`` descends."""
    query_params: dict[str, Any] = {"query": query, "max_hits": max_hits, "start_offset": start_offset}
    if sort_by:
        query_params["sort_by"] = sort_by
    params = urllib.parse.urlencode(query_params)
    url = f"{settings.quickwit_url}/api/v1/{index_id}/search?{params}"
    try:
        _status, body = _request("GET", url)
    except urllib.error.HTTPError as exc:
        # 404/405 = index not built yet; 400 = unparseable query → treat as no results.
        if exc.code in (400, 404, 405):
            return {"numHits": 0, "hits": []}
        raise RuntimeError(f"quickwit: search {index_id!r} failed ({exc.code})") from exc
    parsed = json.loads(body)
    hits = [{field: hit.get(field) for field in PERSON_FIELDS} for hit in parsed.get("hits", [])]
    return {"numHits": parsed.get("num_hits", 0), "hits": hits}
