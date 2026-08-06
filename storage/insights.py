"""
Insights pessoais: métricas de produtividade derivadas do log de conclusões
(`task_completions`) e do estado atual de `tasks`.

A agregação é feita em Python (não em SQL) de propósito: as datas são TEXT em
formatos diferentes (completed_at/due_date em ISO, created_date em dd/mm/aaaa) e
computar aqui mantém tudo portável entre SQLite e Postgres, sem funções de data
específicas de dialeto.

Fatos do modelo que moldam o cálculo:
- Não há timestamp de conclusão nas tasks; o histórico vem do log append-only.
  Portanto throughput/streak começam a valer a partir de quando o log passou a
  ser gravado (sem backfill retroativo).
- created_date é dd/mm/aaaa (pode ser nulo em dados antigos) → aging tolera nulo.
"""

from datetime import date, datetime, timedelta

from .db import connection


def _parse_iso_date(value):
    """Data (YYYY-MM-DD…) de um ISO datetime/date em TEXT; None se inválido."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(value).date()
    except (ValueError, TypeError):
        try:
            return datetime.strptime(str(value)[:10], "%Y-%m-%d").date()
        except (ValueError, TypeError):
            return None


def _parse_br_date(value):
    """Data de um created_date no padrão brasileiro (dd/mm/aaaa); None se inválido."""
    if not value:
        return None
    try:
        return datetime.strptime(str(value).strip(), "%d/%m/%Y").date()
    except (ValueError, TypeError):
        return None


def _streaks(date_set, today):
    """(streak atual terminando hoje, melhor streak) a partir de um conjunto de datas."""
    if not date_set:
        return 0, 0

    best = 0
    run = 0
    prev = None
    for d in sorted(date_set):
        run = run + 1 if (prev is not None and d == prev + timedelta(days=1)) else 1
        best = max(best, run)
        prev = d

    current = 0
    d = today
    while d in date_set:
        current += 1
        d -= timedelta(days=1)
    return current, best


def compute(user_id: int, *, weeks: int = 12, aging_limit: int = 8, today=None) -> dict:
    """Monta o payload de Insights do usuário (ver formato no fim da função)."""
    today = today or date.today()

    with connection() as conn:
        comp_rows = conn.execute(
            "SELECT completed_at FROM task_completions WHERE user_id = ? ORDER BY completed_at",
            (user_id,),
        ).fetchall()

        open_rows = conn.execute(
            "SELECT id, text, project, created_date, due_date FROM tasks "
            "WHERE user_id = ? AND completed = 0 AND deleted = 0",
            (user_id,),
        ).fetchall()

        counts_row = conn.execute(
            "SELECT SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) AS done, "
            "COUNT(*) AS total FROM tasks WHERE user_id = ? AND deleted = 0",
            (user_id,),
        ).fetchone()

        # Pré-requisitos ainda abertos por tarefa (para o rótulo "bloqueada por N").
        dep_rows = conn.execute(
            "SELECT d.task_id AS tid, "
            "SUM(CASE WHEN p.completed = 0 AND p.deleted = 0 THEN 1 ELSE 0 END) AS blocked "
            "FROM task_dependencies d "
            "JOIN tasks t ON t.id = d.task_id "
            "JOIN tasks p ON p.id = d.depends_on_id "
            "WHERE t.user_id = ? "
            "GROUP BY d.task_id",
            (user_id,),
        ).fetchall()

    # ── Conclusões: throughput semanal, streak e últimos 7 dias ──────────
    comp_dates = [d for d in (_parse_iso_date(r['completed_at']) for r in comp_rows) if d]
    comp_date_set = set(comp_dates)

    done_7d = sum(1 for d in comp_dates if d >= today - timedelta(days=6))

    monday = today - timedelta(days=today.weekday())
    per_week = {}
    for d in comp_dates:
        wk = d - timedelta(days=d.weekday())
        per_week[wk] = per_week.get(wk, 0) + 1
    throughput = []
    for i in range(weeks - 1, -1, -1):
        wk = monday - timedelta(weeks=i)
        throughput.append({"week": wk.isoformat(), "count": int(per_week.get(wk, 0))})

    streak_current, streak_best = _streaks(comp_date_set, today)

    # ── Aging / gargalos das tarefas abertas ─────────────────────────────
    blocked_map = {int(r['tid']): int(r['blocked'] or 0) for r in dep_rows}
    aging_all = []
    for r in open_rows:
        created = _parse_br_date(r['created_date'])
        age = (today - created).days if created else None
        due = (r['due_date'] or '').strip() if r['due_date'] is not None else ''
        due_date = _parse_iso_date(due) if due else None
        aging_all.append({
            "id": int(r['id']),
            "text": r['text'],
            "project": r['project'],
            "age_days": age,
            "overdue": bool(due_date and due_date < today),
            "blocked_by": blocked_map.get(int(r['id']), 0),
        })

    # Ordena: atrasadas primeiro, depois mais antigas (idade desconhecida por último).
    aging_all.sort(key=lambda x: (
        0 if x['overdue'] else 1,
        -(x['age_days'] if x['age_days'] is not None else -1),
    ))
    aging = aging_all[:aging_limit]
    oldest_open_days = max(
        (x['age_days'] for x in aging_all if x['age_days'] is not None), default=0
    )

    done = int(counts_row['done'] or 0) if counts_row else 0
    total = int(counts_row['total'] or 0) if counts_row else 0
    completion_rate = round(done / total, 3) if total else 0.0

    return {
        "summary": {
            "done_7d": done_7d,
            "completion_rate": completion_rate,
            "streak_current": streak_current,
            "oldest_open_days": oldest_open_days,
            "open_count": len(open_rows),
        },
        "throughput": throughput,
        "streak": {"current": streak_current, "best": streak_best},
        "aging": aging,
    }
