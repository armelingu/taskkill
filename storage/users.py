"""
Repositório de usuários: SQL da tabela `users` (auth, perfil, avatar, sessão).

As rotas mantêm a lógica de HTTP/segurança (hash, rate-limit, CSRF) e delegam a
persistência a estas funções.
"""

import sqlite3

from .db import connection, transaction


def get_profile(uid: int):
    """Campos do perfil usados por _current_user (ou None se não existir)."""
    with connection() as conn:
        row = conn.execute(
            'SELECT id, username, is_admin, created_at, last_login_at, '
            '       session_version, avatar_mime, theme_pref '
            'FROM users WHERE id = ?', (int(uid),)
        ).fetchone()
    return dict(row) if row else None


def get_auth_by_username(username: str):
    """Credenciais para login (id, username, password_hash, is_admin) ou None."""
    with connection() as conn:
        row = conn.execute(
            'SELECT id, username, password_hash, is_admin FROM users WHERE username = ?',
            (username,)
        ).fetchone()
    return dict(row) if row else None


def get_password_hash(uid: int):
    """Hash de senha atual do usuário (ou None)."""
    with connection() as conn:
        row = conn.execute(
            'SELECT password_hash FROM users WHERE id = ?', (int(uid),)
        ).fetchone()
    return row['password_hash'] if row else None


def set_password_hash(uid: int, pw_hash: str) -> None:
    with transaction() as conn:
        conn.execute('UPDATE users SET password_hash = ? WHERE id = ?', (pw_hash, int(uid)))


def get_login_meta(uid: int):
    """(last_login_at, session_version) do usuário, ou None."""
    with connection() as conn:
        row = conn.execute(
            'SELECT last_login_at, session_version FROM users WHERE id = ?', (int(uid),)
        ).fetchone()
    return dict(row) if row else None


def set_last_login(uid: int, iso: str) -> None:
    with transaction() as conn:
        conn.execute('UPDATE users SET last_login_at = ? WHERE id = ?', (iso, int(uid)))


def set_theme(uid: int, mode: str) -> None:
    with transaction() as conn:
        conn.execute('UPDATE users SET theme_pref = ? WHERE id = ?', (mode, int(uid)))


def username_taken(username: str, exclude_id: int) -> bool:
    """True se `username` já pertence a OUTRO usuário (id != exclude_id)."""
    with connection() as conn:
        row = conn.execute(
            'SELECT id FROM users WHERE username = ? AND id != ?',
            (username, int(exclude_id))
        ).fetchone()
    return row is not None


def set_username(uid: int, new_username: str) -> None:
    with transaction() as conn:
        conn.execute('UPDATE users SET username = ? WHERE id = ?', (new_username, int(uid)))


def set_avatar(uid: int, mime: str, data: bytes) -> None:
    with transaction() as conn:
        conn.execute(
            'UPDATE users SET avatar_mime = ?, avatar_data = ? WHERE id = ?',
            (mime, sqlite3.Binary(data), int(uid))
        )


def clear_avatar(uid: int) -> None:
    with transaction() as conn:
        conn.execute(
            'UPDATE users SET avatar_mime = NULL, avatar_data = NULL WHERE id = ?',
            (int(uid),)
        )


def get_avatar(uid: int):
    """(mime, data) do avatar ou None se não houver."""
    with connection() as conn:
        row = conn.execute(
            'SELECT avatar_mime, avatar_data FROM users WHERE id = ?', (int(uid),)
        ).fetchone()
    if not row or not row['avatar_mime'] or row['avatar_data'] is None:
        return None
    return row['avatar_mime'], bytes(row['avatar_data'])


def bump_session_version(uid: int) -> int:
    """Incrementa session_version ("sair de todos") e devolve o novo valor."""
    with transaction() as conn:
        conn.execute(
            'UPDATE users SET session_version = session_version + 1 WHERE id = ?',
            (int(uid),)
        )
        new_sv = conn.execute(
            'SELECT session_version FROM users WHERE id = ?', (int(uid),)
        ).fetchone()['session_version']
    return int(new_sv)
