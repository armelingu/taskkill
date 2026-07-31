"""
Testes do repositório de tarefas (storage/tasks.py).

Exercitam a camada de storage diretamente (sem HTTP), garantindo que o SQL
extraído das rotas preserva o comportamento: CRUD, posição, recorrência,
reorder e dependências — agora com escopo por usuário (multi-tenant).
"""

import itertools

import pytest

import database
from storage import tasks as repo
from storage import users as users_repo

# Contador para nomes de projeto únicos (o banco de teste é compartilhado na sessão).
_counter = itertools.count()

# Dono usado nos testes (admin criado no boot). Preenchido em _schema.
UID = None


@pytest.fixture(scope='module', autouse=True)
def _schema():
    global UID
    database.init_db()
    UID = int(users_repo.get_auth_by_username('admin')['id'])


def _proj():
    return f'stg-{next(_counter)}'


def _find(grouped, project, task_id):
    for t in grouped.get(project, []):
        if t['id'] == task_id:
            return t
    return None


def test_create_incrementa_posicao_e_aparece_agrupado():
    project = _proj()
    a = repo.create(UID, project, 'primeira', repo.today_br(), None, 'none')
    b = repo.create(UID, project, 'segunda', repo.today_br(), '2030-01-01', 'daily')

    assert a['position'] == 0
    assert b['position'] == 1
    assert b['completed'] is False and b['deleted'] is False

    grouped = repo.fetch_tasks_grouped(UID)
    ta = _find(grouped, project, a['id'])
    tb = _find(grouped, project, b['id'])
    assert ta is not None and tb is not None
    assert tb['due_date'] == '2030-01-01'
    assert tb['recurrence'] == 'daily'
    assert ta['depends_on'] == []


def test_update_text_completed_due_deleted():
    project = _proj()
    t = repo.create(UID, project, 'x', repo.today_br(), None, 'none')
    tid = t['id']

    repo.update(UID, tid, text='novo', completed=1)
    got = _find(repo.fetch_tasks_grouped(UID), project, tid)
    assert got['text'] == 'novo'
    assert got['completed'] is True

    repo.update(UID, tid, due_date='2031-05-05')
    got = _find(repo.fetch_tasks_grouped(UID), project, tid)
    assert got['due_date'] == '2031-05-05'

    # deleted=1 remove da visão agrupada (só ativas)
    repo.update(UID, tid, deleted=1)
    assert _find(repo.fetch_tasks_grouped(UID), project, tid) is None


def test_recorrente_reagenda_em_vez_de_concluir():
    project = _proj()
    t = repo.create(UID, project, 'rec', repo.today_br(), '2030-01-01', 'daily')
    tid = t['id']

    def next_fn(cur_due, rule):
        assert cur_due == '2030-01-01' and rule == 'daily'
        return '2030-01-02'

    recurred = repo.update(UID, tid, completed=1, next_occurrence_fn=next_fn)
    assert recurred == '2030-01-02'

    got = _find(repo.fetch_tasks_grouped(UID), project, tid)
    assert got is not None          # continua viva
    assert got['completed'] is False
    assert got['due_date'] == '2030-01-02'


def test_move_de_projeto_reposiciona_no_fim():
    src, dst = _proj(), _proj()
    repo.create(UID, dst, 'existente', repo.today_br(), None, 'none')  # pos 0 no destino
    t = repo.create(UID, src, 'movivel', repo.today_br(), None, 'none')

    repo.update(UID, t['id'], project=dst)
    got = _find(repo.fetch_tasks_grouped(UID), dst, t['id'])
    assert got is not None
    assert got['position'] == 1
    assert _find(repo.fetch_tasks_grouped(UID), src, t['id']) is None


def test_soft_delete():
    project = _proj()
    t = repo.create(UID, project, 'del', repo.today_br(), None, 'none')
    repo.soft_delete(UID, t['id'])
    assert _find(repo.fetch_tasks_grouped(UID), project, t['id']) is None


def test_reorder_ok_e_erros():
    project = _proj()
    a = repo.create(UID, project, 'a', repo.today_br(), None, 'none')
    b = repo.create(UID, project, 'b', repo.today_br(), None, 'none')

    # Inverte as posições (precisa cobrir TODAS as ativas do projeto)
    ok, err = repo.reorder(UID, [(1, a['id']), (0, b['id'])])
    assert ok and err is None
    grouped = repo.fetch_tasks_grouped(UID)
    assert _find(grouped, project, a['id'])['position'] == 1
    assert _find(grouped, project, b['id'])['position'] == 0

    # Cobertura parcial (falta uma tarefa ativa) -> erro
    ok, err = repo.reorder(UID, [(0, a['id'])])
    assert not ok and 'all active tasks' in err

    # Dois projetos no mesmo reorder -> erro
    other = _proj()
    c = repo.create(UID, other, 'c', repo.today_br(), None, 'none')
    ok, err = repo.reorder(UID, [(0, a['id']), (0, c['id'])])
    assert not ok and 'single project' in err


def test_dependencias_add_list_remove_e_ciclo():
    project = _proj()
    a = repo.create(UID, project, 'a', repo.today_br(), None, 'none')
    b = repo.create(UID, project, 'b', repo.today_br(), None, 'none')

    assert repo.is_active(UID, a['id']) is True

    deps = repo.add_dependency(b['id'], a['id'])  # b depende de a
    assert deps == [a['id']]
    assert repo.list_dependencies(b['id']) == [a['id']]

    # Idempotente
    assert repo.add_dependency(b['id'], a['id']) == [a['id']]

    # Ciclo: a dependendo de b fecharia ciclo
    assert repo.would_create_cycle(UID, a['id'], b['id']) is True
    # Auto-dependência também é ciclo
    assert repo.would_create_cycle(UID, a['id'], a['id']) is True

    repo.remove_dependency(UID, b['id'], a['id'])
    assert repo.list_dependencies(b['id']) == []


def test_is_active_false_para_arquivada_ou_inexistente():
    project = _proj()
    t = repo.create(UID, project, 'x', repo.today_br(), None, 'none')
    repo.soft_delete(UID, t['id'])
    assert repo.is_active(UID, t['id']) is False
    assert repo.is_active(UID, 999999) is False
