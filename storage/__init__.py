"""
Camada de storage (abstração de acesso a dados).

Todo o SQL do produto vive aqui, atrás de funções de repositório por domínio
(tasks, projects, users, integrations). O restante da aplicação (rotas,
scheduler, integrações) fala com esta camada em vez de escrever SQL inline.

Hoje o backend é SQLite (storage/db.py). Como o acesso está centralizado, trocar
para outro banco (ex.: Postgres) fica confinado a esta pasta — o "seam" de
storage previsto no roadmap.
"""

from .db import (
    get_db_path,
    get_db_connection,
    connection,
    transaction,
)

__all__ = [
    'get_db_path',
    'get_db_connection',
    'connection',
    'transaction',
]
