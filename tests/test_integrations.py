"""Testes do módulo de integrações: SSRF, templates, dedup e paginação."""

from datetime import date, datetime

import pytest

import database
import integrations as I
from integrations import IntegrationError


# ── Templates / acesso a campos ────────────────────────────────────
def test_resolve_path_nested_and_index():
    obj = {'a': {'b': [{'c': 1}, {'c': 2}]}}
    assert I.resolve_path(obj, 'a.b.1.c') == 2
    assert I.resolve_path(obj, 'a.b[0].c') == 1
    assert I.resolve_path(obj, 'a.x') is None
    assert I.resolve_path(obj, '') is obj


def test_render_template_only_substitutes_fields():
    item = {'id': 7, 'title': 'Bug', 'flag': True, 'obj': {'x': 1}}
    assert I.render_template('#{{id}} {{title}}', item) == '#7 Bug'
    assert I.render_template('{{flag}}', item) == 'true'
    assert I.render_template('{{obj}}', item) == '{"x": 1}'
    # Campo ausente vira string vazia; nada é "executado".
    assert I.render_template('{{missing}}', item) == ''


# ── Guarda de SSRF ─────────────────────────────────────────────────
def test_ip_blocked_public_allowed():
    assert I._ip_blocked('8.8.8.8', allow_private=False) is False


def test_ip_blocked_private_depends_on_flag():
    assert I._ip_blocked('10.1.2.3', allow_private=False) is True
    assert I._ip_blocked('10.1.2.3', allow_private=True) is False


@pytest.mark.parametrize('ip', ['169.254.169.254', '169.254.170.2'])
def test_ip_blocked_metadata_always(ip):
    # Metadata de cloud é SEMPRE bloqueada, mesmo com allow_private.
    assert I._ip_blocked(ip, allow_private=False) is True
    assert I._ip_blocked(ip, allow_private=True) is True


def test_ip_blocked_garbage():
    assert I._ip_blocked('nao-e-ip', allow_private=False) is True


def test_resolve_target_scheme_and_host():
    with pytest.raises(IntegrationError):
        I._resolve_target('file:///etc/passwd', allow_private=True)


def test_resolve_target_blocks_metadata_literal():
    with pytest.raises(IntegrationError):
        I._resolve_target('http://169.254.169.254/latest/', allow_private=True)


def test_resolve_target_blocks_private_by_default():
    with pytest.raises(IntegrationError):
        I._resolve_target('http://10.1.2.3/', allow_private=False)
    # Com allow_private, resolve e retorna o IP fixado.
    scheme, host, port, ip = I._resolve_target('http://10.1.2.3/', allow_private=True)
    assert (scheme, host, port, ip) == ('http', '10.1.2.3', 80, '10.1.2.3')


def test_resolve_target_pins_public_ip(monkeypatch):
    # DNS resolve para um IP público -> deve passar e fixar esse IP.
    def fake_getaddrinfo(host, port, *a, **k):
        return [(2, 1, 6, '', ('93.184.216.34', port))]
    monkeypatch.setattr(I.socket, 'getaddrinfo', fake_getaddrinfo)
    scheme, host, port, ip = I._resolve_target('https://example.com/api', allow_private=False)
    assert host == 'example.com'
    assert port == 443
    assert ip == '93.184.216.34'


def test_resolve_target_blocks_mixed_public_private(monkeypatch):
    # Se qualquer IP resolvido for interno, recusa (defesa contra rebinding).
    def fake_getaddrinfo(host, port, *a, **k):
        return [
            (2, 1, 6, '', ('93.184.216.34', port)),
            (2, 1, 6, '', ('10.0.0.5', port)),
        ]
    monkeypatch.setattr(I.socket, 'getaddrinfo', fake_getaddrinfo)
    with pytest.raises(IntegrationError):
        I._resolve_target('https://sneaky.example/api', allow_private=False)


# ── Construção da task a partir do item ────────────────────────────
def test_build_task_from_item_fixed_project_and_template():
    item = {'id': 42, 'summary': 'Corrigir login', 'queue': 'Suporte'}
    mapping = {
        'external_id': 'id',
        'project': {'mode': 'fixed', 'value': 'Protheus'},
        'text_template': '{{summary}}',
        'due_date': {'mode': 'fixed', 'value': '2026-08-03'},
    }
    t = I.build_task_from_item(item, mapping)
    assert t == {'external_id': '42', 'project': 'Protheus',
                 'text': 'Corrigir login', 'due_date': '2026-08-03'}


def test_build_task_project_from_field_and_invalid_due():
    item = {'id': 1, 'summary': 'x', 'queue': 'Fila-A'}
    mapping = {
        'external_id': 'id',
        'project': {'mode': 'field', 'field': 'queue'},
        'text_template': '{{summary}}',
        'due_date': {'mode': 'fixed', 'value': '2026-13-40'},  # data inválida -> ''
    }
    t = I.build_task_from_item(item, mapping)
    assert t['project'] == 'Fila-A'
    assert t['due_date'] == ''


# ── Validação de due_date (datas reais ISO) ────────────────────────
def test_valid_due_date_accepts_iso_and_empty():
    assert I.valid_due_date('') is True
    assert I.valid_due_date('2026-08-03') is True


def test_valid_due_date_rejects_garbage_and_bad_dates():
    assert I.valid_due_date('2026-13-40') is False
    assert I.valid_due_date('03/08/2026') is False
    assert I.valid_due_date('amanhã') is False


def test_valid_due_date_rejects_legacy_weekday_names():
    # Nomes de dia legados não são mais aceitos (só datas ISO reais).
    assert I.valid_due_date('Segunda') is False
    assert I.valid_due_date('Sexta') is False


# ── Dedup / upsert com banco temporário ────────────────────────────
@pytest.fixture()
def db_conn():
    database.init_db()
    conn = database.get_db_connection()
    yield conn
    conn.close()


def _new_integration(conn, name='Teste'):
    now = datetime.utcnow().isoformat()
    cur = conn.execute(
        'INSERT INTO integrations (name, config_json, created_at, updated_at) '
        "VALUES (?, '{}', ?, ?)",
        (name, now, now),
    )
    conn.commit()
    return cur.lastrowid


def test_migration_converts_legacy_weekday_to_iso(db_conn):
    from datetime import timedelta
    # Insere um prazo legado direto na tabela e roda a migração (init_db).
    db_conn.execute(
        "INSERT INTO tasks (project, text, completed, due_date, position, deleted) "
        "VALUES ('Proj', 'Legada', 0, 'Segunda', 0, 0)"
    )
    db_conn.commit()
    db_conn.close()

    database.init_db()

    today = date.today()
    monday = today - timedelta(days=today.weekday())
    conn = database.get_db_connection()
    row = conn.execute(
        "SELECT due_date FROM tasks WHERE text = 'Legada'"
    ).fetchone()
    conn.close()
    assert row['due_date'] == monday.isoformat()


def test_upsert_creates_then_skips(db_conn):
    iid = _new_integration(db_conn)
    today = date.today().strftime('%d/%m/%Y')
    now = datetime.utcnow().isoformat()

    c, u, s = I._upsert_task(db_conn, iid, 'EXT-1', 'Proj', 'Texto', '2026-08-03',
                             'skip', today, now)
    assert (c, u, s) == (1, 0, 0)

    # Reimportar o mesmo external_id com on_update=skip -> ignora.
    c, u, s = I._upsert_task(db_conn, iid, 'EXT-1', 'Proj', 'Texto', '2026-08-03',
                             'skip', today, now)
    assert (c, u, s) == (0, 0, 1)


def test_upsert_update_all_changes_task(db_conn):
    iid = _new_integration(db_conn)
    today = date.today().strftime('%d/%m/%Y')
    now = datetime.utcnow().isoformat()

    I._upsert_task(db_conn, iid, 'EXT-9', 'Proj', 'Antigo', '', 'skip', today, now)
    c, u, s = I._upsert_task(db_conn, iid, 'EXT-9', 'Proj', 'Novo texto', '2026-08-04',
                             'update_all', today, now)
    assert (c, u, s) == (0, 1, 0)

    row = db_conn.execute(
        'SELECT t.text, t.due_date FROM tasks t '
        'JOIN integration_items ii ON ii.task_id = t.id '
        'WHERE ii.integration_id = ? AND ii.external_id = ?',
        (iid, 'EXT-9'),
    ).fetchone()
    assert row['text'] == 'Novo texto'
    assert row['due_date'] == '2026-08-04'


# ── Paginação (_gather_items) ──────────────────────────────────────
def test_gather_items_paginates_and_stops(monkeypatch):
    connection = {'base_url': 'https://api.exemplo.com', 'path': '/items'}
    pagination = {'mode': 'page', 'param': 'page', 'start': 1, 'max_pages': 10}

    pages = {
        1: [{'id': 1}, {'id': 2}],
        2: [{'id': 3}],
        3: [],  # página vazia -> encerra
    }

    def fake_fetch(conn, allow_private=None, extra_query=None, override_url=None):
        page = (extra_query or {}).get('page', 1)
        return pages.get(page, [])

    monkeypatch.setattr(I, 'fetch_payload', fake_fetch)
    items = I._gather_items(connection, '', pagination)
    assert [it['id'] for it in items] == [1, 2, 3]
