"""
Fundação de acesso ao banco: caminho, conexão, pragmas e helpers de transação.

Este é o único ponto que conhece o driver concreto (sqlite3). Repositórios e o
resto do app usam `connection()`/`transaction()` daqui, sem tocar no driver
diretamente. Para portar a outro banco, basta reimplementar este módulo.
"""

import os
import shutil
import sqlite3
from contextlib import contextmanager


def _ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def get_db_path() -> str:
    """
    Caminho do banco em modo "produto" (AppData).

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
    # Robustez para uso local com múltiplas operações rápidas.
    conn.execute('PRAGMA foreign_keys = ON;')
    conn.execute('PRAGMA journal_mode = WAL;')
    conn.execute('PRAGMA synchronous = NORMAL;')
    conn.execute('PRAGMA busy_timeout = 3000;')


def get_db_connection() -> sqlite3.Connection:
    """Conexão isolada com row_factory=Row (linhas acessíveis por nome)."""
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
    fecha a conexão. Substitui o padrão `with get_db_connection() as conn` +
    `conn.commit()` espalhado pelo código.
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
