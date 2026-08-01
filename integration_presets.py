"""
Catálogo de modelos prontos (presets) de integração.

Cada preset é apenas um `config` válido do motor genérico REST/JSON
(ver integrations.py) com credenciais VAZIAS e placeholders no lugar dos
valores específicos do usuário (ex.: OWNER/REPO, YOUR-DOMAIN). O usuário
escolhe um modelo no wizard, que pré-preenche o formulário; ele então só
troca os placeholders e cola o token. Nada aqui roda sozinho — presets são
documentação + prefill, não um novo motor.

`setup` traz as instruções curtas do que o usuário precisa ajustar/preencher.
"""

# ── GitHub Issues ──────────────────────────────────────────────────
# REST puro. O endpoint /issues também retorna pull requests (eles têm a
# chave "pull_request"); o usuário pode filtrar depois se quiser.
_GITHUB_ISSUES = {
    'id': 'github_issues',
    'label': 'GitHub Issues',
    'description': 'Importa issues abertas de um repositório do GitHub como tarefas.',
    'docs_url': 'https://github.com/settings/tokens',
    'name': 'GitHub Issues',
    'setup': [
        'Troque OWNER/REPO na URL pelo dono e nome do repositório (ex.: octocat/hello-world).',
        'Crie um token em github.com/settings/tokens (escopo "repo" para repositórios privados) e cole no campo Token.',
    ],
    'config': {
        'connection': {
            'base_url': 'https://api.github.com',
            'path': '/repos/OWNER/REPO/issues',
            'method': 'GET',
            'headers': {
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
            'query': {'state': 'open', 'per_page': '100'},
            'auth': {'type': 'bearer', 'token': ''},
            'allow_private': False,
        },
        'items_path': '',
        'pagination': {
            'mode': 'page',
            'param': 'page',
            'start': 1,
            'size_param': 'per_page',
            'size': 100,
            'max_pages': 10,
        },
        'mapping': {
            'external_id': 'id',
            'project': {'mode': 'fixed', 'value': 'GitHub'},
            'text_template': '#{{number}} {{title}}',
            'due_date': {'mode': 'none'},
        },
        'on_update': 'update_text',
        'reimport_deleted': False,
    },
}

# ── Jira Cloud ─────────────────────────────────────────────────────
# Endpoint novo /rest/api/3/search/jql (o antigo /search foi removido).
# Paginação por cursor via nextPageToken. Auth Basic: e-mail + API token.
_JIRA_CLOUD = {
    'id': 'jira_cloud',
    'label': 'Jira Cloud',
    'description': 'Importa issues de uma busca JQL do Jira Cloud como tarefas.',
    'docs_url': 'https://id.atlassian.com/manage-profile/security/api-tokens',
    'name': 'Jira Cloud',
    'setup': [
        'Troque YOUR-DOMAIN na URL pelo subdomínio do seu site Jira (ex.: minhaempresa.atlassian.net).',
        'No campo Usuário coloque seu e-mail Atlassian; no campo Senha, cole um API token de id.atlassian.com.',
        'Ajuste o parâmetro "jql" se quiser outra busca (o padrão traz o que está atribuído a você e não concluído).',
    ],
    'config': {
        'connection': {
            'base_url': 'https://YOUR-DOMAIN.atlassian.net',
            'path': '/rest/api/3/search/jql',
            'method': 'GET',
            'headers': {'Accept': 'application/json'},
            'query': {
                'jql': 'assignee = currentUser() AND statusCategory != Done ORDER BY created DESC',
                'maxResults': '50',
                'fields': 'summary,duedate,project',
            },
            'auth': {'type': 'basic', 'username': '', 'password': ''},
            'allow_private': False,
        },
        'items_path': 'issues',
        'pagination': {
            'mode': 'cursor',
            'next_path': 'nextPageToken',
            'param': 'nextPageToken',
            'max_pages': 10,
        },
        'mapping': {
            'external_id': 'id',
            'project': {'mode': 'field', 'field': 'fields.project.key'},
            'text_template': '{{key}} {{fields.summary}}',
            'due_date': {'mode': 'field', 'field': 'fields.duedate'},
        },
        'on_update': 'update_all',
        'reimport_deleted': False,
    },
}

# ── GitLab Issues ──────────────────────────────────────────────────
# REST puro. Auth por header PRIVATE-TOKEN. Traz issues atribuídas a você.
_GITLAB_ISSUES = {
    'id': 'gitlab_issues',
    'label': 'GitLab Issues',
    'description': 'Importa issues abertas atribuídas a você no GitLab como tarefas.',
    'docs_url': 'https://gitlab.com/-/user_settings/personal_access_tokens',
    'name': 'GitLab Issues',
    'setup': [
        'Se usar GitLab self-hosted, troque gitlab.com na URL pelo seu domínio.',
        'Crie um Personal Access Token (escopo "read_api") e cole no campo do PRIVATE-TOKEN.',
    ],
    'config': {
        'connection': {
            'base_url': 'https://gitlab.com',
            'path': '/api/v4/issues',
            'method': 'GET',
            'headers': {},
            'query': {'scope': 'assigned_to_me', 'state': 'opened', 'per_page': '100'},
            'auth': {'type': 'api_key', 'header': 'PRIVATE-TOKEN', 'value': ''},
            'allow_private': False,
        },
        'items_path': '',
        'pagination': {
            'mode': 'page',
            'param': 'page',
            'start': 1,
            'size_param': 'per_page',
            'size': 100,
            'max_pages': 10,
        },
        'mapping': {
            'external_id': 'id',
            'project': {'mode': 'fixed', 'value': 'GitLab'},
            'text_template': '#{{iid}} {{title}}',
            'due_date': {'mode': 'field', 'field': 'due_date'},
        },
        'on_update': 'update_text',
        'reimport_deleted': False,
    },
}


_PRESETS = [_GITHUB_ISSUES, _JIRA_CLOUD, _GITLAB_ISSUES]
_PRESETS_BY_ID = {p['id']: p for p in _PRESETS}


def list_presets():
    """Retorna os presets públicos (credenciais já vazias por definição)."""
    return [dict(p) for p in _PRESETS]


def get_preset(preset_id):
    """Retorna um preset por id, ou None."""
    p = _PRESETS_BY_ID.get(preset_id)
    return dict(p) if p else None
