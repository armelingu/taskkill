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
import ipaddress
import json
import re
import socket
from datetime import date, datetime

import httpx

from database import get_db_connection

# ── Limites / constantes de segurança ──────────────────────────────
FETCH_TIMEOUT_SECS = 10.0
MAX_RESPONSE_BYTES = 5 * 1024 * 1024   # 5 MB
MAX_ITEMS_PER_RUN = 500
PREVIEW_LIMIT = 20
MAX_TEXT_LEN = 1000                    # espelha routes.MAX_TEXT_LEN
MAX_PROJECT_LEN = 18                   # espelha routes.MAX_PROJECT_LEN
# Dias da semana válidos p/ due_date (espelha routes.ALLOWED_DUE_DAYS).
# No Taskkill, o "prazo" da tarefa é um dia da semana, não uma data.
ALLOWED_DUE_DAYS = {'', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta'}

ALLOWED_METHODS = {'GET', 'POST'}
SECRET_MASK = '••••••••'
# Campos considerados segredo dentro de connection.auth
SECRET_FIELDS = ('token', 'value', 'password')

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
def _is_blocked_ip(ip_str):
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return True  # não parseável como IP -> bloqueia por precaução
    return (
        ip.is_private or ip.is_loopback or ip.is_link_local or
        ip.is_multicast or ip.is_reserved or ip.is_unspecified
    )


def _assert_url_allowed(url, allow_private=False):
    parts = httpx.URL(url)
    scheme = parts.scheme
    if scheme not in ('http', 'https'):
        raise IntegrationError('URL inválida: use http ou https.')
    host = parts.host
    if not host:
        raise IntegrationError('URL inválida: host ausente.')
    if allow_private:
        return
    port = parts.port or (443 if scheme == 'https' else 80)
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise IntegrationError(f'Não foi possível resolver o host: {host}')
    for info in infos:
        ip_str = info[4][0]
        if _is_blocked_ip(ip_str):
            raise IntegrationError(
                'Destino bloqueado (endereço interno/privado). '
                'Marque "permitir rede interna" se isso for intencional.'
            )


# ── Requisição HTTP ────────────────────────────────────────────────
def _build_auth_and_headers(connection):
    headers = dict(connection.get('headers') or {})
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

    return headers, httpx_auth


def fetch_payload(connection, allow_private=None):
    """Faz a requisição e devolve o JSON parseado (dict/list)."""
    connection = connection or {}
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
    _assert_url_allowed(url, allow_private=allow_private)

    headers, httpx_auth = _build_auth_and_headers(connection)
    params = connection.get('query') or {}
    body = connection.get('body')

    req_kwargs = {'params': params, 'headers': headers}
    if httpx_auth:
        req_kwargs['auth'] = httpx_auth
    if method == 'POST' and body is not None:
        if isinstance(body, (dict, list)):
            req_kwargs['json'] = body
        else:
            req_kwargs['content'] = str(body)

    try:
        # follow_redirects=False evita que um redirect leve a um alvo interno.
        with httpx.Client(timeout=FETCH_TIMEOUT_SECS, follow_redirects=False) as client:
            resp = client.request(method, url, **req_kwargs)
    except httpx.RequestError as exc:
        raise IntegrationError(f'Falha na requisição: {exc.__class__.__name__}')

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
    """Resolve o dia da semana (Segunda–Sexta) da tarefa a partir do mapeamento."""
    due_cfg = due_cfg or {}
    mode = (due_cfg.get('mode') or 'none').lower()
    if mode == 'fixed':
        due = str(due_cfg.get('value') or '').strip()
    elif mode == 'field':
        val = resolve_path(item, due_cfg.get('field') or '')
        due = '' if val is None else str(val).strip()
    else:
        due = ''
    return due if due in ALLOWED_DUE_DAYS else ''


# ── Execução (preview e importação real) ───────────────────────────
def run_config(config, dry_run=True, integration_id=None, conn=None):
    """
    Executa a partir de um dict de config.
    - dry_run=True: não persiste; retorna preview.
    - dry_run=False: cria/atualiza tasks e registra em integration_items (usa conn).
    """
    config = config or {}
    connection = config.get('connection') or {}
    items_path = config.get('items_path') or ''
    mapping = config.get('mapping') or {}
    on_update = (config.get('on_update') or 'skip').lower()

    payload = fetch_payload(connection)
    items = extract_items(payload, items_path)
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
            conn, integration_id, ext, project, text, due, on_update, today_str, now_iso
        )
        created += created_i
        updated += updated_i
        skipped += skipped_i

    return {'total_items': len(items), 'created': created, 'updated': updated, 'skipped': skipped}


def _upsert_task(conn, integration_id, ext, project, text, due, on_update, today_str, now_iso):
    """Cria ou atualiza uma task a partir de um item já resolvido. Retorna (created, updated, skipped)."""
    if due not in ALLOWED_DUE_DAYS:
        due = ''

    # Garante o projeto na tabela (para aparecer no sidebar).
    conn.execute('INSERT OR IGNORE INTO projects (name) VALUES (?)', (project,))

    existing = conn.execute(
        'SELECT id, task_id FROM integration_items '
        'WHERE integration_id = ? AND external_id = ?',
        (integration_id, ext)
    ).fetchone()

    if existing:
        if on_update == 'update_text' and existing['task_id']:
            conn.execute('UPDATE tasks SET text = ? WHERE id = ?', (text, existing['task_id']))
            conn.execute('UPDATE integration_items SET updated_at = ? WHERE id = ?',
                         (now_iso, existing['id']))
            return (0, 1, 0)
        return (0, 0, 1)

    row = conn.execute(
        'SELECT COALESCE(MAX(position), -1) AS max_pos FROM tasks '
        'WHERE project = ? AND deleted = 0',
        (project,)
    ).fetchone()
    new_pos = int(row['max_pos']) + 1

    cur = conn.execute(
        'INSERT INTO tasks (project, text, completed, created_date, due_date, position, deleted) '
        'VALUES (?, ?, 0, ?, ?, ?, 0)',
        (project, text, today_str, due, new_pos)
    )
    task_id = cur.lastrowid
    conn.execute(
        'INSERT INTO integration_items (integration_id, external_id, task_id, created_at, updated_at) '
        'VALUES (?, ?, ?, ?, ?)',
        (integration_id, ext, task_id, now_iso, now_iso)
    )
    return (1, 0, 0)


def run_integration(integration_id, dry_run=False):
    """Carrega a integração salva e executa (preview ou importação real)."""
    with get_db_connection() as conn:
        row = conn.execute('SELECT * FROM integrations WHERE id = ?', (int(integration_id),)).fetchone()
        if not row:
            raise IntegrationError('Integração não encontrada.')
        try:
            config = json.loads(row['config_json'])
        except (ValueError, TypeError):
            raise IntegrationError('Configuração inválida (JSON corrompido).')

        if dry_run:
            return run_config(config, dry_run=True, integration_id=int(integration_id))

        try:
            result = run_config(config, dry_run=False, integration_id=int(integration_id), conn=conn)
        except IntegrationError as exc:
            conn.execute(
                'UPDATE integrations SET last_run_at = ?, last_status = ?, last_error = ? WHERE id = ?',
                (datetime.utcnow().isoformat(), 'error', str(exc), int(integration_id))
            )
            conn.commit()
            raise

        conn.execute(
            'UPDATE integrations SET last_run_at = ?, last_status = ?, last_error = NULL, '
            'last_item_count = ? WHERE id = ?',
            (datetime.utcnow().isoformat(), 'ok', result.get('created', 0), int(integration_id))
        )
        conn.commit()
        return result


def commit_items(integration_id, items, on_update='skip'):
    """
    Importação interativa: cria/atualiza tasks a partir de uma lista explícita
    de itens já editados/selecionados pelo usuário na prévia.

    items: lista de dicts {external_id, project, text, due_date}.
    Aplica dedup por (integration_id, external_id) e a política on_update.
    """
    integration_id = int(integration_id)
    on_update = (on_update or 'skip').lower()
    items = items or []
    if len(items) > MAX_ITEMS_PER_RUN:
        items = items[:MAX_ITEMS_PER_RUN]

    with get_db_connection() as conn:
        row = conn.execute('SELECT id FROM integrations WHERE id = ?', (integration_id,)).fetchone()
        if not row:
            raise IntegrationError('Integração não encontrada.')

        created = updated = skipped = 0
        today_str = date.today().strftime('%d/%m/%Y')
        now_iso = datetime.utcnow().isoformat()

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
                conn, integration_id, ext, project, text, due, on_update, today_str, now_iso
            )
            created += created_i
            updated += updated_i
            skipped += skipped_i

        conn.execute(
            'UPDATE integrations SET last_run_at = ?, last_status = ?, last_error = NULL, '
            'last_item_count = ? WHERE id = ?',
            (datetime.utcnow().isoformat(), 'ok', created, integration_id)
        )
        conn.commit()
        return {'created': created, 'updated': updated, 'skipped': skipped}


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
