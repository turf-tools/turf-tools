"""One record per person, for importers whose source can list someone twice.

Which record wins is the importer's call (it knows its source's codes); this
writes the SQL so only the repeated IDs pay for the ordering. Everyone else
passes straight through, which keeps a statewide file within seconds of a plain
copy.
"""

from __future__ import annotations


def one_record_per_id_sql(source_table: str, id_column: str, preference: str) -> str:
    """A parenthesized subquery over `source_table` with one row per `id_column`.

    `preference` is an ORDER BY list over the alias `r`, best first. A hash of
    the whole record settles exact ties, so the pick is the same every run.
    """
    return f"""(
    WITH repeated AS (SELECT {id_column} FROM {source_table} GROUP BY 1 HAVING count(*) > 1)
    SELECT r.* FROM {source_table} AS r ANTI JOIN repeated USING ({id_column})
    UNION ALL
    (
        SELECT r.* FROM {source_table} AS r SEMI JOIN repeated USING ({id_column})
        QUALIFY row_number() OVER (PARTITION BY r.{id_column} ORDER BY {preference}, hash(r)) = 1
    )
)"""
