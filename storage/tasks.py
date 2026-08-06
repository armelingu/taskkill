"""
Repositório de tarefas: todo o SQL de `tasks` e `task_dependencies` vive aqui.

As rotas ficam com a validação/HTTP e delegam a persistência a estas funções.
Comportamento espelha 1:1 o que antes era SQL inline em routes.py.
"""

from datetime import date, datetime

from .db import connection, transaction, insert_returning_id

# Sentinela para distinguir "não enviado" de "enviado como vazio/None".
_UNSET = object()


# ── Leitura ─────────────────────────────────────────────────────────

def fetch_tasks_grouped(user_id: int) -> dict:
    """
    Tarefas ativas (deleted=0) DO USUÁRIO agrupadas por projeto, no formato que o
    front espera, já com `depends_on` (lista de pré-requisitos) por tarefa.
    """
    with connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM tasks WHERE user_id = ? AND deleted = 0 "
            "ORDER BY project ASC, position ASC, id ASC",
            (user_id,),
        )
        rows = cursor.fetchall()

        deps_by_task = {}
        for dep in cursor.execute(
            "SELECT d.task_id, d.depends_on_id FROM task_dependencies d "
            "JOIN tasks t ON t.id = d.task_id WHERE t.user_id = ?",
            (user_id,),
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


def _max_position(conn, user_id: int, project: str) -> int:
    """Maior posição ativa do projeto do usuário (ou -1 se vazio)."""
    row = conn.execute(
        "SELECT COALESCE(MAX(position), -1) AS max_pos "
        "FROM tasks WHERE user_id = ? AND project = ? AND deleted = 0",
        (user_id, project),
    ).fetchone()
    return int(row['max_pos']) if row and row['max_pos'] is not None else -1


# ── Log de conclusões (fonte dos Insights) ──────────────────────────

def _record_completion(conn, user_id: int, task_id: int, project, when: str) -> None:
    """Registra um evento de conclusão (append-only)."""
    conn.execute(
        "INSERT INTO task_completions (user_id, task_id, project, completed_at) "
        "VALUES (?, ?, ?, ?)",
        (user_id, task_id, project, when),
    )


def _remove_last_completion(conn, user_id: int, task_id: int) -> None:
    """Remove o evento de conclusão mais recente da tarefa (desmarcar)."""
    conn.execute(
        "DELETE FROM task_completions WHERE id = ("
        " SELECT id FROM task_completions WHERE user_id = ? AND task_id = ? "
        " ORDER BY id DESC LIMIT 1)",
        (user_id, task_id),
    )


# ── Escrita ─────────────────────────────────────────────────────────

def create(user_id: int, project: str, text: str, created_date: str, due_date, recurrence: str) -> dict:
    """Insere uma tarefa no fim do projeto do usuário e devolve o registro criado."""
    with transaction() as conn:
        new_pos = _max_position(conn, user_id, project) + 1
        task_id = insert_returning_id(
            conn,
            "INSERT INTO tasks (user_id, project, text, completed, created_date, due_date, position, deleted, recurrence) "
            "VALUES (?, ?, ?, 0, ?, ?, ?, 0, ?)",
            (user_id, project, text, created_date, due_date, new_pos, recurrence),
        )
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


def update(user_id: int, task_id: int, *, next_occurrence_fn=None,
           text=None, completed=None, due_date=_UNSET,
           recurrence=None, deleted=_UNSET, project=None):
    """
    Update parcial de uma tarefa DO USUÁRIO (valores já validados pela rota).
    Toda cláusula é escopada por user_id: uma tarefa de outro dono é inalcançável.
    Sentinelas:
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

        # Estado atual (antes do update): usado para instrumentar as conclusões
        # (só registramos na transição 0→1) e para decidir o reagendamento.
        prior_completed = None
        prior_project = None
        prior_rule = 'none'
        prior_due = None
        if completed is not None:
            prow = cursor.execute(
                "SELECT completed, project, recurrence, due_date FROM tasks WHERE id = ? AND user_id = ?",
                (task_id, user_id),
            ).fetchone()
            if prow is not None:
                prior_completed = int(prow['completed'])
                prior_project = prow['project']
                prior_rule = (prow['recurrence'] if 'recurrence' in prow.keys() else 'none') or 'none'
                prior_due = prow['due_date'] if 'due_date' in prow.keys() else None

        # Horário LOCAL de propósito: os Insights agrupam conclusões por dia/semana
        # comparando com date.today() (local). Gravar em UTC deslocaria a conclusão
        # para o dia seguinte perto da meia-noite e quebraria streak/throughput.
        now_iso = datetime.now().isoformat()

        # Tarefa recorrente: concluir reagenda (não fica completed=1), mas é uma
        # conclusão real — registra no log e não segue o caminho normal.
        if (completed == 1 and next_occurrence_fn is not None
                and prior_rule != 'none' and prior_due):
            nxt = next_occurrence_fn(prior_due, prior_rule)
            if nxt:
                cursor.execute(
                    "UPDATE tasks SET due_date = ?, completed = 0 WHERE id = ? AND user_id = ?",
                    (nxt, task_id, user_id),
                )
                recurred_to = nxt
                _record_completion(conn, user_id, task_id, prior_project, now_iso)
                completed = None  # já tratado

        if text is not None and completed is not None:
            cursor.execute("UPDATE tasks SET text = ?, completed = ? WHERE id = ? AND user_id = ?", (text, completed, task_id, user_id))
        elif text is not None:
            cursor.execute("UPDATE tasks SET text = ? WHERE id = ? AND user_id = ?", (text, task_id, user_id))
        elif completed is not None:
            cursor.execute("UPDATE tasks SET completed = ? WHERE id = ? AND user_id = ?", (completed, task_id, user_id))

        # Instrumenta conclusão/desmarque de tarefa não-recorrente.
        if completed == 1 and prior_completed == 0:
            _record_completion(conn, user_id, task_id, prior_project, now_iso)
        elif completed == 0 and prior_completed == 1:
            _remove_last_completion(conn, user_id, task_id)

        if due_date is not _UNSET:
            cursor.execute("UPDATE tasks SET due_date = ? WHERE id = ? AND user_id = ?", (due_date, task_id, user_id))

        if recurrence is not None:
            cursor.execute("UPDATE tasks SET recurrence = ? WHERE id = ? AND user_id = ?", (recurrence, task_id, user_id))

        if deleted is not _UNSET:
            cursor.execute("UPDATE tasks SET deleted = ? WHERE id = ? AND user_id = ?", (deleted, task_id, user_id))

        if project is not None:
            new_pos = _max_position(conn, user_id, project) + 1
            cursor.execute(
                "UPDATE tasks SET project = ?, position = ? WHERE id = ? AND user_id = ?",
                (project, new_pos, task_id, user_id),
            )

    return recurred_to


def soft_delete(user_id: int, task_id: int) -> None:
    """Arquiva a tarefa do usuário (flag deleted=1), consistente com o modelo."""
    with transaction() as conn:
        conn.execute("UPDATE tasks SET deleted = 1 WHERE id = ? AND user_id = ?", (task_id, user_id))


def reorder(user_id: int, pairs):
    """
    Aplica novas posições nas tarefas DO USUÁRIO. `pairs` é uma lista de
    (position, task_id) já sanitizada (ids únicos, positions >= 0). Exige que o
    conjunto seja de UM único projeto e cubra TODAS as tarefas ativas dele.

    Retorna (ok: bool, error: str|None).
    """
    ids = [tid for (_pos, tid) in pairs]
    if not ids:
        return True, None

    with transaction() as conn:
        cursor = conn.cursor()
        qmarks = ",".join(["?"] * len(ids))
        cursor.execute(
            f"SELECT DISTINCT project FROM tasks WHERE user_id = ? AND deleted = 0 AND id IN ({qmarks})",
            [user_id, *ids],
        )
        projects = [r['project'] for r in cursor.fetchall()]
        if len(projects) != 1:
            return False, "Bad Request: reorder must target a single project"

        project = projects[0]
        cnt = cursor.execute(
            "SELECT COUNT(*) AS cnt FROM tasks WHERE user_id = ? AND project = ? AND deleted = 0",
            (user_id, project),
        ).fetchone()['cnt']
        if int(cnt) != len(ids):
            return False, "Bad Request: reorder must include all active tasks of the project"

        cursor.executemany(
            "UPDATE tasks SET position = ? WHERE id = ? AND user_id = ?",
            [(pos, tid, user_id) for (pos, tid) in pairs],
        )

    return True, None


# ── Dependências ────────────────────────────────────────────────────

def is_active(user_id: int, task_id: int) -> bool:
    """True se a tarefa do usuário existe e não está arquivada (deleted=0)."""
    with connection() as conn:
        row = conn.execute(
            "SELECT 1 FROM tasks WHERE id = ? AND user_id = ? AND deleted = 0",
            (task_id, user_id),
        ).fetchone()
        return row is not None


def would_create_cycle(user_id: int, task_id: int, depends_on_id: int) -> bool:
    """
    Adicionar (task_id depende de depends_on_id) fecha um ciclo se depends_on_id
    já alcança task_id pelas arestas existentes (DFS transitivo). Considera apenas
    as arestas entre tarefas do próprio usuário.
    """
    if task_id == depends_on_id:
        return True
    with connection() as conn:
        adj = {}
        for r in conn.execute(
            "SELECT d.task_id, d.depends_on_id FROM task_dependencies d "
            "JOIN tasks t ON t.id = d.task_id WHERE t.user_id = ?",
            (user_id,),
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
            "INSERT INTO task_dependencies (task_id, depends_on_id, created_at) "
            "VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
            (task_id, depends_on_id, datetime.utcnow().isoformat()),
        )
        deps = [r['depends_on_id'] for r in conn.execute(
            "SELECT depends_on_id FROM task_dependencies WHERE task_id = ?", (task_id,)
        ).fetchall()]
    return deps


def remove_dependency(user_id: int, task_id: int, depends_on_id: int) -> None:
    """
    Remove o vínculo (task_id depende de depends_on_id), se existir e se a tarefa
    pertencer ao usuário (impede apagar dependência de terceiros).
    """
    with transaction() as conn:
        conn.execute(
            "DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_id = ? "
            "AND task_id IN (SELECT id FROM tasks WHERE user_id = ?)",
            (task_id, depends_on_id, user_id),
        )


def today_br() -> str:
    """Data de criação no formato brasileiro (dd/mm/aaaa), como o produto usa."""
    return date.today().strftime("%d/%m/%Y")
