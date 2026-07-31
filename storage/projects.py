"""
Repositório de projetos: SQL da tabela `projects`.
"""

from .db import connection, transaction


def list_names():
    """Nomes de projeto em ordem alfabética."""
    with connection() as conn:
        rows = conn.execute("SELECT name FROM projects ORDER BY name ASC").fetchall()
    return [r['name'] for r in rows]


def create(name: str) -> bool:
    """
    Cria um projeto. Retorna False se já existir (violação de UNIQUE), como o
    endpoint espera para responder 409. Usa ON CONFLICT DO NOTHING (portável
    SQLite/Postgres): rowcount == 0 indica que já existia.
    """
    with transaction() as conn:
        cur = conn.execute(
            "INSERT INTO projects (name) VALUES (?) ON CONFLICT DO NOTHING", (name,)
        )
        return cur.rowcount == 1


def delete(name: str) -> None:
    """Remove o projeto e arquiva (deleted=1) as tarefas que apontam para ele."""
    with transaction() as conn:
        conn.execute("DELETE FROM projects WHERE name = ?", (name,))
        conn.execute("UPDATE tasks SET deleted = 1 WHERE project = ?", (name,))
