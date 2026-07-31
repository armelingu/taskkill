"""
Esquema e migrações do banco (init_db).

Concentra a criação de tabelas/índices e as migrações idempotentes. É chamado
uma vez no boot da aplicação (app.py) e é seguro rodar múltiplas vezes.
Reexportado por `database.init_db` para compatibilidade.

Suporta SQLite e Postgres:
- SQLite: mantém o histórico de migrações incrementais (ALTER TABLE ... ADD
  COLUMN protegidos), para atualizar bancos antigos em campo.
- Postgres: cria o schema completo de uma vez (bancos novos), sem o vaivém de
  ALTERs — que, no Postgres, abortariam a transação ao falhar.
"""

import os
from datetime import datetime, date, timedelta

from .db import get_db_connection, is_postgres


def init_db():
    """Cria as tabelas/índices e aplica migrações. Idempotente."""
    # Import tardio evita ciclo: database importa init_db daqui e nós precisamos
    # do hash_password de lá apenas em tempo de execução.
    from database import hash_password

    with get_db_connection() as conn:
        cursor = conn.cursor()
        if is_postgres():
            _init_postgres(cursor)
        else:
            _init_sqlite(cursor)

        # Passos comuns (SQL portável): admin inicial e backfill de projetos.
        _bootstrap_admin(cursor, hash_password)
        _backfill_projects(cursor)

        conn.commit()


# ── Passos comuns (portáveis) ───────────────────────────────────────

def _bootstrap_admin(cursor, hash_password):
    """Cria o admin inicial no primeiro boot (obrigatório para ambiente web)."""
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


def _backfill_projects(cursor):
    """Garante que projetos já usados em tasks apareçam na tabela projects."""
    cursor.execute(
        "SELECT DISTINCT project FROM tasks WHERE deleted = 0 AND project IS NOT NULL AND project != ''"
    )
    for _row in cursor.fetchall():
        cursor.execute(
            "INSERT INTO projects (name) VALUES (?) ON CONFLICT DO NOTHING", (_row['project'],)
        )


# ── Postgres: schema completo ───────────────────────────────────────

def _init_postgres(cursor):
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS tasks (
            id SERIAL PRIMARY KEY,
            project TEXT NOT NULL,
            text TEXT NOT NULL,
            completed INTEGER NOT NULL DEFAULT 0,
            created_date TEXT,
            due_date TEXT,
            position INTEGER DEFAULT 0,
            deleted INTEGER NOT NULL DEFAULT 0,
            recurrence TEXT NOT NULL DEFAULT 'none'
        )
    ''')
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
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_task_deps_depends_on ON task_dependencies(depends_on_id)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_tasks_project_position ON tasks(project, position, id)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_tasks_deleted ON tasks(deleted)')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            is_admin INTEGER NOT NULL DEFAULT 0,
            created_at TEXT,
            last_login_at TEXT,
            avatar_mime TEXT,
            avatar_data BYTEA,
            session_version INTEGER NOT NULL DEFAULT 0,
            theme_pref TEXT NOT NULL DEFAULT 'system'
        )
    ''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)')

    cursor.execute('DROP TABLE IF EXISTS chamados_sync')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS projects (
            id   SERIAL PRIMARY KEY,
            name TEXT NOT NULL UNIQUE
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS integrations (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            config_json TEXT NOT NULL,
            last_run_at TEXT,
            last_status TEXT NOT NULL DEFAULT 'never',
            last_error TEXT,
            last_item_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT,
            updated_at TEXT,
            schedule_enabled INTEGER NOT NULL DEFAULT 0,
            schedule_interval_minutes INTEGER NOT NULL DEFAULT 0,
            next_run_at TEXT
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS integration_items (
            id SERIAL PRIMARY KEY,
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
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS integration_runs (
            id SERIAL PRIMARY KEY,
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


# ── SQLite: criação + migrações incrementais ────────────────────────

def _init_sqlite(cursor):
    import sqlite3

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
