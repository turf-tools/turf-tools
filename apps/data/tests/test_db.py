from db import create_tables, get_connection
from settings import Settings


def test_ducklake_tables_created():
    settings = Settings()
    conn = get_connection(settings)
    create_tables(conn)

    tables = conn.execute("SHOW TABLES").fetchall()
    table_names = [t[0] for t in tables]

    assert "voter_file" in table_names
    assert "buildings" in table_names
    assert "doors" in table_names
    assert "universe_members" in table_names

    conn.close()


def test_ducklake_tables_idempotent():
    settings = Settings()
    conn = get_connection(settings)
    create_tables(conn)
    create_tables(conn)

    tables = conn.execute("SHOW TABLES").fetchall()
    assert len(tables) == 4

    conn.close()
