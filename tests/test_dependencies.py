"""
Dependências entre tarefas: criação/remoção via API, guarda contra
autodependência e ciclos, e exposição de `depends_on` no GET /api/tasks.
"""


def _new_task(client, text='t', project='Dep'):
    r = client.post('/api/tasks', json={'project': project, 'text': text},
                    headers={'X-CSRF-Token': client.csrf})
    return r.get_json()['id']


def _add_dep(client, task_id, depends_on):
    return client.post(f'/api/tasks/{task_id}/dependencies',
                       json={'depends_on': depends_on},
                       headers={'X-CSRF-Token': client.csrf})


def _tasks(client):
    return client.get('/api/tasks').get_json()


def _find(data, task_id):
    for lst in data.values():
        for t in lst:
            if t['id'] == task_id:
                return t
    return None


def test_add_dependency_and_reflect_in_get(auth_client):
    a = _new_task(auth_client, 'A')
    b = _new_task(auth_client, 'B')

    resp = _add_dep(auth_client, a, b)   # A depende de B
    assert resp.status_code == 201
    assert resp.get_json()['depends_on'] == [b]

    task_a = _find(_tasks(auth_client), a)
    assert task_a['depends_on'] == [b]


def test_self_dependency_rejected(auth_client):
    a = _new_task(auth_client, 'A')
    resp = _add_dep(auth_client, a, a)
    assert resp.status_code == 400


def test_missing_task_rejected(auth_client):
    a = _new_task(auth_client, 'A')
    resp = _add_dep(auth_client, a, 999999)
    assert resp.status_code == 404


def test_direct_cycle_rejected(auth_client):
    a = _new_task(auth_client, 'A')
    b = _new_task(auth_client, 'B')
    assert _add_dep(auth_client, a, b).status_code == 201   # A -> B
    resp = _add_dep(auth_client, b, a)                       # B -> A fecharia ciclo
    assert resp.status_code == 409


def test_transitive_cycle_rejected(auth_client):
    a = _new_task(auth_client, 'A')
    b = _new_task(auth_client, 'B')
    c = _new_task(auth_client, 'C')
    assert _add_dep(auth_client, a, b).status_code == 201   # A -> B
    assert _add_dep(auth_client, b, c).status_code == 201   # B -> C
    resp = _add_dep(auth_client, c, a)                       # C -> A fecharia ciclo A->B->C->A
    assert resp.status_code == 409


def test_remove_dependency(auth_client):
    a = _new_task(auth_client, 'A')
    b = _new_task(auth_client, 'B')
    _add_dep(auth_client, a, b)

    resp = auth_client.delete(f'/api/tasks/{a}/dependencies/{b}',
                              headers={'X-CSRF-Token': auth_client.csrf})
    assert resp.status_code == 200
    task_a = _find(_tasks(auth_client), a)
    assert task_a['depends_on'] == []


def test_duplicate_dependency_is_idempotent(auth_client):
    a = _new_task(auth_client, 'A')
    b = _new_task(auth_client, 'B')
    assert _add_dep(auth_client, a, b).status_code == 201
    resp = _add_dep(auth_client, a, b)
    assert resp.status_code == 201
    assert resp.get_json()['depends_on'] == [b]
