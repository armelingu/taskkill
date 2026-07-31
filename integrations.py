"""
Módulo de Integrações Externas (MVP: REST/JSON).

Importa itens de uma API REST/JSON e cria tasks no Taskkill a partir de uma
configuração declarativa (montada pela UI ou por JSON bruto).

Segurança:
- Guarda de SSRF: bloqueia por padrão hosts que resolvam para IPs
  privados/loopback/link-local/metadata de cloud.
- Timeout e limite de tamanho da resposta.
- Sem execução de código arbitrário: o mapeamento usa apenas templates
  seguros no formato {{ campo.aninhado }}.
"""

import copy
import hashlib
import ipaddress
import json
import re
import socket
from datetime import date, datetime

import httpx

from storage.db import connection
from storage import integrations as store

# ── Limites / constantes de segurança ──────────────────────────────
FETCH_TIMEOUT_SECS = 10.0
MAX_RESPONSE_BYTES = 5 * 1024 * 1024   # 5 MB
MAX_ITEMS_PER_RUN = 500
# Nº de linhas retornadas na prévia. Como a prévia agora é interativa (o
# usuário seleciona/importa exatamente o que vê), este também é o teto de
# itens importáveis por vez pelo assistente.
PREVIEW_LIMIT = 200
MAX_TEXT_LEN = 1000                    # espelha routes.MAX_TEXT_LEN
MAX_PROJECT_LEN = 18                   # espelha routes.MAX_PROJECT_LEN
# due_date é '' (sem prazo) ou uma data real ISO YYYY-MM-DD (espelha
# routes.valid_due_date).
def valid_due_date(value: str) -> bool:
    if value == '':
        return True
    try:
        date.fromisoformat(value)
        return True
    except ValueError:
        return False

ALLOWED_METHODS = {'GET', 'POST'}
SECRET_MASK = '••••••••'
# Campos considerados segredo dentro de connection.auth
SECRET_FIELDS = ('token', 'value', 'password', 'client_secret')

_TEMPLATE_RE = re.compile(r'\{\{\s*([\w.\[\]]+)\s*\}\}')


class IntegrationError(Exception):
    """Erro de execução de integração, com mensagem amigável ao usuário."""


# ── Acesso a campos e templates ────────────────────────────────────
def resolve_path(obj, path):
    """Acessa um valor aninhado via 'a.b.0.c' (suporta índices de lista)."""
    if path is None or path == '':
        return obj
    cur = obj
    for part in str(path).replace('[', '.').replace(']', '').split('.'):
        part = part.strip()
        if part == '':
            continue
        if isinstance(cur, dict):
            if part not in cur:
                return None
            cur = cur[part]
        elif isinstance(cur, list):
            try:
                idx = int(part)
            except (TypeError, ValueError):
                return None
            if idx < 0 or idx >= len(cur):
                return None
            cur = cur[idx]
        else:
            return None
    return cur


def render_template(tpl, item):
    """Substitui apenas {{ campo }} pelo valor do item. Nunca executa código."""
    if tpl is None:
        return ''

    def _sub(match):
        val = resolve_path(item, match.group(1))
        if val is None:
            return ''
        if isinstance(val, bool):
            return 'true' if val else 'false'
        if isinstance(val, (dict, list)):
            return json.dumps(val, ensure_ascii=False)
        return str(val)

    return _TEMPLATE_RE.sub(_sub, str(tpl))


# ── Guarda de SSRF ─────────────────────────────────────────────────
# Endereços de metadata de cloud: AWS/GCP/Azure usam 169.254.169.254; o
# endpoint de credenciais de tarefa do AWS ECS usa 169.254.170.2; o IMDS via
# IPv6 usa fd00:ec2::254. SÃO SEMPRE BLOQUEADOS, mesmo com allow_private —
# nenhuma integração legítima precisa acessá-los, e são o alvo clássico de SSRF.
_METADATA_IPS = {
    ipaddress.ip_address('169.254.169.254'),
    ipaddress.ip_address('169.254.170.2'),
    ipaddress.ip_address('fd00:ec2::254'),
}


def _ip_blocked(ip_str, allow_private):
    """
    Decide se um IP deve ser bloqueado.

    - SEMPRE bloqueia (mesmo com allow_private=True): metadata de cloud,
      link-local, multicast e unspecified — não são alvos legítimos.
    - Com allow_private=False, bloqueia também privado/loopback/reservado.
    """
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return True  # não parseável como IP -> bloqueia por precaução
    if ip in _METADATA_IPS or ip.is_link_local or ip.is_multicast or ip.is_unspecified:
        return True
    if allow_private:
        return False
    return ip.is_private or ip.is_loopback or ip.is_reserved


def _resolve_target(url, allow_private):
    """
    Valida a URL e resolve o host UMA única vez, retornando um IP já aprovado
    para conectar.

    Fixar o IP aqui elimina a janela TOCTOU / DNS-rebinding: a conexão real
    (feita por _request_pinned) usa exatamente este IP validado, e não uma
    segunda resolução DNS independente do httpx que poderia devolver um IP
    interno diferente.

    Retorna (scheme, host, port, connect_ip).
    """
    parts = httpx.URL(url)
    scheme = parts.scheme
    if scheme not in ('http', 'https'):
        raise IntegrationError('URL inválida: use http ou https.')
    host = parts.host
    if not host:
        raise IntegrationError('URL inválida: host ausente.')
    port = parts.port or (443 if scheme == 'https' else 80)

    # Host já é um IP literal? valida direto, sem DNS.
    try:
        ipaddress.ip_address(host)
        candidates = [host]
    except ValueError:
        try:
            infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
        except socket.gaierror:
            raise IntegrationError(f'Não foi possível resolver o host: {host}')
        candidates = [info[4][0] for info in infos]

    if not candidates:
        raise IntegrationError(f'Não foi possível resolver o host: {host}')

    # Todos os IPs resolvidos precisam passar: se QUALQUER um for bloqueado,
    # recusa (evita host com mix de IP público e interno).
    for ip_str in candidates:
        if _ip_blocked(ip_str, allow_private):
            raise IntegrationError(
                'Destino bloqueado (endereço interno/privado ou metadata de cloud). '
                'Marque "permitir rede interna" se isso for intencional.'
            )
    return scheme, host, port, candidates[0]


def _request_pinned(method, url, *, allow_private, **req_kwargs):
    """
    Executa uma requisição HTTP conectando ao IP já validado (anti-SSRF),
    preservando o Host header e o SNI/validação de certificado do hostname
    original. `follow_redirects=False` impede que um 3xx desvie para alvo interno.
    """
    scheme, host, port, connect_ip = _resolve_target(url, allow_private)
    conn_url = httpx.URL(url).copy_with(host=connect_ip)

    auth = req_kwargs.pop('auth', None)
    headers = dict(req_kwargs.pop('headers', None) or {})
    # Preserva o Host original (com porta só se não for a padrão). IPv6 entre [].
    if ':' in host and not host.startswith('['):
        host_header = f'[{host}]' if port in (80, 443) else f'[{host}]:{port}'
    else:
        host_header = host if port in (80, 443) else f'{host}:{port}'
    headers['Host'] = host_header

    # SNI e verificação de certificado usam o hostname real, não o IP conectado.
    extensions = {'sni_hostname': host} if scheme == 'https' else {}

    try:
        with httpx.Client(timeout=FETCH_TIMEOUT_SECS, follow_redirects=False) as client:
            request = client.build_request(method, conn_url, headers=headers,
                                           extensions=extensions, **req_kwargs)
            if auth is not None:
                return client.send(request, auth=auth)
            return client.send(request)
    except httpx.RequestError as exc:
        raise IntegrationError(f'Falha na requisição: {exc.__class__.__name__}')


# ── Requisição HTTP ────────────────────────────────────────────────
def _fetch_oauth2_token(auth, allow_private):
    """OAuth2 client_credentials: busca um access_token no token endpoint."""
    token_url = (auth.get('token_url') or '').strip()
    if not token_url:
        raise IntegrationError('OAuth2: informe a URL do token.')

    data = {
        'grant_type': 'client_credentials',
        'client_id': auth.get('client_id') or '',
        'client_secret': auth.get('client_secret') or '',
    }
    scope = (auth.get('scope') or '').strip()
    if scope:
        data['scope'] = scope

    try:
        resp = _request_pinned('POST', token_url, allow_private=allow_private, data=data)
    except IntegrationError as exc:
        raise IntegrationError(f'OAuth2: {exc}')
    if resp.status_code >= 400:
        raise IntegrationError(f'OAuth2: token endpoint respondeu HTTP {resp.status_code}.')
    try:
        token = resp.json().get('access_token')
    except (ValueError, json.JSONDecodeError):
        raise IntegrationError('OAuth2: a resposta do token não é JSON válido.')
    if not token:
        raise IntegrationError('OAuth2: access_token ausente na resposta.')
    return token


def _build_auth(connection, allow_private):
    """Monta headers/auth/params conforme o tipo de autenticação configurado."""
    headers = dict(connection.get('headers') or {})
    params = {}
    auth = connection.get('auth') or {'type': 'none'}
    atype = (auth.get('type') or 'none').lower()
    httpx_auth = None

    if atype == 'bearer':
        token = auth.get('token') or ''
        if token:
            headers['Authorization'] = f'Bearer {token}'
    elif atype == 'api_key':
        header_name = (auth.get('header') or 'X-API-Key').strip()
        value = auth.get('value') or ''
        if header_name and value:
            headers[header_name] = value
    elif atype == 'basic':
        httpx_auth = (auth.get('username') or '', auth.get('password') or '')
    elif atype == 'query_key':
        name = (auth.get('param') or '').strip()
        value = auth.get('value') or ''
        if name and value:
            params[name] = value
    elif atype == 'oauth2':
        token = _fetch_oauth2_token(auth, allow_private)
        headers['Authorization'] = f'Bearer {token}'

    return headers, httpx_auth, params


def fetch_payload(connection, allow_private=None, extra_query=None, override_url=None):
    """
    Faz a requisição e devolve o JSON parseado (dict/list).

    - extra_query: dict mesclado sobre connection.query (paginação por página/offset).
    - override_url: usa esta URL absoluta no lugar da montada (paginação por cursor/next).
    """
    connection = connection or {}
    if override_url:
        url = str(override_url)
    else:
        base_url = (connection.get('base_url') or '').strip().rstrip('/')
        path = (connection.get('path') or '').strip()
        if not base_url:
            raise IntegrationError('base_url é obrigatório.')
        if path and not path.startswith('/'):
            path = '/' + path
        url = base_url + path

    method = (connection.get('method') or 'GET').upper()
    if method not in ALLOWED_METHODS:
        raise IntegrationError(f'Método não permitido: {method} (use GET ou POST).')

    if allow_private is None:
        allow_private = bool(connection.get('allow_private'))

    headers, httpx_auth, auth_params = _build_auth(connection, allow_private)
    params = dict(connection.get('query') or {})
    params.update(auth_params)
    if extra_query:
        params.update(extra_query)
    body = connection.get('body')

    req_kwargs = {'params': params, 'headers': headers}
    if httpx_auth:
        req_kwargs['auth'] = httpx_auth
    if method == 'POST' and body is not None:
        if isinstance(body, (dict, list)):
            req_kwargs['json'] = body
        else:
            req_kwargs['content'] = str(body)

    # Conecta no IP validado (anti-SSRF/TOCTOU). Isso cobre também a paginação
    # por cursor (override_url vindo da resposta externa), que passa por aqui.
    resp = _request_pinned(method, url, allow_private=allow_private, **req_kwargs)

    if resp.status_code >= 400:
        raise IntegrationError(f'A API respondeu com status HTTP {resp.status_code}.')

    content = resp.content or b''
    if len(content) > MAX_RESPONSE_BYTES:
        raise IntegrationError('Resposta muito grande (limite de 5 MB).')

    try:
        return resp.json()
    except (ValueError, json.JSONDecodeError):
        raise IntegrationError('A resposta não é um JSON válido.')


# ── Extração / detecção ────────────────────────────────────────────
def extract_items(payload, items_path):
    """Resolve o caminho até a lista de itens. Aceita objeto único."""
    data = resolve_path(payload, items_path) if items_path else payload
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        return [data]
    return []


MAX_PAGES_CAP = 50


def _gather_items(connection, items_path, pagination):
    """
    Coleta itens de uma ou mais páginas, conforme a configuração de paginação.

    pagination.mode:
      - 'none'   : uma única requisição.
      - 'page'   : incrementa um parâmetro de página (param), começando em 'start'.
      - 'offset' : incrementa um parâmetro de offset (param) em passos de 'size'.
      - 'cursor' : segue um token/URL encontrado em 'next_path' na resposta.
    Campos comuns: param, size_param, size, start, max_pages, next_path.
    """
    pagination = pagination or {}
    mode = (pagination.get('mode') or 'none').lower()

    if mode == 'none' or not mode:
        payload = fetch_payload(connection)
        return extract_items(payload, items_path)

    param = (pagination.get('param') or '').strip()
    size_param = (pagination.get('size_param') or '').strip()
    try:
        size = int(pagination.get('size') or 0)
    except (TypeError, ValueError):
        size = 0
    try:
        start = int(pagination.get('start') or (1 if mode == 'page' else 0))
    except (TypeError, ValueError):
        start = 1 if mode == 'page' else 0
    try:
        max_pages = int(pagination.get('max_pages') or 10)
    except (TypeError, ValueError):
        max_pages = 10
    max_pages = max(1, min(max_pages, MAX_PAGES_CAP))
    next_path = (pagination.get('next_path') or '').strip()

    collected = []
    override_url = None
    cursor_token = None

    for i in range(max_pages):
        extra = {}
        if mode == 'page':
            if not param:
                raise IntegrationError('Paginação por página exige o nome do parâmetro.')
            extra[param] = start + i
            if size_param and size:
                extra[size_param] = size
        elif mode == 'offset':
            if not param:
                raise IntegrationError('Paginação por offset exige o nome do parâmetro.')
            extra[param] = start + i * (size if size else 1)
            if size_param and size:
                extra[size_param] = size
        elif mode == 'cursor':
            if i > 0 and cursor_token and not override_url and param:
                extra[param] = cursor_token
        else:
            raise IntegrationError(f'Modo de paginação inválido: {mode}')

        payload = fetch_payload(connection, extra_query=extra or None, override_url=override_url)
        page_items = extract_items(payload, items_path)
        if not page_items:
            break
        collected.extend(page_items)
        if len(collected) >= MAX_ITEMS_PER_RUN:
            collected = collected[:MAX_ITEMS_PER_RUN]
            break

        if mode == 'cursor':
            nxt = resolve_path(payload, next_path) if next_path else None
            if not nxt:
                break
            nxt = str(nxt).strip()
            if nxt.lower().startswith(('http://', 'https://')):
                override_url = nxt
                cursor_token = None
            else:
                override_url = None
                cursor_token = nxt
        elif size and len(page_items) < size:
            # Página incompleta em page/offset => última página.
            break

    return collected


def detect_array_paths(payload, max_depth=4):
    """Lista os caminhos que apontam para arrays (sugestões de items_path)."""
    found = []

    def walk(obj, prefix, depth):
        if depth > max_depth:
            return
        if isinstance(obj, list):
            found.append({'path': prefix, 'count': len(obj)})
            return
        if isinstance(obj, dict):
            for key, val in obj.items():
                child = f'{prefix}.{key}' if prefix else key
                walk(val, child, depth + 1)

    walk(payload, '', 0)
    return found


def sample_fields(item, max_depth=2):
    """Lista os campos (achatados) do item de exemplo para o mapeamento."""
    fields = []

    def walk(obj, prefix, depth):
        if isinstance(obj, dict):
            for key, val in obj.items():
                child = f'{prefix}.{key}' if prefix else key
                if isinstance(val, dict) and depth < max_depth:
                    walk(val, child, depth + 1)
                else:
                    fields.append(child)

    if isinstance(item, dict):
        walk(item, '', 1)
    return fields


# ── Construção da task a partir de um item ─────────────────────────
def build_task_from_item(item, mapping):
    mapping = mapping or {}

    ext_field = mapping.get('external_id') or 'id'
    ext_val = resolve_path(item, ext_field)
    external_id = '' if ext_val is None else str(ext_val).strip()

    proj_cfg = mapping.get('project') or {}
    mode = (proj_cfg.get('mode') or 'fixed').lower()
    if mode == 'field':
        pv = resolve_path(item, proj_cfg.get('field') or '')
        project = '' if pv is None else str(pv).strip()
    else:
        project = str(proj_cfg.get('value') or '').strip()
    if len(project) > MAX_PROJECT_LEN:
        project = project[:MAX_PROJECT_LEN]

    text = render_template(mapping.get('text_template') or '', item).strip()
    if len(text) > MAX_TEXT_LEN:
        text = text[:MAX_TEXT_LEN]

    due_date = _resolve_due_date(mapping.get('due_date'), item)

    return {'external_id': external_id, 'project': project, 'text': text, 'due_date': due_date}


def _resolve_due_date(due_cfg, item):
    """Resolve a data de prazo (ISO YYYY-MM-DD) da tarefa a partir do mapeamento."""
    due_cfg = due_cfg or {}
    mode = (due_cfg.get('mode') or 'none').lower()
    if mode == 'fixed':
        due = str(due_cfg.get('value') or '').strip()
    elif mode == 'field':
        val = resolve_path(item, due_cfg.get('field') or '')
        due = '' if val is None else str(val).strip()
    else:
        due = ''
    return due if valid_due_date(due) else ''


# ── Execução (preview e importação real) ───────────────────────────
def run_config(config, dry_run=True, integration_id=None, conn=None, owner_user_id=None):
    """
    Executa a partir de um dict de config.
    - dry_run=True: não persiste; retorna preview.
    - dry_run=False: cria/atualiza tasks e registra em integration_items (usa conn).
      As tasks criadas pertencem a owner_user_id (dono da integração/admin).
    """
    config = config or {}
    connection = config.get('connection') or {}
    items_path = config.get('items_path') or ''
    mapping = config.get('mapping') or {}
    on_update = (config.get('on_update') or 'skip').lower()
    reimport_deleted = bool(config.get('reimport_deleted'))
    pagination = config.get('pagination') or {}

    items = _gather_items(connection, items_path, pagination)
    if len(items) > MAX_ITEMS_PER_RUN:
        items = items[:MAX_ITEMS_PER_RUN]

    built = [build_task_from_item(it, mapping) for it in items]

    if dry_run:
        preview = [{
            'external_id': b['external_id'],
            'project': b['project'],
            'text': b['text'],
            'due_date': b.get('due_date', ''),
            'valid': bool(b['external_id'] and b['project'] and b['text']),
        } for b in built[:PREVIEW_LIMIT]]
        return {
            'total_items': len(items),
            'preview': preview,
            'preview_limit': PREVIEW_LIMIT,
        }

    if conn is None:
        raise IntegrationError('Conexão de banco ausente para importação.')
    if owner_user_id is None:
        owner_user_id = store.first_admin_id()

    created = updated = skipped = 0
    today_str = date.today().strftime('%d/%m/%Y')
    now_iso = datetime.utcnow().isoformat()

    for b in built:
        ext, project, text = b['external_id'], b['project'], b['text']
        due = b.get('due_date', '')
        if not ext or not project or not text:
            skipped += 1
            continue
        created_i, updated_i, skipped_i = _upsert_task(
            conn, integration_id, owner_user_id, ext, project, text, due, on_update, today_str, now_iso,
            reimport_deleted=reimport_deleted
        )
        created += created_i
        updated += updated_i
        skipped += skipped_i

    return {'total_items': len(items), 'created': created, 'updated': updated, 'skipped': skipped}


def _owner_of(row):
    """
    Dono das tasks criadas pela integração. Usa owner_user_id salvo; se ausente
    (integrações antigas), cai para o primeiro admin.
    """
    owner = row['owner_user_id'] if 'owner_user_id' in row.keys() else None
    return owner if owner is not None else store.first_admin_id()


def _content_hash(project, text, due):
    """Hash estável do conteúdo relevante da task (para detectar mudanças)."""
    raw = f'{project}\x1f{text}\x1f{due}'
    return hashlib.sha1(raw.encode('utf-8')).hexdigest()


def _create_task_and_link(conn, integration_id, owner_user_id, ext, project, text, due, today_str, now_iso, link_id=None):
    """Cria a task (dona = owner_user_id) e cria (ou re-vincula) a linha em integration_items."""
    new_pos = store.max_task_position(conn, owner_user_id, project) + 1
    task_id = store.insert_task(conn, owner_user_id, project, text, today_str, due, new_pos)
    chash = _content_hash(project, text, due)
    if link_id is not None:
        store.link_item_update(conn, link_id, task_id, chash, now_iso)
    else:
        store.link_item_insert(conn, integration_id, ext, task_id, chash, now_iso)
    return task_id


def _upsert_task(conn, integration_id, owner_user_id, ext, project, text, due, on_update, today_str, now_iso,
                 reimport_deleted=False):
    """
    Cria ou atualiza uma task (dona = owner_user_id) a partir de um item já
    resolvido. Retorna (created, updated, skipped).

    on_update:
      - 'skip'        : itens já importados são ignorados.
      - 'update_text' : atualiza apenas o texto.
      - 'update_all'  : atualiza texto, projeto e dia (due).
    reimport_deleted: se a task vinculada foi excluída, recria uma nova.
    """
    if not valid_due_date(due):
        due = ''

    # Garante o projeto na tabela (para aparecer no sidebar).
    store.ensure_project(conn, owner_user_id, project)

    existing = store.get_item(conn, integration_id, ext)

    if not existing:
        _create_task_and_link(conn, integration_id, owner_user_id, ext, project, text, due, today_str, now_iso)
        return (1, 0, 0)

    # Estado da task vinculada (pode ter sido excluída ou apagada de vez).
    task_row = None
    if existing['task_id']:
        task_row = store.get_task_state(conn, existing['task_id'])
    task_gone = (task_row is None) or bool(task_row['deleted'])

    if task_gone:
        if reimport_deleted:
            _create_task_and_link(conn, integration_id, owner_user_id, ext, project, text, due,
                                  today_str, now_iso, link_id=existing['id'])
            return (1, 0, 0)
        return (0, 0, 1)

    if on_update not in ('update_text', 'update_all'):
        return (0, 0, 1)

    new_hash = _content_hash(project, text, due)
    if existing['content_hash'] == new_hash:
        return (0, 0, 1)  # nada mudou

    if on_update == 'update_text':
        store.update_task_text(conn, existing['task_id'], text)
    else:  # update_all
        store.update_task_all(conn, existing['task_id'], text, project, due)
    store.update_item_hash(conn, existing['id'], new_hash, now_iso)
    return (0, 1, 0)


def _record_run(conn, integration_id, started_at, trigger, status, result=None, error=None):
    """Grava uma linha no histórico de execuções (integration_runs)."""
    result = result or {}
    store.insert_run(
        conn, integration_id, started_at, datetime.utcnow().isoformat(),
        trigger, status,
        result.get('total_items', 0),
        result.get('created', 0),
        result.get('updated', 0),
        result.get('skipped', 0),
        error,
    )


def run_integration(integration_id, dry_run=False, trigger='manual'):
    """Carrega a integração salva e executa (preview ou importação real)."""
    with connection() as conn:
        row = store.get_full(conn, integration_id)
        if not row:
            raise IntegrationError('Integração não encontrada.')
        try:
            config = json.loads(row['config_json'])
        except (ValueError, TypeError):
            raise IntegrationError('Configuração inválida (JSON corrompido).')

        if dry_run:
            return run_config(config, dry_run=True, integration_id=int(integration_id))

        owner_user_id = _owner_of(row)
        started_at = datetime.utcnow().isoformat()
        try:
            result = run_config(config, dry_run=False, integration_id=int(integration_id),
                                conn=conn, owner_user_id=owner_user_id)
        except IntegrationError as exc:
            store.mark_error(conn, integration_id, datetime.utcnow().isoformat(), str(exc))
            _record_run(conn, integration_id, started_at, trigger, 'error', error=str(exc))
            conn.commit()
            raise

        store.mark_ok(conn, integration_id, datetime.utcnow().isoformat(), result.get('created', 0))
        _record_run(conn, integration_id, started_at, trigger, 'ok', result=result)
        conn.commit()
        return result


def commit_items(integration_id, items, on_update='skip', reimport_deleted=False):
    """
    Importação interativa: cria/atualiza tasks a partir de uma lista explícita
    de itens já editados/selecionados pelo usuário na prévia.

    items: lista de dicts {external_id, project, text, due_date}.
    Aplica dedup por (integration_id, external_id) e a política on_update.
    """
    integration_id = int(integration_id)
    on_update = (on_update or 'skip').lower()
    reimport_deleted = bool(reimport_deleted)
    items = items or []
    if len(items) > MAX_ITEMS_PER_RUN:
        items = items[:MAX_ITEMS_PER_RUN]

    with connection() as conn:
        row = store.get_full(conn, integration_id)
        if not row:
            raise IntegrationError('Integração não encontrada.')

        owner_user_id = _owner_of(row)
        created = updated = skipped = 0
        today_str = date.today().strftime('%d/%m/%Y')
        started_at = now_iso = datetime.utcnow().isoformat()

        for it in items:
            it = it or {}
            ext = str(it.get('external_id') or '').strip()
            project = str(it.get('project') or '').strip()[:MAX_PROJECT_LEN]
            text = str(it.get('text') or '').strip()[:MAX_TEXT_LEN]
            due = str(it.get('due_date') or '').strip()
            if not ext or not project or not text:
                skipped += 1
                continue
            created_i, updated_i, skipped_i = _upsert_task(
                conn, integration_id, owner_user_id, ext, project, text, due, on_update, today_str, now_iso,
                reimport_deleted=reimport_deleted
            )
            created += created_i
            updated += updated_i
            skipped += skipped_i

        result = {
            'total_items': len(items),
            'created': created,
            'updated': updated,
            'skipped': skipped,
        }
        store.mark_ok(conn, integration_id, datetime.utcnow().isoformat(), created)
        _record_run(conn, integration_id, started_at, 'import', 'ok', result=result)
        conn.commit()
        return result


def list_runs(integration_id, limit=50):
    """Retorna o histórico de execuções (mais recentes primeiro)."""
    return store.list_runs(integration_id, limit=limit)


# ── Mascaramento / merge de segredos ───────────────────────────────
def mask_config(config):
    """Cópia da config com segredos mascarados (para enviar ao cliente)."""
    cfg = copy.deepcopy(config or {})
    auth = (cfg.get('connection') or {}).get('auth') or {}
    for field in SECRET_FIELDS:
        if auth.get(field):
            auth[field] = SECRET_MASK
    return cfg


def merge_secrets(new_config, old_config):
    """Se o cliente enviou o valor mascarado, preserva o segredo já salvo."""
    cfg = copy.deepcopy(new_config or {})
    new_auth = (cfg.get('connection') or {}).get('auth') or {}
    old_auth = ((old_config or {}).get('connection') or {}).get('auth') or {}
    for field in SECRET_FIELDS:
        if new_auth.get(field) == SECRET_MASK:
            if old_auth.get(field):
                new_auth[field] = old_auth[field]
            else:
                new_auth.pop(field, None)
    return cfg
