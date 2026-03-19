import sqlite3
import os
import shutil

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

    old_path = os.path.join(os.path.dirname(__file__), 'taskkill.db')
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

def get_db_connection():
    """Gera uma conexão isolada com o Banco para retornar dados como dicionários (poderoso para JSON)"""
    conn = sqlite3.connect(get_db_path())
    conn.row_factory = sqlite3.Row
    _apply_pragmas(conn)
    return conn

def init_db():
    """Cria a tabela e as regras do banco de dados na primeira vez que a aplicação inicia"""
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project TEXT NOT NULL,
                text TEXT NOT NULL,
                completed BOOLEAN NOT NULL DEFAULT 0,
                created_date TEXT,
                due_date TEXT,
                position INTEGER DEFAULT 0,
                deleted BOOLEAN NOT NULL DEFAULT 0
            )
        ''')
        
        # Migration: tenta inserir a coluna caso o banco já exista de versões anteriores
        try:
            cursor.execute('ALTER TABLE tasks ADD COLUMN created_date TEXT')
        except sqlite3.OperationalError:
            pass # Se a coluna já existir, ele segue ignorando silenciosamente
            
        try:
            cursor.execute('ALTER TABLE tasks ADD COLUMN due_date TEXT')
        except sqlite3.OperationalError:
            pass

        try:
            cursor.execute('ALTER TABLE tasks ADD COLUMN position INTEGER DEFAULT 0')
        except sqlite3.OperationalError:
            pass

        try:
            cursor.execute('ALTER TABLE tasks ADD COLUMN deleted BOOLEAN NOT NULL DEFAULT 0')
        except sqlite3.OperationalError:
            pass

        # Índices simples para manter leituras/ordenações consistentes e rápidas
        try:
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_tasks_project_position ON tasks(project, position, id)')
        except sqlite3.OperationalError:
            pass
        try:
            cursor.execute('CREATE INDEX IF NOT EXISTS idx_tasks_deleted ON tasks(deleted)')
        except sqlite3.OperationalError:
            pass

        conn.commit()
