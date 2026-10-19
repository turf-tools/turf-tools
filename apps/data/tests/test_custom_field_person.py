"""`person_custom_fields`: one person's custom-field values for the Lookup
detail pane. Pure in-memory DuckDB; the registry lives in a memory catalog
under the operational-Postgres alias (`operational_conn`)."""

import pytest

from src.custom_fields import person_custom_fields
from src.duckdb import OPERATIONAL_PG_ALIAS

SCORE = "00000000-0000-0000-0000-000000000001"
TAGS = "00000000-0000-0000-0000-000000000002"
OLD = "00000000-0000-0000-0000-000000000003"
SIGNED = "00000000-0000-0000-0000-000000000004"


@pytest.fixture
def conn(operational_conn):
    c = operational_conn
    c.execute(f"""
        CREATE TABLE {OPERATIONAL_PG_ALIAS}.app.custom_fields (
            custom_field_id UUID, label VARCHAR, field_type VARCHAR, archived_at TIMESTAMPTZ
        )
    """)
    c.execute(
        f"""
        INSERT INTO {OPERATIONAL_PG_ALIAS}.app.custom_fields VALUES
            ('{SCORE}', 'support score', 'number', NULL),
            ('{TAGS}', 'issues', 'enum_multi', NULL),
            ('{OLD}', 'old list', 'text', now()),
            ('{SIGNED}', 'signed petition', 'date', NULL)
        """
    )
    c.execute("CREATE TABLE values_table (external_id VARCHAR, field_id VARCHAR, value VARCHAR, upload_id VARCHAR)")
    c.execute(
        f"""
        INSERT INTO values_table VALUES
            ('p1', '{SCORE}', '0.8', 'u1'),
            ('p1', '{TAGS}', 'rent', 'u2'),
            ('p1', '{TAGS}', 'housing', 'u2'),
            ('p1', '{OLD}', 'x', 'u3'),
            ('p1', '{SIGNED}', '2026-05-01', 'u4'),
            ('p2', '{SCORE}', '0.1', 'u1')
        """
    )
    return c


def test_label_order_multi_values_and_archived_left_out(conn):
    assert person_custom_fields(conn, "values_table", "p1") == [
        {"label": "issues", "fieldType": "enum_multi", "values": ["housing", "rent"]},
        {"label": "signed petition", "fieldType": "date", "values": ["2026-05-01"]},
        {"label": "support score", "fieldType": "number", "values": ["0.8"]},
    ]


def test_only_that_persons_values(conn):
    assert person_custom_fields(conn, "values_table", "p2") == [
        {"label": "support score", "fieldType": "number", "values": ["0.1"]},
    ]


def test_person_with_no_values(conn):
    assert person_custom_fields(conn, "values_table", "p3") == []
