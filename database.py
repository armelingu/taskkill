import sqlite3
import os
import shutil
from datetime import datetime, date, timedelta

from werkzeug.security import generate_password_hash


# ---------------------------------------------------------------------------
# Hashing de senha (centralizado)
# ---------------------------------------------------------------------------
# Preferimos scrypt (mais resistente a ataque de hardware que o pbkdf2) e caímos
# para pbkdf2:sha256 se o ambiente não suportar scrypt (ex.: OpenSSL sem suporte).
# Centralizar aqui permite rehash-on-login: ao logar, se o hash usar um método
# antigo, ele é regravado com o método atual de forma transparente.
def _resolve_pwhash_method() -> str:
    method = os.environ.get('TASKKILL_PWHASH_METHOD', 'scrypt')
    try:
        generate_password_hash('probe', method=method)
        return method
    except Exception:
        return 'pbkdf2:sha256'


PWHASH_METHOD = _resolve_pwhash_method()


def hash_password(password: str) -> str:
    """Gera o hash da senha usando o método atual (scrypt por padrão)."""
    return generate_password_hash(password, method=PWHASH_METHOD)


def password_needs_rehash(hashed: str) -> bool:
    """
    True se o hash armazenado não usa o método atual (ex.: pbkdf2 antigo quando
    o padrão agora é scrypt). Usado para migrar o hash no próximo login válido.
    """
    prefix = PWHASH_METHOD.split(':', 1)[0] + ':'
    return not (hashed or '').startswith(prefix)


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
                deleted BOOLEAN NOT NULL DEFAULT 0,
                recurrence TEXT NOT NULL DEFAULT 'none'
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

        # Migração: prazos legados eram nomes de dia da semana ('Segunda'…'Sexta').
        # Passamos a usar datas reais ISO (YYYY-MM-DD). Converte cada nome legado
        # para a data daquele dia na semana atual (semana começa na segunda).
        # Idempotente: nomes já convertidos deixam de existir na próxima execução.
        _today = date.today()
        _monday = _today - timedelta(days=_today.weekday())
        _legacy_to_offset = {
            'Segunda': 0, 'Terça': 1, 'Terca': 1, 'Quarta': 2, 'Quinta': 3, 'Sexta': 4,
        }
        for _name, _offset in _legacy_to_offset.items():
            _iso = (_monday + timedelta(days=_offset)).isoformat()
            cursor.execute(
                'UPDATE tasks SET due_date = ? WHERE due_date = ?', (_iso, _name)
            )

        try:
            cursor.execute('ALTER TABLE tasks ADD COLUMN position INTEGER DEFAULT 0')
        except sqlite3.OperationalError:
            pass

        try:
            cursor.execute('ALTER TABLE tasks ADD COLUMN deleted BOOLEAN NOT NULL DEFAULT 0')
        except sqlite3.OperationalError:
            pass

        # Recorrência de tarefas (none/daily/weekdays/weekly/monthly).
        try:
            cursor.execute("ALTER TABLE tasks ADD COLUMN recurrence TEXT NOT NULL DEFAULT 'none'")
        except sqlite3.OperationalError:
            pass

        # Dependências entre tarefas: (task_id depende de depends_on_id).
        # O pré-requisito (depends_on_id) precisa sair antes. ON DELETE CASCADE
        # limpa vínculos se uma tarefa for removida de fato (hard delete).
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS task_dependencies (
                task_id       INTEGER NOT NULL,
                depends_on_id INTEGER NOT NULL,
                created_at    TEXT,
                PRIMARY KEY (task_id, depends_on_id),
                FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
                FOREIGN KEY (depends_on_id) REFERENCES tasks(id) ON DELETE CASCADE
            )
        ''')
        try:
            cursor.execute(
                'CREATE INDEX IF NOT EXISTS idx_task_deps_depends_on '
                'ON task_dependencies(depends_on_id)'
            )
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

        # Usuários (web)
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                is_admin BOOLEAN NOT NULL DEFAULT 0,
                created_at TEXT
            )
        ''')

        cursor.execute('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)')

        # Migrações idempotentes em users: avatar, último acesso e versão de
        # sessão (usada para "sair de todos os dispositivos").
        for _ddl in (
            'ALTER TABLE users ADD COLUMN last_login_at TEXT',
            'ALTER TABLE users ADD COLUMN avatar_mime TEXT',
            'ALTER TABLE users ADD COLUMN avatar_data BLOB',
            'ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0',
            # Preferência de tema (light/dark/system) sincronizada entre dispositivos.
            "ALTER TABLE users ADD COLUMN theme_pref TEXT NOT NULL DEFAULT 'system'",
        ):
            try:
                cursor.execute(_ddl)
            except sqlite3.OperationalError:
                pass

        # Bootstrap do admin no primeiro boot (obrigatório para ambiente web)
        cursor.execute('SELECT COUNT(*) AS cnt FROM users')
        cnt = int(cursor.fetchone()['cnt'])
        if cnt == 0:
            admin_user = (os.environ.get('TASKKILL_ADMIN_USER') or 'admin').strip()
            admin_pass = os.environ.get('TASKKILL_ADMIN_PASSWORD')
            if not admin_pass or len(admin_pass.strip()) < 10:
                length = 0 if not admin_pass else len(admin_pass.strip())
                raise RuntimeError(
                    f"Nenhum usuário encontrado. Defina TASKKILL_ADMIN_PASSWORD (>= 10 chars) para criar o admin inicial. "
                    f"Comprimento atual: {length}."
                )

            pw_hash = hash_password(admin_pass.strip())
            cursor.execute(
                "INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, 1, ?)",
                (admin_user, pw_hash, datetime.utcnow().isoformat())
            )

        # Migração: a antiga tabela `chamados_sync` (sync MySQL legado) foi
        # substituída pelo módulo genérico de Integrações (integrations/*).
        # Remove o resquício em bancos antigos; no-op em bancos novos.
        cursor.execute('DROP TABLE IF EXISTS chamados_sync')

        # Projetos gerenciáveis pelo usuário
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS projects (
                id   INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE
            )
        ''')

        # Sem projetos-semente: instalações novas começam vazias (o onboarding
        # no primeiro uso guia a criação do primeiro projeto). Bancos existentes
        # mantêm os projetos que já possuem.

        # Migração: garante que projetos já usados em tasks apareçam na tabela.
        cursor.execute(
            "SELECT DISTINCT project FROM tasks WHERE deleted = 0 AND project IS NOT NULL AND project != ''"
        )
        for _row in cursor.fetchall():
            cursor.execute("INSERT OR IGNORE INTO projects (name) VALUES (?)", (_row['project'],))

        # Integrações externas (genérico: API REST/JSON -> tasks)
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS integrations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                config_json TEXT NOT NULL,
                last_run_at TEXT,
                last_status TEXT NOT NULL DEFAULT 'never',
                last_error TEXT,
                last_item_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT,
                updated_at TEXT
            )
        ''')

        # Itens já importados por integração (dedup + vínculo com a task criada)
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS integration_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                integration_id INTEGER NOT NULL,
                external_id TEXT NOT NULL,
                task_id INTEGER,
                content_hash TEXT,
                created_at TEXT,
                updated_at TEXT,
                FOREIGN KEY (integration_id) REFERENCES integrations(id) ON DELETE CASCADE
            )
        ''')
        cursor.execute(
            'CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_items_unique '
            'ON integration_items(integration_id, external_id)'
        )
        cursor.execute(
            'CREATE INDEX IF NOT EXISTS idx_integration_items_integration '
            'ON integration_items(integration_id)'
        )

        # Coluna de dedup por conteúdo (adicionada depois; migração idempotente)
        try:
            cursor.execute('ALTER TABLE integration_items ADD COLUMN content_hash TEXT')
        except sqlite3.OperationalError:
            pass

        # Histórico de execuções por integração (log de cada rodada)
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS integration_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                integration_id INTEGER NOT NULL,
                started_at TEXT,
                finished_at TEXT,
                trigger TEXT NOT NULL DEFAULT 'manual',
                status TEXT NOT NULL DEFAULT 'ok',
                total_items INTEGER NOT NULL DEFAULT 0,
                created INTEGER NOT NULL DEFAULT 0,
                updated INTEGER NOT NULL DEFAULT 0,
                skipped INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                FOREIGN KEY (integration_id) REFERENCES integrations(id) ON DELETE CASCADE
            )
        ''')
        cursor.execute(
            'CREATE INDEX IF NOT EXISTS idx_integration_runs_integration '
            'ON integration_runs(integration_id, id DESC)'
        )

        # Agendamento automático: colunas na tabela integrations (migração idempotente)
        for _col, _ddl in (
            ('schedule_enabled', 'ALTER TABLE integrations ADD COLUMN schedule_enabled INTEGER NOT NULL DEFAULT 0'),
            ('schedule_interval_minutes', 'ALTER TABLE integrations ADD COLUMN schedule_interval_minutes INTEGER NOT NULL DEFAULT 0'),
            ('next_run_at', 'ALTER TABLE integrations ADD COLUMN next_run_at TEXT'),
        ):
            try:
                cursor.execute(_ddl)
            except sqlite3.OperationalError:
                pass

        conn.commit()
