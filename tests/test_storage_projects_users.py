"""
Testes dos repositórios de projetos e usuários (storage/projects.py, storage/users.py).
"""

import itertools

import pytest

import database
from storage import projects as projects_repo
from storage import users as users_repo
from storage import tasks as tasks_repo

_counter = itertools.count()


UID = None


@pytest.fixture(scope='module', autouse=True)
def _schema():
    global UID
    database.init_db()
    UID = int(users_repo.get_auth_by_username('admin')['id'])


def _proj():
    return f'stgpu-{next(_counter)}'


# ── Projetos ────────────────────────────────────────────────────────

def test_projects_create_list_e_duplicado():
    name = _proj()
    assert projects_repo.create(UID, name) is True
    assert name in projects_repo.list_names(UID)
    # Duplicado retorna False (endpoint mapeia para 409)
    assert projects_repo.create(UID, name) is False


def test_projects_list_ordenada():
    names = projects_repo.list_names(UID)
    assert names == sorted(names)


def test_project_delete_arquiva_tarefas():
    name = _proj()
    projects_repo.create(UID, name)
    t = tasks_repo.create(UID, name, 'órfã', tasks_repo.today_br(), None, 'none')

    projects_repo.delete(UID, name)
    assert name not in projects_repo.list_names(UID)
    # Tarefa foi arquivada (some da visão agrupada de ativas)
    grouped = tasks_repo.fetch_tasks_grouped(UID)
    assert all(x['id'] != t['id'] for x in grouped.get(name, []))


# ── Usuários ────────────────────────────────────────────────────────

def _admin_id():
    return int(users_repo.get_auth_by_username('admin')['id'])


def test_get_profile_admin():
    prof = users_repo.get_profile(_admin_id())
    assert prof is not None
    assert prof['username'] == 'admin'
    assert 'theme_pref' in prof


def test_set_theme_persiste():
    uid = _admin_id()
    original = users_repo.get_profile(uid)['theme_pref']
    try:
        users_repo.set_theme(uid, 'dark')
        assert users_repo.get_profile(uid)['theme_pref'] == 'dark'
    finally:
        users_repo.set_theme(uid, original)


def test_username_taken():
    uid = _admin_id()
    # admin pertence a ELE mesmo -> não conta como "tomado" ao excluir o próprio id
    assert users_repo.username_taken('admin', uid) is False
    # Para outro id qualquer, 'admin' está tomado
    assert users_repo.username_taken('admin', uid + 99999) is True


def test_bump_session_version_incrementa():
    uid = _admin_id()
    before = int(users_repo.get_profile(uid)['session_version'])
    after = users_repo.bump_session_version(uid)
    assert after == before + 1


def test_avatar_set_get_clear():
    uid = _admin_id()
    png = b'\x89PNG\r\n\x1a\n' + b'\x00' * 16
    try:
        users_repo.set_avatar(uid, 'image/png', png)
        got = users_repo.get_avatar(uid)
        assert got is not None
        mime, data = got
        assert mime == 'image/png'
        assert data == png
    finally:
        users_repo.clear_avatar(uid)
    assert users_repo.get_avatar(uid) is None
