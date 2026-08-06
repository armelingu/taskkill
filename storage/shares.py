"""
Repositório de compartilhamento de projetos (colaboração leve, overlay).

Modelo: as tarefas continuam pertencendo ao dono (tasks.user_id). Um projeto do
dono pode ser liberado para outro usuário (member_id) como 'viewer' (só lê) ou
'editor' (cria/edita/conclui). Este repo resolve o ACESSO — as rotas usam o
owner_id devolvido como escopo das operações no repo de tasks, reaproveitando
todo o SQL já escopado por user_id.

Papéis: 'owner' (dono, implícito), 'editor', 'viewer'.
"""

from datetime import datetime

from .db import connection, transaction

VALID_ROLES = ('viewer', 'editor')


def share(owner_id: int, project: str, member_id: int, role: str) -> None:
    """Concede (ou atualiza) o acesso de `member_id` ao projeto do dono."""
    with transaction() as conn:
        conn.execute(
            "INSERT INTO project_shares (owner_id, project, member_id, role, created_at) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT (owner_id, project, member_id) DO UPDATE SET role = excluded.role",
            (owner_id, project, member_id, role, datetime.now().isoformat()),
        )


def unshare(owner_id: int, project: str, member_id: int) -> None:
    """Revoga o acesso de um membro ao projeto do dono."""
    with transaction() as conn:
        conn.execute(
            "DELETE FROM project_shares WHERE owner_id = ? AND project = ? AND member_id = ?",
            (owner_id, project, member_id),
        )


def unshare_all(owner_id: int, project: str) -> None:
    """Remove todos os compartilhamentos de um projeto (usado ao apagar o projeto)."""
    with transaction() as conn:
        conn.execute(
            "DELETE FROM project_shares WHERE owner_id = ? AND project = ?",
            (owner_id, project),
        )


def list_members(owner_id: int, project: str):
    """Membros com acesso ao projeto do dono: [{member_id, username, role}]."""
    with connection() as conn:
        rows = conn.execute(
            "SELECT s.member_id AS member_id, u.username AS username, s.role AS role "
            "FROM project_shares s JOIN users u ON u.id = s.member_id "
            "WHERE s.owner_id = ? AND s.project = ? ORDER BY u.username ASC",
            (owner_id, project),
        ).fetchall()
    return [
        {"member_id": int(r['member_id']), "username": r['username'], "role": r['role']}
        for r in rows
    ]


def list_shared_with_me(member_id: int):
    """Projetos que outros donos compartilharam comigo: [{owner_id, owner_username, project, role}]."""
    with connection() as conn:
        rows = conn.execute(
            "SELECT s.owner_id AS owner_id, u.username AS owner_username, "
            "       s.project AS project, s.role AS role "
            "FROM project_shares s JOIN users u ON u.id = s.owner_id "
            "WHERE s.member_id = ? ORDER BY u.username ASC, s.project ASC",
            (member_id,),
        ).fetchall()
    return [
        {
            "owner_id": int(r['owner_id']),
            "owner_username": r['owner_username'],
            "project": r['project'],
            "role": r['role'],
        }
        for r in rows
    ]


def get_project_access(actor_id: int, owner_id: int, project: str):
    """
    Papel do ator sobre (owner_id, project): 'owner' se for o dono, 'editor'/
    'viewer' se houver compartilhamento, ou None se não tiver acesso.
    """
    if int(actor_id) == int(owner_id):
        return 'owner'
    with connection() as conn:
        row = conn.execute(
            "SELECT role FROM project_shares WHERE owner_id = ? AND project = ? AND member_id = ?",
            (owner_id, project, actor_id),
        ).fetchone()
    return (row['role'] or 'viewer') if row else None


def get_task_access(actor_id: int, task_id: int):
    """
    (owner_id, role) para uma tarefa: role em {'owner','editor','viewer'} ou
    (owner_id, None) se o ator não tem acesso; (None, None) se a tarefa não existe.
    """
    with connection() as conn:
        row = conn.execute(
            "SELECT user_id AS owner_id, project FROM tasks WHERE id = ?", (task_id,)
        ).fetchone()
        if row is None:
            return (None, None)
        owner_id = int(row['owner_id']) if row['owner_id'] is not None else None
        project = row['project']
        if owner_id == int(actor_id):
            return (owner_id, 'owner')
        srow = conn.execute(
            "SELECT role FROM project_shares WHERE owner_id = ? AND project = ? AND member_id = ?",
            (owner_id, project, actor_id),
        ).fetchone()
    return (owner_id, (srow['role'] or 'viewer')) if srow else (owner_id, None)
