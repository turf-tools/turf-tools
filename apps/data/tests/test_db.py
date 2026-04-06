from db import create_tables


def test_ducklake_tables_created(conn):
    create_tables(conn)

    tables = conn.execute("SHOW TABLES").fetchall()
    table_names = [t[0] for t in tables]

    assert "voter_file" in table_names
    assert "buildings" in table_names
    assert "doors" in table_names
    assert "universe_members" in table_names


def test_ducklake_tables_idempotent(conn):
    create_tables(conn)
    create_tables(conn)

    tables = conn.execute("SHOW TABLES").fetchall()
    assert len(tables) == 4
