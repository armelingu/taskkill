"""
Repositório de projetos: SQL da tabela `projects`.

Multi-tenant: cada projeto pertence a um usuário (user_id) e a unicidade é por
dono — dois usuários podem ter um projeto com o mesmo nome.
"""

from .db import connection, transaction


def list_names(user_id: int):
    """Nomes de projeto do usuário em ordem alfabética."""
    with connection() as conn:
        rows = conn.execute(
            "SELECT name FROM projects WHERE user_id = ? ORDER BY name ASC", (user_id,)
        ).fetchall()
    return [r['name'] for r in rows]


def create(user_id: int, name: str) -> bool:
    """
    Cria um projeto do usuário. Retorna False se já existir para esse dono
    (violação de UNIQUE(user_id, name)), como o endpoint espera para responder
    409. Usa ON CONFLICT DO NOTHING (portável SQLite/Postgres): rowcount == 0
    indica que já existia.
    """
    with transaction() as conn:
        cur = conn.execute(
            "INSERT INTO projects (user_id, name) VALUES (?, ?) ON CONFLICT DO NOTHING",
            (user_id, name),
        )
        return cur.rowcount == 1


def delete(user_id: int, name: str) -> None:
    """Remove o projeto do usuário e arquiva (deleted=1) as tarefas dele nesse projeto."""
    with transaction() as conn:
        conn.execute("DELETE FROM projects WHERE user_id = ? AND name = ?", (user_id, name))
        conn.execute(
            "UPDATE tasks SET deleted = 1 WHERE user_id = ? AND project = ?", (user_id, name)
        )
