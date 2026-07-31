"""
Fundação de acesso ao banco: dialeto, conexão, pragmas e helpers de transação.

Este é o único ponto que conhece o driver concreto. Suporta dois backends,
escolhidos por `TASKKILL_DATABASE_URL`:

- SQLite (padrão): arquivo local em AppData (ou TASKKILL_DB_PATH). Driver sqlite3.
- Postgres: quando a URL começa com postgres:// ou postgresql://. Driver psycopg.

Como todo o SQL do produto está centralizado em storage/, a portabilidade é
uma camada fina: um wrapper de conexão traduz os placeholders `?` -> `%s` no
Postgres, e helpers cobrem as poucas divergências de dialeto (id gerado,
upsert). O SQL dos repositórios segue o mesmo em ambos.
"""

import os
import shutil
import sqlite3
from contextlib import contextmanager


# ── Dialeto ─────────────────────────────────────────────────────────

def _database_url() -> str:
    return os.environ.get('TASKKILL_DATABASE_URL') or ''


def dialect() -> str:
    """'postgresql' se TASKKILL_DATABASE_URL apontar para Postgres; senão 'sqlite'."""
    url = _database_url()
    if url.startswith('postgres://') or url.startswith('postgresql://'):
        return 'postgresql'
    return 'sqlite'


def is_postgres() -> bool:
    return dialect() == 'postgresql'


def _ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def get_db_path() -> str:
    """
    Caminho do banco SQLite em modo "produto" (AppData). Só se aplica ao SQLite.

    - Override: TASKKILL_DB_PATH aponta para um .db específico (útil pra dev/test/portátil).
    - Migração: se existir um db antigo ao lado do código e ainda não existir em AppData, copia.
    """
    override = os.environ.get('TASKKILL_DB_PATH')
    if override:
        return override

    # Windows: %LOCALAPPDATA%
    # Linux/macOS: XDG_DATA_HOME ou ~/.local/share
    if os.name == 'nt':
        base = os.environ.get('LOCALAPPDATA') or os.path.join(os.path.expanduser('~'), 'AppData', 'Local')
    else:
        base = os.environ.get('XDG_DATA_HOME') or os.path.join(os.path.expanduser('~'), '.local', 'share')

    target_dir = os.path.join(base, 'Taskkill')
    _ensure_dir(target_dir)
    new_path = os.path.join(target_dir, 'taskkill.db')

    # O db legado ficava ao lado do código (raiz do projeto). Sobe um nível a
    # partir de storage/ para encontrá-lo.
    old_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'taskkill.db')
    if os.path.exists(old_path) and not os.path.exists(new_path):
        try:
            shutil.copy2(old_path, new_path)
        except OSError:
            # Se não conseguir copiar (permissão/lock), continua usando o caminho novo (criará do zero).
            pass

    return new_path


def _apply_pragmas(conn: sqlite3.Connection) -> None:
    # Robustez para uso local com múltiplas operações rápidas (SQLite).
    conn.execute('PRAGMA foreign_keys = ON;')
    conn.execute('PRAGMA journal_mode = WAL;')
    conn.execute('PRAGMA synchronous = NORMAL;')
    conn.execute('PRAGMA busy_timeout = 3000;')


# ── Wrapper Postgres (traduz placeholders) ──────────────────────────

def _translate(sql: str) -> str:
    """
    Converte o SQL escrito no estilo SQLite (placeholder `?`) para o estilo do
    psycopg (`%s`). Escapa `%` literais antes (nenhum SQL nosso os usa hoje, mas
    mantém a tradução correta caso passem a existir).
    """
    return sql.replace('%', '%%').replace('?', '%s')


class _PgCursor:
    """Cursor psycopg com tradução de placeholders e API compatível com sqlite3."""

    def __init__(self, cur):
        self._cur = cur

    def execute(self, sql, params=()):
        self._cur.execute(_translate(sql), params)
        return self

    def executemany(self, sql, seq_params):
        self._cur.executemany(_translate(sql), list(seq_params))
        return self

    def fetchone(self):
        return self._cur.fetchone()

    def fetchall(self):
        return self._cur.fetchall()

    @property
    def rowcount(self):
        return self._cur.rowcount

    @property
    def lastrowid(self):
        # No Postgres não há lastrowid útil: use insert_returning_id().
        return None

    def __iter__(self):
        return iter(self._cur)


class _PgConnection:
    """Conexão psycopg com API compatível com o sqlite3 usado nos repositórios."""

    def __init__(self, raw):
        self._raw = raw

    def execute(self, sql, params=()):
        cur = self._raw.cursor()
        cur.execute(_translate(sql), params)
        return _PgCursor(cur)

    def cursor(self):
        return _PgCursor(self._raw.cursor())

    def commit(self):
        self._raw.commit()

    def rollback(self):
        self._raw.rollback()

    def close(self):
        self._raw.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        # Espelha o context manager do sqlite3: commit no sucesso, rollback no
        # erro (sem fechar a conexão).
        if exc_type is None:
            self._raw.commit()
        else:
            self._raw.rollback()
        return False


# ── Conexão ─────────────────────────────────────────────────────────

def get_db_connection():
    """Conexão isolada; linhas acessíveis por nome (Row no SQLite, dict no PG)."""
    if is_postgres():
        import psycopg
        from psycopg.rows import dict_row
        raw = psycopg.connect(_database_url(), row_factory=dict_row)
        return _PgConnection(raw)

    conn = sqlite3.connect(get_db_path())
    conn.row_factory = sqlite3.Row
    _apply_pragmas(conn)
    return conn


@contextmanager
def connection():
    """
    Conexão para LEITURA: entrega a conexão e garante o fechamento no fim.
    Não faz commit (use `transaction()` para escrita).
    """
    conn = get_db_connection()
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def transaction():
    """
    Conexão para ESCRITA: commit ao sair sem erro, rollback em exceção e sempre
    fecha a conexão.
    """
    conn = get_db_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ── Helpers de dialeto ──────────────────────────────────────────────

def insert_returning_id(conn, sql, params):
    """
    Executa um INSERT e devolve o id gerado, cobrindo a divergência de dialeto:
    RETURNING id no Postgres, cursor.lastrowid no SQLite. O `sql` deve ser um
    INSERT sem cláusula RETURNING.
    """
    if is_postgres():
        row = conn.execute(sql + ' RETURNING id', params).fetchone()
        return row['id']
    return conn.execute(sql, params).lastrowid
