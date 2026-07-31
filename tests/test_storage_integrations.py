"""
Testes do repositório de integrações (storage/integrations.py) — foco nas
funções que abrem a própria conexão (CRUD admin).
"""

import json

import pytest

import database
from storage import integrations as store
from storage.db import transaction


@pytest.fixture(scope='module', autouse=True)
def _schema():
    database.init_db()


def _create(name):
    return store.create(name, 1, json.dumps({'a': 1}), '2026-01-01T00:00:00',
                        0, 0, None)


def test_create_get_exists():
    iid = _create('Repo-CRUD-1')
    assert isinstance(iid, int)
    assert store.exists(iid) is True

    row = store.get(iid)
    assert row is not None
    assert row['name'] == 'Repo-CRUD-1'
    assert row['last_status'] == 'never'

    assert store.get_config_json(iid) == json.dumps({'a': 1})
    ci = store.get_config_and_interval(iid)
    assert ci['schedule_interval_minutes'] == 0


def test_list_all_contains_created():
    iid = _create('Repo-CRUD-2')
    names = [r['name'] for r in store.list_all()]
    assert 'Repo-CRUD-2' in names
    # Ordenado por nome
    assert names == sorted(names)
    assert iid  # usado


def test_update_dynamic():
    iid = _create('Repo-CRUD-3')
    store.update_dynamic(iid, ['name = ?', 'enabled = ?'], ['Renomeada', 0, iid])
    row = store.get(iid)
    assert row['name'] == 'Renomeada'
    assert int(row['enabled']) == 0


def test_delete_remove_integracao_e_itens():
    iid = _create('Repo-CRUD-4')
    store.delete(iid)
    assert store.exists(iid) is False
    assert store.get(iid) is None


def test_list_runs():
    iid = _create('Repo-CRUD-5')
    with transaction() as conn:
        store.insert_run(conn, iid, '2026-01-01T00:00:00', '2026-01-01T00:00:01',
                         'manual', 'ok', 3, 2, 1, 0, None)
    runs = store.list_runs(iid, limit=10)
    assert len(runs) == 1
    assert runs[0]['status'] == 'ok'
    assert runs[0]['total_items'] == 3
    assert runs[0]['created'] == 2


def test_exists_false_para_inexistente():
    assert store.exists(987654) is False
    assert store.get_config_json(987654) is None
