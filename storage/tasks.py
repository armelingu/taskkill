"""
Repositório de tarefas: todo o SQL de `tasks` e `task_dependencies` vive aqui.

As rotas ficam com a validação/HTTP e delegam a persistência a estas funções.
Comportamento espelha 1:1 o que antes era SQL inline em routes.py.
"""

from datetime import date, datetime

from .db import connection, transaction

# Sentinela para distinguir "não enviado" de "enviado como vazio/None".
_UNSET = object()


# ── Leitura ─────────────────────────────────────────────────────────

def fetch_tasks_grouped() -> dict:
    """
    Todas as tarefas ativas (deleted=0) agrupadas por projeto, no formato que o
    front espera, já com `depends_on` (lista de pré-requisitos) por tarefa.
    """
    with connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM tasks WHERE deleted = 0 "
            "ORDER BY project ASC, position ASC, id ASC"
        )
        rows = cursor.fetchall()

        deps_by_task = {}
        for dep in cursor.execute(
            "SELECT task_id, depends_on_id FROM task_dependencies"
        ).fetchall():
            deps_by_task.setdefault(dep['task_id'], []).append(dep['depends_on_id'])

        tasks_data = {}
        for row in rows:
            project = row['project']
            tasks_data.setdefault(project, [])

            c_date = row['created_date'] if 'created_date' in row.keys() else None
            d_date = row['due_date'] if 'due_date' in row.keys() else None
            pos = row['position'] if 'position' in row.keys() else 0
            del_flag = bool(row['deleted']) if 'deleted' in row.keys() else False
            rec = (row['recurrence'] if 'recurrence' in row.keys() else 'none') or 'none'

            tasks_data[project].append({
                'id': row['id'],
                'project': row['project'],
                'text': row['text'],
                'completed': bool(row['completed']),
                'created_date': c_date,
                'due_date': d_date,
                'position': pos,
                'deleted': del_flag,
                'recurrence': rec,
                'depends_on': deps_by_task.get(row['id'], []),
            })
        return tasks_data


def _max_position(conn, project: str) -> int:
    """Maior posição ativa do projeto (ou -1 se vazio)."""
    row = conn.execute(
        "SELECT COALESCE(MAX(position), -1) AS max_pos "
        "FROM tasks WHERE project = ? AND deleted = 0",
        (project,),
    ).fetchone()
    return int(row['max_pos']) if row and row['max_pos'] is not None else -1


# ── Escrita ─────────────────────────────────────────────────────────

def create(project: str, text: str, created_date: str, due_date, recurrence: str) -> dict:
    """Insere uma tarefa no fim do projeto e devolve o registro criado."""
    with transaction() as conn:
        cursor = conn.cursor()
        new_pos = _max_position(conn, project) + 1
        cursor.execute(
            "INSERT INTO tasks (project, text, completed, created_date, due_date, position, deleted, recurrence) "
            "VALUES (?, ?, 0, ?, ?, ?, 0, ?)",
            (project, text, created_date, due_date, new_pos, recurrence),
        )
        task_id = cursor.lastrowid
        return {
            'id': task_id,
            'project': project,
            'text': text,
            'completed': False,
            'created_date': created_date,
            'due_date': due_date,
            'position': new_pos,
            'deleted': False,
            'recurrence': recurrence,
        }


def update(task_id: int, *, next_occurrence_fn=None,
           text=None, completed=None, due_date=_UNSET,
           recurrence=None, deleted=_UNSET, project=None):
    """
    Update parcial de uma tarefa (valores já validados pela rota). Sentinelas:
      - text/recurrence/project: None = não mexe.
      - completed: None = não mexe; 0/1 = seta (salvo se recorrência reagendar).
      - due_date/deleted: _UNSET = não mexe; valor (inclui '') = seta.

    Se a tarefa for recorrente e `completed == 1`, em vez de concluir, reagenda a
    MESMA tarefa: avança due_date para a próxima ocorrência (via
    next_occurrence_fn) e mantém completed=0. Retorna a nova data (str) nesse
    caso, senão None.
    """
    recurred_to = None
    with transaction() as conn:
        cursor = conn.cursor()

        if completed == 1 and next_occurrence_fn is not None:
            row = cursor.execute(
                "SELECT recurrence, due_date FROM tasks WHERE id = ?", (task_id,)
            ).fetchone()
            if row is not None:
                rule = (row['recurrence'] if 'recurrence' in row.keys() else 'none') or 'none'
                cur_due = row['due_date'] if 'due_date' in row.keys() else None
                if rule != 'none' and cur_due:
                    nxt = next_occurrence_fn(cur_due, rule)
                    if nxt:
                        cursor.execute(
                            "UPDATE tasks SET due_date = ?, completed = 0 WHERE id = ?",
                            (nxt, task_id),
                        )
                        recurred_to = nxt
                        completed = None  # já tratado

        if text is not None and completed is not None:
            cursor.execute("UPDATE tasks SET text = ?, completed = ? WHERE id = ?", (text, completed, task_id))
        elif text is not None:
            cursor.execute("UPDATE tasks SET text = ? WHERE id = ?", (text, task_id))
        elif completed is not None:
            cursor.execute("UPDATE tasks SET completed = ? WHERE id = ?", (completed, task_id))

        if due_date is not _UNSET:
            cursor.execute("UPDATE tasks SET due_date = ? WHERE id = ?", (due_date, task_id))

        if recurrence is not None:
            cursor.execute("UPDATE tasks SET recurrence = ? WHERE id = ?", (recurrence, task_id))

        if deleted is not _UNSET:
            cursor.execute("UPDATE tasks SET deleted = ? WHERE id = ?", (deleted, task_id))

        if project is not None:
            new_pos = _max_position(conn, project) + 1
            cursor.execute(
                "UPDATE tasks SET project = ?, position = ? WHERE id = ?",
                (project, new_pos, task_id),
            )

    return recurred_to


def soft_delete(task_id: int) -> None:
    """Arquiva a tarefa (flag deleted=1), consistente com o modelo."""
    with transaction() as conn:
        conn.execute("UPDATE tasks SET deleted = 1 WHERE id = ?", (task_id,))


def reorder(pairs):
    """
    Aplica novas posições. `pairs` é uma lista de (position, task_id) já
    sanitizada (ids únicos, positions >= 0). Exige que o conjunto seja de UM
    único projeto e cubra TODAS as tarefas ativas dele.

    Retorna (ok: bool, error: str|None).
    """
    ids = [tid for (_pos, tid) in pairs]
    if not ids:
        return True, None

    with transaction() as conn:
        cursor = conn.cursor()
        qmarks = ",".join(["?"] * len(ids))
        cursor.execute(
            f"SELECT DISTINCT project FROM tasks WHERE deleted = 0 AND id IN ({qmarks})",
            ids,
        )
        projects = [r['project'] for r in cursor.fetchall()]
        if len(projects) != 1:
            return False, "Bad Request: reorder must target a single project"

        project = projects[0]
        cnt = cursor.execute(
            "SELECT COUNT(*) AS cnt FROM tasks WHERE project = ? AND deleted = 0",
            (project,),
        ).fetchone()['cnt']
        if int(cnt) != len(ids):
            return False, "Bad Request: reorder must include all active tasks of the project"

        cursor.executemany("UPDATE tasks SET position = ? WHERE id = ?", pairs)

    return True, None


# ── Dependências ────────────────────────────────────────────────────

def is_active(task_id: int) -> bool:
    """True se a tarefa existe e não está arquivada (deleted=0)."""
    with connection() as conn:
        row = conn.execute(
            "SELECT 1 FROM tasks WHERE id = ? AND deleted = 0", (task_id,)
        ).fetchone()
        return row is not None


def would_create_cycle(task_id: int, depends_on_id: int) -> bool:
    """
    Adicionar (task_id depende de depends_on_id) fecha um ciclo se depends_on_id
    já alcança task_id pelas arestas existentes (DFS transitivo).
    """
    if task_id == depends_on_id:
        return True
    with connection() as conn:
        adj = {}
        for r in conn.execute(
            "SELECT task_id, depends_on_id FROM task_dependencies"
        ).fetchall():
            adj.setdefault(r['task_id'], []).append(r['depends_on_id'])
    stack = [depends_on_id]
    seen = set()
    while stack:
        cur = stack.pop()
        if cur == task_id:
            return True
        if cur in seen:
            continue
        seen.add(cur)
        stack.extend(adj.get(cur, []))
    return False


def list_dependencies(task_id: int):
    """IDs dos pré-requisitos (depends_on) de uma tarefa."""
    with connection() as conn:
        return [r['depends_on_id'] for r in conn.execute(
            "SELECT depends_on_id FROM task_dependencies WHERE task_id = ?", (task_id,)
        ).fetchall()]


def add_dependency(task_id: int, depends_on_id: int):
    """Cria o vínculo (idempotente) e devolve a lista atualizada de pré-requisitos."""
    with transaction() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id, created_at) "
            "VALUES (?, ?, ?)",
            (task_id, depends_on_id, datetime.utcnow().isoformat()),
        )
        deps = [r['depends_on_id'] for r in conn.execute(
            "SELECT depends_on_id FROM task_dependencies WHERE task_id = ?", (task_id,)
        ).fetchall()]
    return deps


def remove_dependency(task_id: int, depends_on_id: int) -> None:
    """Remove o vínculo (task_id depende de depends_on_id), se existir."""
    with transaction() as conn:
        conn.execute(
            "DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?",
            (task_id, depends_on_id),
        )


def today_br() -> str:
    """Data de criação no formato brasileiro (dd/mm/aaaa), como o produto usa."""
    return date.today().strftime("%d/%m/%Y")
