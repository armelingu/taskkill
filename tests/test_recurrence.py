"""
Testes de recorrência: lógica pura (next_occurrence) + comportamento do
endpoint (reagenda a mesma tarefa ao concluir uma recorrente).
"""

import pytest

from recurrence import next_occurrence, valid_recurrence


# ── Lógica pura ────────────────────────────────────────────────────
def test_valid_recurrence_accepts_known_rules():
    for r in ('none', 'daily', 'weekdays', 'weekly', 'monthly'):
        assert valid_recurrence(r)


def test_valid_recurrence_rejects_unknown():
    for r in ('', 'yearly', 'DAILY', 'every-2-days', None):
        assert not valid_recurrence(r)


def test_next_occurrence_daily_and_weekly():
    assert next_occurrence('2026-07-30', 'daily') == '2026-07-31'
    assert next_occurrence('2026-07-30', 'weekly') == '2026-08-06'


@pytest.mark.parametrize('base,expected', [
    ('2026-07-31', '2026-08-03'),  # sexta -> segunda (pula fim de semana)
    ('2026-08-01', '2026-08-03'),  # sábado -> segunda
    ('2026-08-02', '2026-08-03'),  # domingo -> segunda
    ('2026-07-30', '2026-07-31'),  # quinta -> sexta
])
def test_next_occurrence_weekdays_skips_weekend(base, expected):
    assert next_occurrence(base, 'weekdays') == expected


def test_next_occurrence_monthly_clamps_end_of_month():
    assert next_occurrence('2026-01-31', 'monthly') == '2026-02-28'
    assert next_occurrence('2026-03-15', 'monthly') == '2026-04-15'


def test_next_occurrence_none_and_empty():
    assert next_occurrence('2026-07-30', 'none') is None
    assert next_occurrence('', 'daily') is None
    assert next_occurrence('nao-e-data', 'daily') is None


# ── Endpoint: concluir recorrente reagenda a mesma tarefa ──────────
def _create_task(client, **fields):
    payload = {'project': 'Rec', 'text': 'tarefa', **fields}
    return client.post('/api/tasks', json=payload, headers={'X-CSRF-Token': client.csrf})


def test_create_task_accepts_recurrence(auth_client):
    resp = _create_task(auth_client, due_date='2026-07-30', recurrence='daily')
    assert resp.status_code == 201
    body = resp.get_json()
    assert body['recurrence'] == 'daily'
    assert body['due_date'] == '2026-07-30'


def test_create_task_rejects_bad_recurrence(auth_client):
    resp = _create_task(auth_client, recurrence='yearly')
    assert resp.status_code == 400


def test_completing_recurring_reschedules_same_task(auth_client):
    created = _create_task(auth_client, due_date='2026-07-30', recurrence='daily').get_json()
    tid = created['id']

    resp = auth_client.put(
        f'/api/tasks/{tid}', json={'completed': True},
        headers={'X-CSRF-Token': auth_client.csrf},
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert body.get('recurred') is True
    assert body.get('completed') is False
    assert body.get('due_date') == '2026-07-31'

    # A tarefa continua viva (não concluída) e com a nova data.
    tasks = auth_client.get('/api/tasks').get_json()
    task = next(t for t in tasks['Rec'] if t['id'] == tid)
    assert task['completed'] is False
    assert task['due_date'] == '2026-07-31'
    assert task['recurrence'] == 'daily'


def test_completing_non_recurring_still_completes(auth_client):
    created = _create_task(auth_client, due_date='2026-07-30').get_json()
    tid = created['id']

    resp = auth_client.put(
        f'/api/tasks/{tid}', json={'completed': True},
        headers={'X-CSRF-Token': auth_client.csrf},
    )
    assert resp.status_code == 200
    assert 'recurred' not in resp.get_json()

    tasks = auth_client.get('/api/tasks').get_json()
    task = next(t for t in tasks['Rec'] if t['id'] == tid)
    assert task['completed'] is True
