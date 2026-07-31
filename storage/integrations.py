"""
Repositório de integrações: SQL de `integrations`, `integration_items` e
`integration_runs`.

Duas famílias de funções:
- As que ABREM a própria conexão (CRUD das rotas admin: list/get/create/update/
  delete/list_runs).
- As que RECEBEM `conn` e participam da transação do chamador (importação e
  scheduler precisam de atomicidade entre vários upserts + registro de run).
"""

from .db import connection, transaction, insert_returning_id


# ── CRUD (conexão própria) ──────────────────────────────────────────

def list_all():
    """Todas as integrações (ordenadas por nome)."""
    with connection() as conn:
        return conn.execute(
            'SELECT * FROM integrations ORDER BY name ASC'
        ).fetchall()


def get(integration_id: int):
    """Registro completo da integração (ou None)."""
    with connection() as conn:
        return conn.execute(
            'SELECT * FROM integrations WHERE id = ?', (int(integration_id),)
        ).fetchone()


def exists(integration_id: int) -> bool:
    with connection() as conn:
        row = conn.execute(
            'SELECT id FROM integrations WHERE id = ?', (int(integration_id),)
        ).fetchone()
    return row is not None


def get_config_json(integration_id: int):
    """config_json bruto (str) da integração, ou None."""
    with connection() as conn:
        row = conn.execute(
            'SELECT config_json FROM integrations WHERE id = ?', (int(integration_id),)
        ).fetchone()
    return row['config_json'] if row else None


def get_config_and_interval(integration_id: int):
    """(config_json, schedule_interval_minutes) para o update, ou None."""
    with connection() as conn:
        return conn.execute(
            'SELECT config_json, schedule_interval_minutes FROM integrations WHERE id = ?',
            (int(integration_id),)
        ).fetchone()


def create(name, enabled, config_json, now, sched_enabled, interval, next_run, owner_user_id=None) -> int:
    """Insere uma integração e devolve o novo id. owner_user_id é o dono das
    tarefas que a integração vier a criar (integrações são globais/admin)."""
    with transaction() as conn:
        return insert_returning_id(
            conn,
            "INSERT INTO integrations "
            "(name, enabled, config_json, last_status, created_at, updated_at, "
            " schedule_enabled, schedule_interval_minutes, next_run_at, owner_user_id) "
            "VALUES (?, ?, ?, 'never', ?, ?, ?, ?, ?, ?)",
            (name, enabled, config_json, now, now, sched_enabled, interval, next_run, owner_user_id)
        )


def first_admin_id():
    """
    Dono padrão para tarefas de integrações sem owner definido (integrações
    antigas ou criadas por caminhos que não informam o dono). Retorna o menor id
    de admin, ou o menor id de usuário como fallback.
    """
    with connection() as conn:
        row = conn.execute(
            'SELECT id FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1'
        ).fetchone()
        if row is None:
            row = conn.execute('SELECT id FROM users ORDER BY id LIMIT 1').fetchone()
    return int(row['id']) if row else None


def update_dynamic(integration_id: int, fields, params) -> None:
    """
    UPDATE dinâmico: `fields` são fragmentos 'col = ?' e `params` os valores,
    terminando com o id. A rota monta os campos conforme o payload.
    """
    with transaction() as conn:
        conn.execute(
            f"UPDATE integrations SET {', '.join(fields)} WHERE id = ?",
            params
        )


def delete(integration_id: int) -> None:
    """Remove a integração e seus itens importados."""
    with transaction() as conn:
        conn.execute('DELETE FROM integration_items WHERE integration_id = ?', (int(integration_id),))
        conn.execute('DELETE FROM integrations WHERE id = ?', (int(integration_id),))


def list_runs(integration_id: int, limit: int = 50):
    """Histórico de execuções (mais recentes primeiro)."""
    limit = max(1, min(int(limit or 50), 200))
    with connection() as conn:
        rows = conn.execute(
            'SELECT id, started_at, finished_at, trigger, status, '
            '       total_items, created, updated, skipped, error '
            'FROM integration_runs WHERE integration_id = ? '
            'ORDER BY id DESC LIMIT ?',
            (int(integration_id), limit)
        ).fetchall()
    return [dict(r) for r in rows]


# ── Operações transacionais (recebem conn) ──────────────────────────

def get_full(conn, integration_id: int):
    """SELECT * de uma integração dentro de uma transação em curso."""
    return conn.execute(
        'SELECT * FROM integrations WHERE id = ?', (int(integration_id),)
    ).fetchone()


def max_task_position(conn, user_id, project: str) -> int:
    row = conn.execute(
        'SELECT COALESCE(MAX(position), -1) AS max_pos FROM tasks '
        'WHERE user_id = ? AND project = ? AND deleted = 0',
        (user_id, project)
    ).fetchone()
    return int(row['max_pos'])


def insert_task(conn, user_id, project, text, today_str, due, position) -> int:
    return insert_returning_id(
        conn,
        'INSERT INTO tasks (user_id, project, text, completed, created_date, due_date, position, deleted) '
        'VALUES (?, ?, ?, 0, ?, ?, ?, 0)',
        (user_id, project, text, today_str, due, position)
    )


def ensure_project(conn, user_id, project: str) -> None:
    conn.execute(
        'INSERT INTO projects (user_id, name) VALUES (?, ?) ON CONFLICT DO NOTHING',
        (user_id, project)
    )


def get_item(conn, integration_id, ext):
    return conn.execute(
        'SELECT id, task_id, content_hash FROM integration_items '
        'WHERE integration_id = ? AND external_id = ?',
        (integration_id, ext)
    ).fetchone()


def get_task_state(conn, task_id):
    return conn.execute(
        'SELECT id, deleted FROM tasks WHERE id = ?', (task_id,)
    ).fetchone()


def link_item_update(conn, link_id, task_id, chash, now_iso) -> None:
    conn.execute(
        'UPDATE integration_items SET task_id = ?, content_hash = ?, updated_at = ? WHERE id = ?',
        (task_id, chash, now_iso, link_id)
    )


def link_item_insert(conn, integration_id, ext, task_id, chash, now_iso) -> None:
    conn.execute(
        'INSERT INTO integration_items '
        '(integration_id, external_id, task_id, content_hash, created_at, updated_at) '
        'VALUES (?, ?, ?, ?, ?, ?)',
        (integration_id, ext, task_id, chash, now_iso, now_iso)
    )


def update_task_text(conn, task_id, text) -> None:
    conn.execute('UPDATE tasks SET text = ? WHERE id = ?', (text, task_id))


def update_task_all(conn, task_id, text, project, due) -> None:
    conn.execute(
        'UPDATE tasks SET text = ?, project = ?, due_date = ? WHERE id = ?',
        (text, project, due, task_id)
    )


def update_item_hash(conn, link_id, new_hash, now_iso) -> None:
    conn.execute(
        'UPDATE integration_items SET content_hash = ?, updated_at = ? WHERE id = ?',
        (new_hash, now_iso, link_id)
    )


def insert_run(conn, integration_id, started_at, finished_at, trigger, status,
               total_items, created, updated, skipped, error) -> None:
    conn.execute(
        'INSERT INTO integration_runs '
        '(integration_id, started_at, finished_at, trigger, status, '
        ' total_items, created, updated, skipped, error) '
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (int(integration_id), started_at, finished_at, trigger, status,
         int(total_items), int(created), int(updated), int(skipped), error)
    )


def mark_error(conn, integration_id, when_iso, error) -> None:
    conn.execute(
        'UPDATE integrations SET last_run_at = ?, last_status = ?, last_error = ? WHERE id = ?',
        (when_iso, 'error', error, int(integration_id))
    )


def mark_ok(conn, integration_id, when_iso, last_item_count) -> None:
    conn.execute(
        'UPDATE integrations SET last_run_at = ?, last_status = ?, last_error = NULL, '
        'last_item_count = ? WHERE id = ?',
        (when_iso, 'ok', last_item_count, int(integration_id))
    )


# ── Scheduler (recebem conn) ────────────────────────────────────────

def select_due(conn, now_iso):
    """Integrações habilitadas cujo agendamento venceu."""
    return conn.execute(
        'SELECT id, schedule_interval_minutes, next_run_at FROM integrations '
        'WHERE enabled = 1 AND schedule_enabled = 1 AND schedule_interval_minutes > 0 '
        'AND (next_run_at IS NULL OR next_run_at <= ?)',
        (now_iso,)
    ).fetchall()


def claim_next_run(conn, integration_id, new_next, old_next) -> int:
    """
    Compare-and-set de next_run_at (reserva atômica). Retorna rowcount (1 se
    este processo reservou a integração; 0 se outro já reservou).
    """
    if old_next is None:
        cur = conn.execute(
            'UPDATE integrations SET next_run_at = ? WHERE id = ? AND next_run_at IS NULL',
            (new_next, integration_id)
        )
    else:
        cur = conn.execute(
            'UPDATE integrations SET next_run_at = ? WHERE id = ? AND next_run_at = ?',
            (new_next, integration_id, old_next)
        )
    return cur.rowcount
