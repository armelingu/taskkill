"""Testes de schema/migrações do banco (database.init_db)."""

import database


def _columns(conn, table):
    return {row['name'] for row in conn.execute(f'PRAGMA table_info({table})')}


def _tables(conn):
    return {
        row['name']
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }


def test_init_db_is_idempotent():
    # Rodar duas vezes não deve levantar erro (migrações são idempotentes).
    database.init_db()
    database.init_db()


def test_expected_tables_exist():
    database.init_db()
    with database.get_db_connection() as conn:
        tables = _tables(conn)
    for expected in ('tasks', 'users', 'projects', 'integrations',
                     'integration_items', 'integration_runs'):
        assert expected in tables, f'tabela ausente: {expected}'


def test_users_has_security_columns():
    database.init_db()
    with database.get_db_connection() as conn:
        cols = _columns(conn, 'users')
    for expected in ('last_login_at', 'avatar_mime', 'avatar_data', 'session_version'):
        assert expected in cols, f'coluna ausente em users: {expected}'


def test_integrations_has_schedule_columns():
    database.init_db()
    with database.get_db_connection() as conn:
        cols = _columns(conn, 'integrations')
    for expected in ('schedule_enabled', 'schedule_interval_minutes', 'next_run_at'):
        assert expected in cols, f'coluna ausente em integrations: {expected}'


def test_admin_bootstrapped():
    database.init_db()
    with database.get_db_connection() as conn:
        row = conn.execute('SELECT username, is_admin FROM users WHERE username = ?',
                           ('admin',)).fetchone()
    assert row is not None
    assert int(row['is_admin']) == 1


def test_password_hash_roundtrip():
    from werkzeug.security import check_password_hash
    h = database.hash_password('uma-senha-forte')
    assert check_password_hash(h, 'uma-senha-forte')
    assert not check_password_hash(h, 'senha-errada')
