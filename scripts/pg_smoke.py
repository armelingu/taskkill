"""Smoke test do caminho Postgres (rodar manualmente, não é coletado pelo pytest).

Cobre portabilidade (RETURNING/ON CONFLICT/BYTEA) e multi-tenant (posse por
usuário + isolamento entre dois usuários).

Uso:
    TASKKILL_DATABASE_URL=postgresql://tk:tk@localhost:55432/tkdb \
    TASKKILL_ADMIN_PASSWORD=smoke-pass-123 TASKKILL_SECRET_KEY=x \
    PYTHONPATH=. python scripts/pg_smoke.py
"""

import os
from datetime import datetime

os.environ.setdefault('TASKKILL_ADMIN_PASSWORD', 'smoke-pass-123')
os.environ.setdefault('TASKKILL_SECRET_KEY', 'x')

import database
from storage import tasks, projects, users, integrations as intg
from storage.db import transaction, connection, is_postgres

assert is_postgres(), 'TASKKILL_DATABASE_URL precisa apontar para Postgres'

database.init_db()
print('init_db OK (postgres)')

admin = int(users.get_auth_by_username('admin')['id'])

# Cria um segundo usuário para testar isolamento.
with transaction() as conn:
    row = conn.execute('SELECT id FROM users WHERE username = ?', ('bob',)).fetchone()
    if row is None:
        from database import hash_password
        from storage.db import insert_returning_id
        bob_id = insert_returning_id(
            conn,
            'INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, 0, ?)',
            ('bob', hash_password('bob-pass-123'), datetime.utcnow().isoformat()),
        )
    else:
        bob_id = int(row['id'])
print('segundo usuário OK (bob=%s)' % bob_id)

# Projetos: create + duplicado (por dono)
assert projects.create(admin, 'PG-proj') is True
assert projects.create(admin, 'PG-proj') is False
assert 'PG-proj' in projects.list_names(admin)
# Bob pode ter projeto com o MESMO nome (unicidade por usuário)
assert projects.create(bob_id, 'PG-proj') is True
print('projects OK (unicidade por dono)')

# Tarefas: create (RETURNING id), posição, fetch agrupado
a = tasks.create(admin, 'PG-proj', 'primeira', tasks.today_br(), None, 'none')
b = tasks.create(admin, 'PG-proj', 'segunda', tasks.today_br(), '2030-01-01', 'daily')
assert isinstance(a['id'], int) and b['position'] == 1
grouped = tasks.fetch_tasks_grouped(admin)
ids = [t['id'] for t in grouped['PG-proj']]
assert a['id'] in ids and b['id'] in ids
print('tasks create/fetch OK')

# Isolamento: bob não vê tasks do admin
bob_grouped = tasks.fetch_tasks_grouped(bob_id)
assert all(a['id'] != t['id'] for lst in bob_grouped.values() for t in lst)
# admin não consegue apagar task do bob
bt = tasks.create(bob_id, 'PG-proj', 'do bob', tasks.today_br(), None, 'none')
tasks.soft_delete(admin, bt['id'])  # no-op (dono errado)
assert any(bt['id'] == t['id'] for lst in tasks.fetch_tasks_grouped(bob_id).values() for t in lst)
print('isolamento OK')

# Update: texto/completed/due/deleted
tasks.update(admin, a['id'], text='nova', completed=1)
tasks.update(admin, b['id'], deleted=1)
grouped = tasks.fetch_tasks_grouped(admin)
assert any(t['id'] == a['id'] and t['text'] == 'nova' and t['completed'] for t in grouped['PG-proj'])
assert all(t['id'] != b['id'] for t in grouped.get('PG-proj', []))
print('tasks update OK')

# Reorder (única tarefa ativa restante do admin nesse projeto)
ok, err = tasks.reorder(admin, [(0, a['id'])])
assert ok, err
print('reorder OK')

# Dependências: recria b, cria vínculo, ON CONFLICT idempotente, ciclo, remove
c = tasks.create(admin, 'PG-proj', 'terceira', tasks.today_br(), None, 'none')
deps = tasks.add_dependency(c['id'], a['id'])
assert deps == [a['id']]
assert tasks.add_dependency(c['id'], a['id']) == [a['id']]  # idempotente (ON CONFLICT)
assert tasks.would_create_cycle(admin, a['id'], c['id']) is True
tasks.remove_dependency(admin, c['id'], a['id'])
assert tasks.list_dependencies(c['id']) == []
print('dependencias OK')

# Usuários: tema, avatar (BYTEA), session_version
users.set_theme(admin, 'dark')
assert users.get_profile(admin)['theme_pref'] == 'dark'
png = b'\x89PNG\r\n\x1a\n' + b'\x00' * 8
users.set_avatar(admin, 'image/png', png)
mime, data = users.get_avatar(admin)
assert mime == 'image/png' and bytes(data) == png
users.clear_avatar(admin)
assert users.get_avatar(admin) is None
assert isinstance(users.bump_session_version(admin), int)
print('users OK')

# Integrações: CRUD (RETURNING), owner, run log, upsert (insert_task RETURNING + ensure_project ON CONFLICT)
import json
iid = intg.create('PG-intg', 1, json.dumps({'a': 1}), '2030-01-01T00:00:00', 0, 0, None, admin)
assert intg.exists(iid)
assert int(intg.get(iid)['owner_user_id']) == admin
intg.update_dynamic(iid, ['name = ?'], ['PG-intg-2', iid])
assert intg.get(iid)['name'] == 'PG-intg-2'
with transaction() as conn:
    intg.insert_run(conn, iid, '2030-01-01T00:00:00', '2030-01-01T00:00:01', 'manual', 'ok', 1, 1, 0, 0, None)
assert intg.list_runs(iid)[0]['status'] == 'ok'

import integrations as intg_biz
with transaction() as conn:
    created, updated, skipped = intg_biz._upsert_task(
        conn, iid, admin, 'EXT-1', 'PG-proj', 'via integracao', '2030-02-02', 'skip',
        tasks.today_br(), '2030-01-01T00:00:00'
    )
assert (created, updated, skipped) == (1, 0, 0)
intg.delete(iid)
assert not intg.exists(iid)
print('integracoes OK')

print('\nTODOS OS SMOKES PASSARAM (Postgres + multi-tenant)')
