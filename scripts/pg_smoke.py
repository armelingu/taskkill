"""Smoke test do caminho Postgres (rodar manualmente, não é coletado pelo pytest).

Uso:
    TASKKILL_DATABASE_URL=postgresql://tk:tk@localhost:55432/tkdb \
    TASKKILL_ADMIN_PASSWORD=smoke-pass-123 TASKKILL_SECRET_KEY=x \
    python scripts/pg_smoke.py
"""

import os

os.environ.setdefault('TASKKILL_ADMIN_PASSWORD', 'smoke-pass-123')
os.environ.setdefault('TASKKILL_SECRET_KEY', 'x')

import database
from storage import tasks, projects, users, integrations as intg
from storage.db import transaction, is_postgres

assert is_postgres(), 'TASKKILL_DATABASE_URL precisa apontar para Postgres'

database.init_db()
print('init_db OK (postgres)')

# Projetos: create + duplicado
assert projects.create('PG-proj') is True
assert projects.create('PG-proj') is False
assert 'PG-proj' in projects.list_names()
print('projects OK')

# Tarefas: create (RETURNING id), posição, fetch agrupado
a = tasks.create('PG-proj', 'primeira', tasks.today_br(), None, 'none')
b = tasks.create('PG-proj', 'segunda', tasks.today_br(), '2030-01-01', 'daily')
assert isinstance(a['id'], int) and b['position'] == 1
grouped = tasks.fetch_tasks_grouped()
ids = [t['id'] for t in grouped['PG-proj']]
assert a['id'] in ids and b['id'] in ids
print('tasks create/fetch OK')

# Update: texto/completed/due/deleted
tasks.update(a['id'], text='nova', completed=1)
tasks.update(b['id'], deleted=1)
grouped = tasks.fetch_tasks_grouped()
assert any(t['id'] == a['id'] and t['text'] == 'nova' and t['completed'] for t in grouped['PG-proj'])
assert all(t['id'] != b['id'] for t in grouped.get('PG-proj', []))
print('tasks update OK')

# Reorder (única tarefa ativa restante)
ok, err = tasks.reorder([(0, a['id'])])
assert ok, err
print('reorder OK')

# Dependências: recria b, cria vínculo, ON CONFLICT idempotente, ciclo, remove
c = tasks.create('PG-proj', 'terceira', tasks.today_br(), None, 'none')
deps = tasks.add_dependency(c['id'], a['id'])
assert deps == [a['id']]
assert tasks.add_dependency(c['id'], a['id']) == [a['id']]  # idempotente (ON CONFLICT)
assert tasks.would_create_cycle(a['id'], c['id']) is True
tasks.remove_dependency(c['id'], a['id'])
assert tasks.list_dependencies(c['id']) == []
print('dependencias OK')

# Usuários: admin, tema, avatar (BYTEA), session_version
uid = int(users.get_auth_by_username('admin')['id'])
users.set_theme(uid, 'dark')
assert users.get_profile(uid)['theme_pref'] == 'dark'
png = b'\x89PNG\r\n\x1a\n' + b'\x00' * 8
users.set_avatar(uid, 'image/png', png)
mime, data = users.get_avatar(uid)
assert mime == 'image/png' and data == png
users.clear_avatar(uid)
assert users.get_avatar(uid) is None
sv = users.bump_session_version(uid)
assert isinstance(sv, int)
print('users OK')

# Integrações: CRUD (RETURNING), update dinâmico, run log, upsert (insert_task RETURNING + ensure_project ON CONFLICT)
import json
iid = intg.create('PG-intg', 1, json.dumps({'a': 1}), '2030-01-01T00:00:00', 0, 0, None)
assert intg.exists(iid)
intg.update_dynamic(iid, ['name = ?'], ['PG-intg-2', iid])
assert intg.get(iid)['name'] == 'PG-intg-2'
with transaction() as conn:
    intg.insert_run(conn, iid, '2030-01-01T00:00:00', '2030-01-01T00:00:01', 'manual', 'ok', 1, 1, 0, 0, None)
assert intg.list_runs(iid)[0]['status'] == 'ok'

import integrations as intg_biz
with transaction() as conn:
    created, updated, skipped = intg_biz._upsert_task(
        conn, iid, 'EXT-1', 'PG-proj', 'via integracao', '2030-02-02', 'skip',
        tasks.today_br(), '2030-01-01T00:00:00'
    )
assert (created, updated, skipped) == (1, 0, 0)
intg.delete(iid)
assert not intg.exists(iid)
print('integracoes OK')

print('\nTODOS OS SMOKES PASSARAM (Postgres)')
