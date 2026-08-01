"""
Testes dos modelos prontos (presets) de integração.

Cobrem duas frentes:
- Catálogo (integration_presets): estrutura válida, sem segredos, e configs
  que o motor genérico consegue consumir sem quebrar.
- Endpoint GET /api/integrations/presets: exige admin e expõe os provedores.
"""

import integration_presets
import integrations

EXPECTED_IDS = {'github_issues', 'jira_cloud', 'gitlab_issues', 'linear'}
VALID_AUTH = {'none', 'bearer', 'api_key', 'basic', 'query_key', 'oauth2'}
VALID_PAG = {'none', 'page', 'offset', 'cursor', 'body_cursor'}
SECRET_FIELDS = ('token', 'value', 'password', 'client_secret')


def test_catalog_has_expected_providers():
    presets = integration_presets.list_presets()
    ids = {p['id'] for p in presets}
    assert EXPECTED_IDS <= ids


def test_presets_have_required_metadata():
    for p in integration_presets.list_presets():
        assert p.get('id')
        assert p.get('label')
        assert p.get('description')
        assert p.get('name')
        assert isinstance(p.get('setup'), list) and p['setup'], p['id']
        assert isinstance(p.get('config'), dict)


def test_presets_config_is_structurally_valid():
    for p in integration_presets.list_presets():
        cfg = p['config']
        conn = cfg['connection']
        assert conn['base_url'].startswith('https://'), p['id']
        assert (conn.get('method') or 'GET').upper() in ('GET', 'POST'), p['id']
        assert (conn.get('auth') or {}).get('type') in VALID_AUTH, p['id']
        assert (cfg.get('pagination') or {}).get('mode', 'none') in VALID_PAG, p['id']
        mapping = cfg['mapping']
        assert mapping.get('external_id'), p['id']
        assert 'project' in mapping and 'text_template' in mapping, p['id']
        assert (mapping.get('due_date') or {}).get('mode') in ('none', 'fixed', 'field'), p['id']


def test_presets_carry_no_secrets():
    """Credenciais devem sair sempre vazias — o usuário preenche depois."""
    for p in integration_presets.list_presets():
        auth = p['config']['connection'].get('auth') or {}
        for field in SECRET_FIELDS:
            assert not auth.get(field), f"{p['id']}.{field} não deveria vir preenchido"


def test_presets_build_task_without_crashing():
    """build_task_from_item deve tolerar um item vazio para qualquer preset."""
    for p in integration_presets.list_presets():
        built = integrations.build_task_from_item({}, p['config']['mapping'])
        assert set(built.keys()) == {'external_id', 'project', 'text', 'due_date'}


def test_github_preset_maps_number_and_title():
    cfg = integration_presets.get_preset('github_issues')['config']
    item = {'id': 42, 'number': 7, 'title': 'Corrigir bug'}
    built = integrations.build_task_from_item(item, cfg['mapping'])
    assert built['external_id'] == '42'
    assert built['project'] == 'GitHub'
    assert built['text'] == '#7 Corrigir bug'


def test_jira_preset_resolves_nested_project_and_due():
    cfg = integration_presets.get_preset('jira_cloud')['config']
    item = {
        'id': 1001,
        'key': 'ABC-12',
        'fields': {
            'summary': 'Revisar API',
            'duedate': '2026-08-15',
            'project': {'key': 'ABC'},
        },
    }
    built = integrations.build_task_from_item(item, cfg['mapping'])
    assert built['external_id'] == '1001'
    assert built['project'] == 'ABC'
    assert built['text'] == 'ABC-12 Revisar API'
    assert built['due_date'] == '2026-08-15'


def test_linear_preset_is_graphql_post_with_body_cursor():
    cfg = integration_presets.get_preset('linear')['config']
    conn = cfg['connection']
    assert conn['method'] == 'POST'
    assert isinstance(conn.get('body'), dict) and conn['body'].get('query')
    assert (conn.get('auth') or {}).get('header') == 'Authorization'
    pag = cfg['pagination']
    assert pag['mode'] == 'body_cursor'
    assert pag['var_path'] == 'variables.after'


def test_linear_preset_maps_identifier_title_and_due():
    cfg = integration_presets.get_preset('linear')['config']
    item = {'id': 'uuid-1', 'identifier': 'ENG-42', 'title': 'Ajustar cache',
            'dueDate': '2026-09-01', 'project': {'name': 'Core'}}
    built = integrations.build_task_from_item(item, cfg['mapping'])
    assert built['external_id'] == 'uuid-1'
    assert built['project'] == 'Linear'
    assert built['text'] == 'ENG-42 Ajustar cache'
    assert built['due_date'] == '2026-09-01'


def test_get_preset_unknown_returns_none():
    assert integration_presets.get_preset('nope') is None


# ── Endpoint ───────────────────────────────────────────────────────
def test_presets_endpoint_requires_admin(client):
    res = client.get('/api/integrations/presets')
    # Sem sessão: bloqueado (401 não autenticado ou 403 não-admin).
    assert res.status_code in (401, 403)


def test_presets_endpoint_lists_providers(auth_client):
    res = auth_client.get('/api/integrations/presets')
    assert res.status_code == 200
    data = res.get_json()
    ids = {p['id'] for p in data}
    assert EXPECTED_IDS <= ids
    for p in data:
        auth = p['config']['connection'].get('auth') or {}
        for field in SECRET_FIELDS:
            assert not auth.get(field)
