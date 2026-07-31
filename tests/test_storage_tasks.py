"""
Testes do repositório de tarefas (storage/tasks.py).

Exercitam a camada de storage diretamente (sem HTTP), garantindo que o SQL
extraído das rotas preserva o comportamento: CRUD, posição, recorrência,
reorder e dependências.
"""

import itertools

import pytest

import database
from storage import tasks as repo

# Contador para nomes de projeto únicos (o banco de teste é compartilhado na sessão).
_counter = itertools.count()


@pytest.fixture(scope='module', autouse=True)
def _schema():
    database.init_db()


def _proj():
    return f'stg-{next(_counter)}'


def _find(grouped, project, task_id):
    for t in grouped.get(project, []):
        if t['id'] == task_id:
            return t
    return None


def test_create_incrementa_posicao_e_aparece_agrupado():
    project = _proj()
    a = repo.create(project, 'primeira', repo.today_br(), None, 'none')
    b = repo.create(project, 'segunda', repo.today_br(), '2030-01-01', 'daily')

    assert a['position'] == 0
    assert b['position'] == 1
    assert b['completed'] is False and b['deleted'] is False

    grouped = repo.fetch_tasks_grouped()
    ta = _find(grouped, project, a['id'])
    tb = _find(grouped, project, b['id'])
    assert ta is not None and tb is not None
    assert tb['due_date'] == '2030-01-01'
    assert tb['recurrence'] == 'daily'
    assert ta['depends_on'] == []


def test_update_text_completed_due_deleted():
    project = _proj()
    t = repo.create(project, 'x', repo.today_br(), None, 'none')
    tid = t['id']

    repo.update(tid, text='novo', completed=1)
    got = _find(repo.fetch_tasks_grouped(), project, tid)
    assert got['text'] == 'novo'
    assert got['completed'] is True

    repo.update(tid, due_date='2031-05-05')
    got = _find(repo.fetch_tasks_grouped(), project, tid)
    assert got['due_date'] == '2031-05-05'

    # deleted=1 remove da visão agrupada (só ativas)
    repo.update(tid, deleted=1)
    assert _find(repo.fetch_tasks_grouped(), project, tid) is None


def test_recorrente_reagenda_em_vez_de_concluir():
    project = _proj()
    t = repo.create(project, 'rec', repo.today_br(), '2030-01-01', 'daily')
    tid = t['id']

    def next_fn(cur_due, rule):
        assert cur_due == '2030-01-01' and rule == 'daily'
        return '2030-01-02'

    recurred = repo.update(tid, completed=1, next_occurrence_fn=next_fn)
    assert recurred == '2030-01-02'

    got = _find(repo.fetch_tasks_grouped(), project, tid)
    assert got is not None          # continua viva
    assert got['completed'] is False
    assert got['due_date'] == '2030-01-02'


def test_move_de_projeto_reposiciona_no_fim():
    src, dst = _proj(), _proj()
    repo.create(dst, 'existente', repo.today_br(), None, 'none')  # pos 0 no destino
    t = repo.create(src, 'movivel', repo.today_br(), None, 'none')

    repo.update(t['id'], project=dst)
    got = _find(repo.fetch_tasks_grouped(), dst, t['id'])
    assert got is not None
    assert got['position'] == 1
    assert _find(repo.fetch_tasks_grouped(), src, t['id']) is None


def test_soft_delete():
    project = _proj()
    t = repo.create(project, 'del', repo.today_br(), None, 'none')
    repo.soft_delete(t['id'])
    assert _find(repo.fetch_tasks_grouped(), project, t['id']) is None


def test_reorder_ok_e_erros():
    project = _proj()
    a = repo.create(project, 'a', repo.today_br(), None, 'none')
    b = repo.create(project, 'b', repo.today_br(), None, 'none')

    # Inverte as posições (precisa cobrir TODAS as ativas do projeto)
    ok, err = repo.reorder([(1, a['id']), (0, b['id'])])
    assert ok and err is None
    grouped = repo.fetch_tasks_grouped()
    assert _find(grouped, project, a['id'])['position'] == 1
    assert _find(grouped, project, b['id'])['position'] == 0

    # Cobertura parcial (falta uma tarefa ativa) -> erro
    ok, err = repo.reorder([(0, a['id'])])
    assert not ok and 'all active tasks' in err

    # Dois projetos no mesmo reorder -> erro
    other = _proj()
    c = repo.create(other, 'c', repo.today_br(), None, 'none')
    ok, err = repo.reorder([(0, a['id']), (0, c['id'])])
    assert not ok and 'single project' in err


def test_dependencias_add_list_remove_e_ciclo():
    project = _proj()
    a = repo.create(project, 'a', repo.today_br(), None, 'none')
    b = repo.create(project, 'b', repo.today_br(), None, 'none')

    assert repo.is_active(a['id']) is True

    deps = repo.add_dependency(b['id'], a['id'])  # b depende de a
    assert deps == [a['id']]
    assert repo.list_dependencies(b['id']) == [a['id']]

    # Idempotente
    assert repo.add_dependency(b['id'], a['id']) == [a['id']]

    # Ciclo: a dependendo de b fecharia ciclo
    assert repo.would_create_cycle(a['id'], b['id']) is True
    # Auto-dependência também é ciclo
    assert repo.would_create_cycle(a['id'], a['id']) is True

    repo.remove_dependency(b['id'], a['id'])
    assert repo.list_dependencies(b['id']) == []


def test_is_active_false_para_arquivada_ou_inexistente():
    project = _proj()
    t = repo.create(project, 'x', repo.today_br(), None, 'none')
    repo.soft_delete(t['id'])
    assert repo.is_active(t['id']) is False
    assert repo.is_active(999999) is False
