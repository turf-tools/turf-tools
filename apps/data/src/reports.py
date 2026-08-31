"""Row-level canvass reports: five tables over the attempt grain.

Each report is a ReportSpec — the composed SQL for its `report`
relation plus its column list, sort allowlist, and day-picker source —
built by one function per kind and rendered by the shared preview and
export helpers. Reduction semantics live in src.canvass_events; this
module is presentation assembly: voter-file lookups, generated
question columns, summaries. The summary always groups the same
`report` relation as the table, so the two can't disagree.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from src.canvass_events import (
    EventScope,
    attempt_days_sql,
    attempts_cte,
    canvasser_stats_sql,
    event_scope,
    walk_stats_sql,
)
from src.duckdb import OPERATIONAL_PG_ALIAS, materialize
from src.models import EXPORT_COLUMNS, EXPORT_OPTIONAL
from src.timing import timed

if TYPE_CHECKING:
    import duckdb

PAGE_ROWS = 100


@dataclass
class ReportCtx:
    """Per-request inputs shared by every spec builder."""

    org_slug: str
    campaign_ids: list[str] | None
    day: str | None
    tz: str
    persons: str
    voter_cols: list[str]
    person_cols: list[str]
    id_cols: list[str]
    scope: EventScope


def build_ctx(
    conn: duckdb.DuckDBPyConnection,
    persons: str,
    org_slug: str,
    campaign_ids: list[str] | None,
    day: str | None,
    tz: str,
) -> ReportCtx:
    persons_columns = {row[0] for row in conn.execute(f"DESCRIBE {persons}").fetchall()}
    # Skip only optional-and-absent; a missing required column stays in
    # the SELECT and fails loudly at bind time.
    voter_cols = [c for c in EXPORT_COLUMNS if c in persons_columns or c not in EXPORT_OPTIONAL]
    # Readable columns lead and the ids trail, so the CSV opens on name
    # and address rather than external ids.
    id_cols = [c for c in voter_cols if c in ("external_id", "external_id_type")]
    person_cols = [c for c in voter_cols if c not in ("external_id", "external_id_type")]
    return ReportCtx(
        org_slug=org_slug,
        campaign_ids=campaign_ids,
        day=day,
        tz=tz,
        persons=persons,
        voter_cols=voter_cols,
        person_cols=person_cols,
        id_cols=id_cols,
        scope=event_scope(org_slug, campaign_ids, day=day, tz=tz),
    )


@dataclass
class ReportSpec:
    """One report's composed SQL and its presentation contract. body_sql
    reads the `attempts` temp table its builder materialized and ends
    with a `report` CTE; params bind it in text order."""

    body_sql: str
    params: list
    columns: list[str]
    default_order: str
    sortable: dict[str, list[str]]
    days_sql: str
    days_params: list
    question_columns: list[str] = field(default_factory=list)


def _pop_cols_sql(ctx: ReportCtx) -> str:
    return f"pop_cols AS (SELECT {', '.join(ctx.voter_cols)} FROM {ctx.persons})"


def _shared_cols(ctx: ReportCtx) -> str:
    return ", ".join(f"p.{c}" for c in ctx.voter_cols)


def _event_days(attempts: str, tz: str) -> tuple[str, list]:
    return attempt_days_sql(attempts), [tz]


def _materialize_attempts(conn: duckdb.DuckDBPyConnection, ctx: ReportCtx) -> str:
    """One event-log reduction per request: the attempt grain lands in a
    temp table every later statement reads by the returned name, instead
    of each re-running the Postgres scan and persons join as a CTE
    prefix. Always the full campaign scope — date selection happens on
    the reduced attempts (see attempts_cte), and the day picker reads
    this relation."""
    with timed("query"):
        return materialize(
            conn,
            "attempts",
            f"{attempts_cte(ctx.persons, '', ctx.scope.base_filters)} SELECT * FROM attempts",
            [*ctx.scope.base_params, ctx.tz],
        )


def _dated_attempts(conn: duckdb.DuckDBPyConnection, ctx: ReportCtx, attempts: str) -> str:
    """The day chip selects among finished attempts by their timestamp —
    a cheap temp-to-temp cut, not a re-reduction."""
    if not ctx.day:
        return attempts
    with timed("query"):
        return materialize(
            conn,
            "attempts_dated",
            f"SELECT * FROM {attempts} WHERE (created_at AT TIME ZONE ?)::DATE = ?::DATE",
            [ctx.tz, ctx.day],
        )


def _question_pivot(
    conn: duckdb.DuckDBPyConnection,
    org_slug: str,
    chain_sql: str,
    chain_params: list,
    rel: str,
    key: str,
) -> tuple[str, str, list[str]]:
    """Generated per-question columns over `rel` (which must expose `key`
    and `responses`). Org-pinned: a foreign question id in a payload
    never becomes a column. Returns the pivot CTEs, the quoted column
    refs to splice into the report SELECT, and the display labels."""
    question_ids = [
        r[0]
        for r in conn.execute(
            chain_sql
            + f"""
            SELECT DISTINCT q.question_id
            FROM {rel}, UNNEST(json_keys(responses)) AS q(question_id)
            """,
            chain_params,
        ).fetchall()
    ]
    questions: list[tuple[str, str]] = []
    if question_ids:
        questions = conn.execute(
            f"""
            SELECT q.question_id::VARCHAR, q.name
            FROM {OPERATIONAL_PG_ALIAS}.app.questions q
            JOIN {OPERATIONAL_PG_ALIAS}.app.organizations org
                ON org.organization_id = q.organization_id
            WHERE org.slug = ? AND q.question_id::VARCHAR IN (SELECT unnest(?))
            ORDER BY q.created_at, q.question_id
            """,
            [org_slug, question_ids],
        ).fetchall()
    pivot_aggs: list[str] = []
    labels: list[str] = []
    label_counts: dict[str, int] = {}
    for qid, name in questions:
        n = label_counts.get(name, 0)
        label_counts[name] = n + 1
        label = f"{name} ({n + 1})" if n else name
        labels.append(label)
        alias = label.replace('"', '""')
        qid_lit = qid.replace("'", "''")
        pivot_aggs.append(
            f"string_agg(answer, '; ' ORDER BY option_order NULLS LAST) "
            f"FILTER (WHERE question_id = '{qid_lit}') AS \"{alias}\""
        )
    pivot_sql = "".join(f", {a}" for a in pivot_aggs)
    join_cols = "".join(f', qp."{label.replace(chr(34), chr(34) * 2)}"' for label in labels)
    cte_sql = f""",
        answer_rows AS (
            SELECT r.{key} AS pivot_key, q.question_id, o.option_id,
                   CAST(NULL AS VARCHAR) AS text_answer
            FROM {rel} r,
                 UNNEST(json_keys(r.responses)) AS q(question_id),
                 UNNEST(CAST(json_extract(r.responses,
                     '$."' || q.question_id || '".optionIds') AS VARCHAR[])) AS o(option_id)
            UNION ALL
            SELECT r.{key}, q.question_id, CAST(NULL AS VARCHAR),
                   json_extract_string(r.responses, '$."' || q.question_id || '".text')
            FROM {rel} r, UNNEST(json_keys(r.responses)) AS q(question_id)
            WHERE coalesce(json_extract_string(r.responses,
                '$."' || q.question_id || '".text'), '') <> ''
        ),
        labeled AS (
            SELECT ar.pivot_key, ar.question_id,
                   coalesce(ro.text, ar.option_id, ar.text_answer) AS answer,
                   ro."order" AS option_order
            FROM answer_rows ar
            LEFT JOIN {OPERATIONAL_PG_ALIAS}.app.response_options ro
                ON ro.response_option_id::VARCHAR = ar.option_id
                AND ro.question_id::VARCHAR = ar.question_id
        ),
        qp AS (
            SELECT pivot_key{pivot_sql}
            FROM labeled
            GROUP BY pivot_key
        )
    """
    return cte_sql, join_cols, labels


_PERSON_SORTS = {
    "name": ["last_name", "first_name"],
    "address": ["address_line_1"],
    "external_id": ["external_id"],
}
_PLACE_SORTS = {"turf": ["turf"], "zone": ["zone"], "campaign": ["campaign"]}


def people_spec(conn: duckdb.DuckDBPyConnection, ctx: ReportCtx) -> ReportSpec:
    """One row per attempted person's current state — the latest
    attempt's snapshot, so this and the attempt grain reconcile — with
    attempt-count rollups and generated question columns."""
    attempts_all = _materialize_attempts(conn, ctx)
    attempts = _dated_attempts(conn, ctx, attempts_all)
    chain = f"""
        WITH current AS (
            SELECT * FROM {attempts}
            QUALIFY row_number() OVER (
                PARTITION BY person_id ORDER BY sequence DESC
            ) = 1
        )"""
    pivot_cte, pivot_cols, question_columns = _question_pivot(conn, ctx.org_slug, chain, [], "current", "person_id")
    body_sql = (
        chain
        + pivot_cte
        + f""",
        person_stats AS (
            SELECT person_id,
                   count(*) AS attempts,
                   count(*) FILTER (WHERE outcome = 'canvassed') AS contacts,
                   strftime(max(created_at) FILTER (WHERE outcome = 'canvassed')
                       AT TIME ZONE ?, '%Y-%m-%d %H:%M') AS last_contact_at
            FROM {attempts} GROUP BY person_id
        ),
        {_pop_cols_sql(ctx)},
        report AS (
            SELECT {_shared_cols(ctx)},
                   cur.outcome AS last_outcome, ps.attempts, ps.contacts{pivot_cols},
                   strftime(cur.created_at AT TIME ZONE ?, '%Y-%m-%d %H:%M')
                       AS last_attempt_at,
                   ps.last_contact_at,
                   cur.campaign,
                   cur.created_at, cur.sequence
            FROM current cur
            JOIN pop_cols p ON p.external_id = cur.person_id
            JOIN person_stats ps ON ps.person_id = cur.person_id
            LEFT JOIN qp ON qp.pivot_key = cur.person_id
        )"""
    )
    days_sql, days_params = _event_days(attempts_all, ctx.tz)
    # No turf/zone: they'd be the latest attempt's — event detail, not
    # person state (the Attempts report answers "where"). Campaign stays:
    # in the all-campaigns view it labels which pass's truth — and which
    # script's answers — the row carries.
    return ReportSpec(
        body_sql=body_sql,
        params=[ctx.tz, ctx.tz],
        columns=[
            *ctx.person_cols,
            "attempts",
            "contacts",
            "last_attempt_at",
            "last_contact_at",
            "last_outcome",
            *question_columns,
            "campaign",
            *ctx.id_cols,
        ],
        default_order="created_at DESC, sequence DESC",
        sortable={
            **_PERSON_SORTS,
            "attempts": ["attempts"],
            "contacts": ["contacts"],
            "last_attempt_at": ["created_at"],
            "last_contact_at": ["last_contact_at"],
            "last_outcome": ["last_outcome"],
            "campaign": ["campaign"],
        },
        days_sql=days_sql,
        days_params=days_params,
        question_columns=question_columns,
    )


def attempts_spec(conn: duckdb.DuckDBPyConnection, ctx: ReportCtx) -> ReportSpec:
    """One row per attempt, with the attempt's own snapshot pivoted into
    the generated question columns."""
    attempts_all = _materialize_attempts(conn, ctx)
    attempts = _dated_attempts(conn, ctx, attempts_all)
    pivot_cte, pivot_cols, question_columns = _question_pivot(conn, ctx.org_slug, "", [], attempts, "sequence")
    body_sql = (
        f"WITH {_pop_cols_sql(ctx)}"
        + pivot_cte
        + f""",
        report AS (
            SELECT {_shared_cols(ctx)},
                   a.outcome, a.canvasser_name AS canvasser{pivot_cols},
                   strftime(a.created_at AT TIME ZONE ?, '%Y-%m-%d %H:%M')
                       AS attempted_at,
                   a.turf_name AS turf, a.zone_name AS zone, a.campaign,
                   a.walk_id, a.created_at, a.sequence
            FROM {attempts} a
            JOIN pop_cols p ON p.external_id = a.person_id
            LEFT JOIN qp ON qp.pivot_key = a.sequence
        )"""
    )
    days_sql, days_params = _event_days(attempts_all, ctx.tz)
    return ReportSpec(
        body_sql=body_sql,
        params=[ctx.tz],
        columns=[
            "attempted_at",
            "outcome",
            "canvasser",
            *ctx.person_cols,
            *question_columns,
            "turf",
            "zone",
            "campaign",
            *ctx.id_cols,
            "walk_id",
        ],
        default_order="created_at DESC, sequence DESC",
        sortable={
            **_PERSON_SORTS,
            **_PLACE_SORTS,
            "outcome": ["outcome"],
            "canvasser": ["canvasser"],
            "attempted_at": ["created_at"],
        },
        days_sql=days_sql,
        days_params=days_params,
        question_columns=question_columns,
    )


def responses_spec(conn: duckdb.DuckDBPyConnection, ctx: ReportCtx) -> ReportSpec:
    """One row per answer per canvassed attempt — the history grain.
    Question labels are pinned to the event's own org."""
    attempts_all = _materialize_attempts(conn, ctx)
    attempts = _dated_attempts(conn, ctx, attempts_all)
    body_sql = f"""
        WITH answer_rows AS (
            SELECT a.*, q.question_id, o.option_id,
                   CAST(NULL AS VARCHAR) AS text_answer
            FROM {attempts} a,
                 UNNEST(json_keys(a.responses)) AS q(question_id),
                 UNNEST(CAST(json_extract(a.responses,
                     '$."' || q.question_id || '".optionIds') AS VARCHAR[])) AS o(option_id)
            WHERE a.outcome = 'canvassed'
            UNION ALL
            SELECT a.*, q.question_id, CAST(NULL AS VARCHAR),
                   json_extract_string(a.responses, '$."' || q.question_id || '".text')
            FROM {attempts} a, UNNEST(json_keys(a.responses)) AS q(question_id)
            WHERE a.outcome = 'canvassed'
              AND coalesce(json_extract_string(a.responses,
                  '$."' || q.question_id || '".text'), '') <> ''
        ),
        {_pop_cols_sql(ctx)},
        report AS (
            SELECT {_shared_cols(ctx)},
                   coalesce(qq.name, ar.question_id) AS question,
                   coalesce(ro.text, ar.option_id, ar.text_answer) AS answer,
                   ar.canvasser_name AS canvasser,
                   strftime(ar.created_at AT TIME ZONE ?, '%Y-%m-%d %H:%M')
                       AS contacted_at,
                   ar.turf_name AS turf, ar.zone_name AS zone, ar.campaign,
                   ar.question_id, ar.option_id, ar.created_at, ar.sequence,
                   qq.created_at AS question_created, ro."order" AS option_order
            FROM answer_rows ar
            JOIN pop_cols p ON p.external_id = ar.person_id
            LEFT JOIN {OPERATIONAL_PG_ALIAS}.app.questions qq
                ON qq.question_id::VARCHAR = ar.question_id
                AND qq.organization_id = ar.organization_id
            LEFT JOIN {OPERATIONAL_PG_ALIAS}.app.response_options ro
                ON ro.response_option_id::VARCHAR = ar.option_id
        )"""
    days_sql, days_params = _event_days(attempts_all, ctx.tz)
    return ReportSpec(
        body_sql=body_sql,
        params=[ctx.tz],
        columns=[
            *ctx.person_cols,
            "question",
            "answer",
            "canvasser",
            "contacted_at",
            "turf",
            "zone",
            "campaign",
            *ctx.id_cols,
            "question_id",
            "option_id",
        ],
        default_order="created_at DESC, sequence DESC, question_created, option_order NULLS LAST",
        sortable={
            **_PERSON_SORTS,
            **_PLACE_SORTS,
            "question": ["question"],
            "answer": ["answer"],
            "canvasser": ["canvasser"],
            "contacted_at": ["created_at"],
        },
        days_sql=days_sql,
        days_params=days_params,
    )


def walks_spec(conn: duckdb.DuckDBPyConnection, ctx: ReportCtx) -> ReportSpec:
    """One row per sign-out that produced activity, tallies from the
    attempts stamped with its walk_id. Sign-outs with no attributed
    events are hidden — test/accidental opens and pair-secondary
    sign-outs (partner's phone did the recording); the walks table keeps
    them, and the Canvassers report already counts walks this way. A
    walk is a single outing, so its tallies are its own: the day chip
    filters the sign-out day, not the stats window."""
    walk_filters = ["o.slug = ?"]
    walk_params: list = [ctx.org_slug]
    if ctx.campaign_ids:
        walk_filters.append("c.campaign_id::VARCHAR IN (SELECT unnest(?))")
        walk_params.append(list(ctx.campaign_ids))
    day_filter = ""
    day_params: list = []
    if ctx.day:
        day_filter = "AND (w.opened_at AT TIME ZONE ?)::DATE = ?::DATE"
        day_params = [ctx.tz, ctx.day]
    attempts = _materialize_attempts(conn, ctx)
    body_sql = f"""
        WITH stats AS ({walk_stats_sql(attempts)}),
        walk_rows AS (
            SELECT w.walk_id, w.canvasser_name, w.opened_at, w.closed_at,
                   t.turf_code, t.name AS turf, t.zone_name AS zone,
                   t.person_count, t.door_count, c.name AS campaign
            FROM {OPERATIONAL_PG_ALIAS}.app.walks w
            JOIN {OPERATIONAL_PG_ALIAS}.app.turfs t ON t.turf_id = w.turf_id
            JOIN {OPERATIONAL_PG_ALIAS}.app.campaigns c ON c.campaign_id = t.campaign_id
            JOIN {OPERATIONAL_PG_ALIAS}.app.organizations o
                ON o.organization_id = c.organization_id
            WHERE {" AND ".join(walk_filters)} {day_filter}
        ),
        report AS (
            SELECT wr.canvasser_name AS canvasser, wr.turf_code,
                   strftime(wr.opened_at AT TIME ZONE ?, '%Y-%m-%d %H:%M') AS opened_at,
                   strftime(st.last_activity::TIMESTAMPTZ AT TIME ZONE ?, '%Y-%m-%d %H:%M')
                       AS last_activity_at,
                   strftime(wr.closed_at AT TIME ZONE ?, '%Y-%m-%d %H:%M') AS closed_at,
                   wr.person_count AS people, wr.door_count AS doors,
                   st.attempted AS attempts,
                   st.contacted AS contacts,
                   round(100.0 * st.attempted / nullif(wr.person_count, 0), 1)
                       AS progress,
                   round(100.0 * st.contacted / nullif(st.attempted, 0), 1) AS contact_rate,
                   wr.turf, wr.zone, wr.campaign, wr.walk_id,
                   wr.opened_at AS opened_raw
            FROM walk_rows wr
            JOIN stats st ON st.walk_id = wr.walk_id
        )"""
    days_sql = f"""
        SELECT DISTINCT ((w.opened_at AT TIME ZONE ?)::DATE)::VARCHAR AS day
        FROM {OPERATIONAL_PG_ALIAS}.app.walks w
        JOIN {OPERATIONAL_PG_ALIAS}.app.turfs t ON t.turf_id = w.turf_id
        JOIN {OPERATIONAL_PG_ALIAS}.app.campaigns c ON c.campaign_id = t.campaign_id
        JOIN {OPERATIONAL_PG_ALIAS}.app.organizations o
            ON o.organization_id = c.organization_id
        WHERE {" AND ".join(walk_filters)}
          AND EXISTS (
            SELECT 1 FROM {OPERATIONAL_PG_ALIAS}.app.canvass_events e
            WHERE e.walk_id = w.walk_id
          )
        ORDER BY day DESC
    """
    return ReportSpec(
        body_sql=body_sql,
        params=[*walk_params, *day_params, ctx.tz, ctx.tz, ctx.tz],
        columns=[
            "turf",
            "turf_code",
            "opened_at",
            "last_activity_at",
            "closed_at",
            "canvasser",
            "contact_rate",
            "progress",
            "people",
            "doors",
            "attempts",
            "contacts",
            "zone",
            "campaign",
            "walk_id",
        ],
        default_order="opened_raw DESC",
        sortable={
            **_PLACE_SORTS,
            "canvasser": ["canvasser"],
            "turf_code": ["turf_code"],
            "opened_at": ["opened_raw"],
            "last_activity_at": ["last_activity_at"],
            "people": ["people"],
            "doors": ["doors"],
            "attempts": ["attempts"],
            "contacts": ["contacts"],
            "progress": ["progress"],
            "contact_rate": ["contact_rate"],
        },
        days_sql=days_sql,
        days_params=[ctx.tz, *walk_params],
    )


def canvassers_spec(conn: duckdb.DuckDBPyConnection, ctx: ReportCtx) -> ReportSpec:
    """One row per claimed attestation with ≥1 attempt."""
    attempts_all = _materialize_attempts(conn, ctx)
    attempts = _dated_attempts(conn, ctx, attempts_all)
    body_sql = f"""
        WITH stats AS ({canvasser_stats_sql(attempts)}),
        report AS (
            SELECT canvasser_name AS canvasser, walks,
                   attempted AS attempts, contacted AS contacts,
                   round(100.0 * contacted / nullif(attempted, 0), 1) AS contact_rate,
                   strftime(first_active::TIMESTAMPTZ AT TIME ZONE ?, '%Y-%m-%d %H:%M')
                       AS first_active_at,
                   strftime(last_active::TIMESTAMPTZ AT TIME ZONE ?, '%Y-%m-%d %H:%M')
                       AS last_active_at,
                   canvasser_phone AS phone, first_active, last_active
            FROM stats
        )"""
    days_sql, days_params = _event_days(attempts_all, ctx.tz)
    return ReportSpec(
        body_sql=body_sql,
        params=[ctx.tz, ctx.tz],
        columns=[
            "canvasser",
            "walks",
            "first_active_at",
            "last_active_at",
            "contact_rate",
            "attempts",
            "contacts",
            "phone",
        ],
        default_order="last_active DESC",
        sortable={
            "canvasser": ["canvasser"],
            "walks": ["walks"],
            "attempts": ["attempts"],
            "contacts": ["contacts"],
            "contact_rate": ["contact_rate"],
            "first_active_at": ["first_active"],
            "last_active_at": ["last_active"],
        },
        days_sql=days_sql,
        days_params=days_params,
    )


SPECS = {
    "people": people_spec,
    "attempts": attempts_spec,
    "responses": responses_spec,
    "walks": walks_spec,
    "canvassers": canvassers_spec,
}


def _order_sql(spec: ReportSpec, sort: str | None, dir_: str) -> str:
    # User sort leads (allowlisted keys only — nothing user-typed lands
    # in the SQL text); the default order stays as tiebreak so paging is
    # deterministic under equal keys.
    if sort and sort in spec.sortable:
        direction = "DESC" if dir_ == "desc" else "ASC"
        keys = ", ".join(f"{c} {direction} NULLS LAST" for c in spec.sortable[sort])
        return f"ORDER BY {keys}, {spec.default_order}"
    return f"ORDER BY {spec.default_order}"


def _select_list(spec: ReportSpec) -> str:
    # Column names are quoted: generated question columns carry free
    # text; plain lowercase aliases are unaffected.
    return ", ".join('"' + c.replace('"', '""') + '"' for c in spec.columns)


def _select_sql(spec: ReportSpec, sort: str | None, dir_: str) -> str:
    return spec.body_sql + f"SELECT {_select_list(spec)} FROM report {_order_sql(spec, sort, dir_)}"


def _summary(conn: duckdb.DuckDBPyConnection, kind: str, rel: str) -> dict[str, Any]:
    """Aggregates over `rel`, the materialized report rows, so the
    summary always groups the same rows as the table."""
    if kind == "walks":
        w = conn.execute(
            f"""
            SELECT count(DISTINCT canvasser), count(DISTINCT turf_code),
                   coalesce(sum(attempts), 0), coalesce(sum(contacts), 0)
            FROM {rel}
            """
        ).fetchone()
        return {
            "canvassers": int(w[0]) if w else 0,
            "turfs": int(w[1]) if w else 0,
            "attempts": int(w[2]) if w else 0,
            "contacts": int(w[3]) if w else 0,
        }
    if kind == "canvassers":
        c = conn.execute(
            f"""
            SELECT count(*), coalesce(sum(walks), 0),
                   coalesce(sum(attempts), 0), coalesce(sum(contacts), 0)
            FROM {rel}
            """
        ).fetchone()
        return {
            "canvassers": int(c[0]) if c else 0,
            "walks": int(c[1]) if c else 0,
            "attempts": int(c[2]) if c else 0,
            "contacts": int(c[3]) if c else 0,
        }
    if kind == "responses":
        people_row = conn.execute(f"SELECT count(DISTINCT external_id) FROM {rel}").fetchone()
        question_rows = conn.execute(
            f"""
            SELECT question, count(*) FROM {rel}
            GROUP BY question ORDER BY min(question_created), question
            """
        ).fetchall()
        return {
            "people": int(people_row[0]) if people_row else 0,
            "questions": [{"label": q, "count": int(n)} for q, n in question_rows],
        }
    # people and attempts share the outcome breakdown (people's column is
    # last_outcome); their headline counts differ (contacted people vs
    # distinct people attempted).
    outcome_col = "last_outcome" if kind == "people" else "outcome"
    outcome_rows = conn.execute(f"SELECT {outcome_col}, count(*) FROM {rel} GROUP BY 1").fetchall()
    outcomes = {(o or "none"): int(n) for o, n in outcome_rows}
    if kind == "people":
        return {"outcomes": outcomes}
    people_row = conn.execute(f"SELECT count(DISTINCT external_id) FROM {rel}").fetchone()
    return {"people": int(people_row[0]) if people_row else 0, "outcomes": outcomes}


def preview(
    conn: duckdb.DuckDBPyConnection,
    kind: str,
    spec: ReportSpec,
    offset: int,
    sort: str | None,
    dir_: str,
) -> dict[str, Any]:
    with timed("query"):
        # The composed report runs once; count, page, and summary read the
        # materialized rows instead of re-running the chain.
        report = materialize(conn, "report_rows", f"{spec.body_sql} SELECT * FROM report", spec.params)
        total_row = conn.execute(f"SELECT count(*) FROM {report}").fetchone()
        rows = conn.execute(
            f"SELECT {_select_list(spec)} FROM {report} {_order_sql(spec, sort, dir_)}"
            f" LIMIT {PAGE_ROWS} OFFSET {int(offset)}"
        ).fetchall()
        day_rows = conn.execute(spec.days_sql, spec.days_params).fetchall()
        summary = _summary(conn, kind, report)
    return {
        "columns": spec.columns,
        "rows": [list(r) for r in rows],
        "total": int(total_row[0]) if total_row else 0,
        "days": [r[0] for r in day_rows],
        "summary": summary,
        "questionColumns": spec.question_columns,
    }


def export_copy(
    conn: duckdb.DuckDBPyConnection,
    spec: ReportSpec,
    sort: str | None,
    dir_: str,
    tmp_path: str,
    fmt: str,
) -> int:
    """COPY the full sorted table to tmp_path; returns the row count.
    `tmp_path` is server-generated and every untrusted input stays in
    bound params — same posture as /segments/export."""
    copy_opts = "FORMAT parquet" if fmt == "parquet" else "FORMAT csv, HEADER"
    copy_sql = f"COPY ({_select_sql(spec, sort, dir_)}) TO '{tmp_path}' ({copy_opts})"
    with timed("query"):
        row = conn.execute(copy_sql, spec.params).fetchone()
    return int(row[0]) if row else 0
