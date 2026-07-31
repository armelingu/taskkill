"""
Isolamento multi-tenant: cada usuário só enxerga/gerencia os próprios projetos e
tarefas. Um usuário não vê, edita nem apaga dados de outro, e dois usuários podem
ter projetos com o mesmo nome (unicidade por dono).
"""

from datetime import datetime

import database
from conftest import _login, _csrf_of, ADMIN_USER, ADMIN_PASSWORD

BOB_USER = 'bob'
BOB_PASS = 'bob-secret-pass-123'


def _ensure_user(username, password, is_admin=0):
    from database import hash_password
    with database.get_db_connection() as conn:
        row = conn.execute('SELECT id FROM users WHERE username = ?', (username,)).fetchone()
        if row:
            return int(row['id'])
        cur = conn.execute(
            'INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)',
            (username, hash_password(password), is_admin, datetime.utcnow().isoformat()),
        )
        conn.commit()
        return cur.lastrowid


def _client(flask_app, username, password):
    c = flask_app.test_client()
    _login(c, username=username, password=password)
    c.csrf = _csrf_of(c)
    return c


def _all_task_ids(client):
    data = client.get('/api/tasks').get_json()
    return [t['id'] for lst in data.values() for t in lst]


def _find_task(client, task_id):
    data = client.get('/api/tasks').get_json()
    for lst in data.values():
        for t in lst:
            if t['id'] == task_id:
                return t
    return None


def test_tasks_and_projects_are_isolated_per_user(flask_app):
    _ensure_user(BOB_USER, BOB_PASS)

    admin = _client(flask_app, ADMIN_USER, ADMIN_PASSWORD)
    bob = _client(flask_app, BOB_USER, BOB_PASS)

    proj = 'compartilhado'  # mesmo nome para os dois (<= 18 chars)

    # Admin cria projeto + tarefa
    r = admin.post('/api/projects', json={'name': proj}, headers={'X-CSRF-Token': admin.csrf})
    assert r.status_code == 201
    r = admin.post('/api/tasks', json={'project': proj, 'text': 'do admin'},
                   headers={'X-CSRF-Token': admin.csrf})
    admin_task_id = r.get_json()['id']

    # Bob não enxerga projeto nem tarefa do admin
    assert proj not in bob.get('/api/projects').get_json()
    assert admin_task_id not in _all_task_ids(bob)

    # Bob cria um projeto com o MESMO nome (unicidade é por dono) -> 201
    r = bob.post('/api/projects', json={'name': proj}, headers={'X-CSRF-Token': bob.csrf})
    assert r.status_code == 201
    r = bob.post('/api/tasks', json={'project': proj, 'text': 'do bob'},
                 headers={'X-CSRF-Token': bob.csrf})
    bob_task_id = r.get_json()['id']

    # Admin não enxerga a tarefa do Bob
    assert bob_task_id not in _all_task_ids(admin)

    # Admin NÃO consegue apagar a tarefa do Bob (escopo por user_id)
    admin.delete(f'/api/tasks/{bob_task_id}', headers={'X-CSRF-Token': admin.csrf})
    assert bob_task_id in _all_task_ids(bob)

    # Admin NÃO consegue editar o texto da tarefa do Bob
    admin.put(f'/api/tasks/{bob_task_id}', json={'text': 'hackeado'},
              headers={'X-CSRF-Token': admin.csrf})
    assert _find_task(bob, bob_task_id)['text'] == 'do bob'


def test_dependencies_cannot_cross_users(flask_app):
    _ensure_user(BOB_USER, BOB_PASS)
    admin = _client(flask_app, ADMIN_USER, ADMIN_PASSWORD)
    bob = _client(flask_app, BOB_USER, BOB_PASS)

    # Admin cria uma tarefa
    r = admin.post('/api/tasks', json={'project': 'admdep', 'text': 'a-admin'},
                   headers={'X-CSRF-Token': admin.csrf})
    admin_task_id = r.get_json()['id']

    # Bob cria uma tarefa e tenta depender da tarefa do admin -> 404 (inalcançável)
    r = bob.post('/api/tasks', json={'project': 'bobdep', 'text': 'b-bob'},
                 headers={'X-CSRF-Token': bob.csrf})
    bob_task_id = r.get_json()['id']

    r = bob.post(f'/api/tasks/{bob_task_id}/dependencies',
                 json={'depends_on': admin_task_id},
                 headers={'X-CSRF-Token': bob.csrf})
    assert r.status_code == 404
