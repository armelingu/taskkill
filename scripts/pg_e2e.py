"""E2E HTTP contra Postgres: sobe o app real (rotas Flask) apontado para o
Postgres e exercita cadastro -> criar projeto/tarefa -> isolamento entre
usuarios, tudo pela API. Rodar manualmente (nao coletado pelo pytest).

Uso:
    TASKKILL_DATABASE_URL=postgresql://tk:tk@localhost:55432/tkdb \
    TASKKILL_ADMIN_PASSWORD=smoke-pass-123 TASKKILL_SECRET_KEY=x \
    PYTHONPATH=. python scripts/pg_e2e.py
"""

import os

os.environ.setdefault('TASKKILL_ADMIN_PASSWORD', 'smoke-pass-123')
os.environ.setdefault('TASKKILL_SECRET_KEY', 'x')
os.environ['TASKKILL_DEBUG'] = '1'  # nao sobe o scheduler

import app as app_module  # importa -> roda init_db() no Postgres

app = app_module.app
app.config.update(TESTING=True)


def _csrf(c):
    with c.session_transaction() as sess:
        return sess.get('csrf_token')


def _register(c, username, password):
    c.get('/register')
    return c.post('/register', data={
        'username': username, 'password': password,
        'confirm_password': password, 'csrf_token': _csrf(c),
    })


def _task_ids(c):
    data = c.get('/api/tasks').get_json()
    return [t['id'] for lst in data.values() for t in lst]


alice = app.test_client()
r = _register(alice, 'alice', 'senha-bem-longa-123')
assert r.status_code == 302, ('register alice', r.status_code)
print('cadastro alice OK (login automatico)')

# Alice cria projeto + tarefa
r = alice.post('/api/projects', json={'name': 'Alpha'}, headers={'X-CSRF-Token': _csrf(alice)})
assert r.status_code == 201, ('proj alice', r.status_code, r.data)
r = alice.post('/api/tasks', json={'project': 'Alpha', 'text': 'tarefa da alice'},
               headers={'X-CSRF-Token': _csrf(alice)})
assert r.status_code == 201, ('task alice', r.status_code, r.data)
alice_task = r.get_json()['id']
print('alice criou projeto+tarefa OK (task=%s)' % alice_task)

# Bob se cadastra: workspace vazio e isolado
bob = app.test_client()
r = _register(bob, 'bob', 'senha-bem-longa-123')
assert r.status_code == 302, ('register bob', r.status_code)
assert bob.get('/api/tasks').get_json() == {}, 'bob deveria comecar sem tarefas'
assert 'Alpha' not in bob.get('/api/projects').get_json(), 'bob nao deveria ver projeto da alice'
assert alice_task not in _task_ids(bob)
print('bob cadastrado com workspace vazio e isolado OK')

# Bob cria projeto com o MESMO nome (unicidade por dono)
r = bob.post('/api/projects', json={'name': 'Alpha'}, headers={'X-CSRF-Token': _csrf(bob)})
assert r.status_code == 201, ('proj bob mesmo nome', r.status_code, r.data)
r = bob.post('/api/tasks', json={'project': 'Alpha', 'text': 'tarefa do bob'},
             headers={'X-CSRF-Token': _csrf(bob)})
bob_task = r.get_json()['id']
print('bob criou projeto homonimo OK (task=%s)' % bob_task)

# Alice nao ve a tarefa do bob; nao consegue apagar nem editar
assert bob_task not in _task_ids(alice)
alice.delete(f'/api/tasks/{bob_task}', headers={'X-CSRF-Token': _csrf(alice)})
assert bob_task in _task_ids(bob), 'alice nao deveria apagar tarefa do bob'
alice.put(f'/api/tasks/{bob_task}', json={'text': 'hackeado'}, headers={'X-CSRF-Token': _csrf(alice)})
data = bob.get('/api/tasks').get_json()
bob_txt = next(t['text'] for lst in data.values() for t in lst if t['id'] == bob_task)
assert bob_txt == 'tarefa do bob', 'alice nao deveria editar tarefa do bob'
print('isolamento de escrita OK (alice nao mexe no bob)')

# Login normal tambem funciona (admin criado no boot)
admin = app.test_client()
admin.get('/login')
r = admin.post('/login', data={
    'username': 'admin', 'password': os.environ['TASKKILL_ADMIN_PASSWORD'],
    'csrf_token': _csrf(admin),
})
assert r.status_code == 302, ('login admin', r.status_code)
print('login admin OK')

# Duplicado barrado
dup = app.test_client()
r = _register(dup, 'alice', 'outra-senha-longa-123')
assert r.status_code == 409, ('dup', r.status_code)
print('cadastro duplicado barrado (409) OK')

print('\nE2E HTTP no POSTGRES: TODOS OS PASSOS OK')
