import hmac
import io
import json
import logging
import os
import shutil
import sqlite3
import tempfile
import threading
from datetime import date, datetime, timedelta

from functools import wraps

from flask import Blueprint, render_template, request, jsonify, send_file, session, redirect, url_for, abort, Response

from database import get_db_connection, get_db_path, init_db
from werkzeug.security import check_password_hash, generate_password_hash

import integrations
import scheduler
from integrations import IntegrationError

# Hash "dummy" usado para igualar o tempo de resposta do login quando o usuário
# não existe (ou a senha excede o limite). Sem isso, o "caminho de usuário
# inexistente" é mais rápido porque não roda check_password_hash, permitindo
# enumeração de usuários por timing. Calculado uma única vez no import.
_DUMMY_PASSWORD_HASH = generate_password_hash('taskkill-timing-equalizer')

# Logger de eventos de autenticação (login, falhas, lockouts, logout). Facilita
# auditoria e detecção de ataques em andamento. A config de handler/nível fica
# em app.py (logging.basicConfig).
auth_logger = logging.getLogger('taskkill.auth')


def _csrf_ok(expected, got) -> bool:
    """
    Compara tokens CSRF em tempo constante (evita canal de timing sobre o token).
    Retorna False se qualquer um for vazio/ausente.
    """
    if not expected or not got:
        return False
    return hmac.compare_digest(str(expected), str(got))


def _log_auth(event: str, *, username: str = '', ip: str = '', detail: str = '') -> None:
    """Registra um evento de autenticação de forma consistente."""
    # Nunca logamos senha. Username é útil para auditoria da conta admin.
    parts = [f'event={event}']
    if username:
        parts.append(f'user={username!r}')
    if ip:
        parts.append(f'ip={ip}')
    if detail:
        parts.append(detail)
    msg = ' '.join(parts)
    if event in ('login_success', 'logout', 'logout_all'):
        auth_logger.info(msg)
    else:
        auth_logger.warning(msg)

# ---------------------------------------------------------------------------
# Rate-limit de login (in-memory)
# ---------------------------------------------------------------------------
# Dois eixos de proteção:
#   - por IP:       barra brute force de uma mesma origem.
#   - por username: barra brute force DISTRIBUÍDO (muitos IPs) contra uma conta.
# Ambos usam lockout com backoff exponencial (cada novo bloqueio dura mais,
# até um teto) para desencorajar tentativas persistentes sem prender threads.
_LOGIN_MAX_ATTEMPTS   = int(os.environ.get('LOGIN_MAX_ATTEMPTS', '5'))
_USER_MAX_ATTEMPTS    = int(os.environ.get('LOGIN_USER_MAX_ATTEMPTS', '10'))
_LOGIN_LOCKOUT_SECS   = int(os.environ.get('LOGIN_LOCKOUT_SECONDS', '900'))          # base: 15 min
_LOGIN_LOCKOUT_MAX    = int(os.environ.get('LOGIN_LOCKOUT_MAX_SECONDS', str(6 * 3600)))  # teto: 6h
_LOGIN_MAX_TRACKED    = int(os.environ.get('LOGIN_MAX_TRACKED_IPS', '10000'))
_login_attempts: dict = {}   # por IP:       { ip: {'count','locked_until','strikes'} }
_user_attempts: dict = {}    # por username: { user: {'count','locked_until','strikes'} }
_login_lock = threading.Lock()

# Tamanho máximo de senha aceito antes de hashear. Evita DoS de CPU (pbkdf2
# processando um payload enorme). Nenhuma senha legítima chega perto disso.
MAX_PASSWORD_LEN = int(os.environ.get('TASKKILL_MAX_PASSWORD_LEN', '256'))


def _get_client_ip() -> str:
    """
    IP do cliente para o rate-limit.

    Usa `request.remote_addr`, que é a única fonte confiável: em produção o
    ProxyFix (app.py) já normaliza a partir do proxy confiável (Caddy); sem
    proxy, é o IP real do socket. NÃO lemos X-Forwarded-For cru aqui — o cliente
    pode forjar esse header e trocar de "IP" a cada request, burlando o lockout.
    """
    return request.remote_addr or 'unknown'


def _prune_locked(store: dict, now: datetime) -> None:
    """
    Remove entradas sem bloqueio ativo quando o dicionário cresce demais.
    Defesa em profundidade contra crescimento de memória. Chamar com o lock.
    """
    if len(store) < _LOGIN_MAX_TRACKED:
        return
    stale = [
        k for k, e in store.items()
        if not (e.get('locked_until') and now < e['locked_until'])
    ]
    for k in stale:
        store.pop(k, None)


def _is_locked(store: dict, key: str) -> tuple[bool, int]:
    """Retorna (bloqueado, segundos_restantes) para uma chave do store."""
    with _login_lock:
        entry = store.get(key)
        if not entry:
            return False, 0
        locked_until = entry.get('locked_until')
        if locked_until and datetime.utcnow() < locked_until:
            return True, int((locked_until - datetime.utcnow()).total_seconds())
        return False, 0


def _record_failed(store: dict, key: str, max_attempts: int) -> int:
    """
    Registra tentativa falha para uma chave. Ao atingir o limite, aplica lockout
    com backoff exponencial (base * 2^(strikes-1), limitado por _LOGIN_LOCKOUT_MAX)
    e zera o contador. Retorna a contagem atual (0 se acabou de bloquear).
    """
    with _login_lock:
        now = datetime.utcnow()
        _prune_locked(store, now)
        entry = store.setdefault(key, {'count': 0, 'locked_until': None, 'strikes': 0})
        if entry.get('locked_until') and now >= entry['locked_until']:
            entry['count'] = 0
            entry['locked_until'] = None
        entry['count'] += 1
        if entry['count'] >= max_attempts:
            entry['strikes'] = int(entry.get('strikes', 0)) + 1
            secs = min(_LOGIN_LOCKOUT_SECS * (2 ** (entry['strikes'] - 1)), _LOGIN_LOCKOUT_MAX)
            entry['locked_until'] = now + timedelta(seconds=secs)
            entry['count'] = 0
        return int(entry['count'])


def _reset_attempts(store: dict, key: str) -> None:
    with _login_lock:
        store.pop(key, None)


# Wrappers legíveis para cada eixo
def _is_ip_locked(ip: str) -> tuple[bool, int]:
    return _is_locked(_login_attempts, ip)


def _is_user_locked(username: str) -> tuple[bool, int]:
    return _is_locked(_user_attempts, username)


def _record_failed_login(ip: str) -> int:
    return _record_failed(_login_attempts, ip, _LOGIN_MAX_ATTEMPTS)


def _record_failed_user(username: str) -> int:
    return _record_failed(_user_attempts, username, _USER_MAX_ATTEMPTS)


def _reset_login_attempts(ip: str) -> None:
    _reset_attempts(_login_attempts, ip)


def _reset_user_attempts(username: str) -> None:
    _reset_attempts(_user_attempts, username)

# Blueprints permitem "encapsular" as rotas e injetá-las no arquivo principal.
main_bp = Blueprint('main', __name__)
api_bp = Blueprint('api', __name__, url_prefix='/api')

# Regras de domínio (local single-user)
ALLOWED_DUE_DAYS = {'', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta'}
MAX_PROJECT_LEN = 18
MAX_TEXT_LEN = 1000

def _coerce_01(value, field_name: str):
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int) and value in (0, 1):
        return value
    raise ValueError(f"{field_name} must be boolean/0/1")


def _ensure_csrf_token() -> str:
    token = session.get('csrf_token')
    if not token:
        token = os.urandom(24).hex()
        session['csrf_token'] = token
    return token


def _current_user():
    uid = session.get('user_id')
    if not uid:
        return None
    with get_db_connection() as conn:
        row = conn.execute(
            'SELECT id, username, is_admin, created_at, last_login_at, '
            '       session_version, avatar_mime '
            'FROM users WHERE id = ?', (int(uid),)
        ).fetchone()
    if not row:
        return None
    # Valida a versão de sessão: se o usuário clicou em "sair de todos os
    # dispositivos", a versão no banco muda e os cookies antigos deixam de valer.
    if int(row['session_version']) != int(session.get('sv', 0)):
        return None
    data = dict(row)
    data['has_avatar'] = bool(row['avatar_mime'])
    return data


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not _current_user():
            session.clear()
            return redirect(url_for('main.login'))
        return fn(*args, **kwargs)
    return wrapper


def admin_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        user = _current_user()
        if not user or not bool(user.get('is_admin')):
            abort(403)
        return fn(*args, **kwargs)
    return wrapper


@api_bp.before_request
def require_auth_and_csrf():
    # Bloqueia API sem sessão válida (inclui checagem de versão de sessão)
    if not _current_user():
        return jsonify({"error": "Unauthorized"}), 401

    # CSRF para métodos mutáveis
    if request.method in ('POST', 'PUT', 'DELETE'):
        expected = session.get('csrf_token')
        got = request.headers.get('X-CSRF-Token')
        if not _csrf_ok(expected, got):
            return jsonify({"error": "CSRF token inválido"}), 403


def api_admin_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        user = _current_user()
        if not user or not bool(user.get('is_admin')):
            return jsonify({"error": "Forbidden"}), 403
        return fn(*args, **kwargs)
    return wrapper


# ===================================================================
# ROTAS DO FRONTEND (Páginas Visuais Web)
# ===================================================================
@main_bp.route('/')
@login_required
def index():
    return render_template('index.html', csrf_token=_ensure_csrf_token(), user=_current_user())


@main_bp.route('/login', methods=['GET', 'POST'])
def login():
    # Se já está logado, vai direto pro app
    if session.get('user_id'):
        return redirect(url_for('main.index'))

    csrf = _ensure_csrf_token()
    ip   = _get_client_ip()

    if request.method == 'POST':
        # Rate-limit por IP: verifica bloqueio antes de qualquer processamento
        locked, remaining = _is_ip_locked(ip)
        if locked:
            mins = (remaining // 60) + 1
            _log_auth('lockout_ip_block', ip=ip, detail=f'remaining_s={remaining}')
            error = f'Muitas tentativas. Tente novamente em {mins} minuto(s).'
            return render_template('login.html', error=error, csrf_token=csrf), 429

        form_csrf = request.form.get('csrf_token')
        if not _csrf_ok(csrf, form_csrf):
            _log_auth('csrf_fail', ip=ip, detail='route=login')
            return render_template('login.html', error='Sessão expirada. Recarregue e tente novamente.', csrf_token=csrf), 400

        username = (request.form.get('username') or '').strip()
        password = (request.form.get('password') or '')
        if not username or not password:
            return render_template('login.html', error='Usuário e senha são obrigatórios.', csrf_token=csrf), 400

        # Rate-limit por conta: barra brute force distribuído (muitos IPs)
        uname_key = username.lower()
        u_locked, u_remaining = _is_user_locked(uname_key)
        if u_locked:
            mins = (u_remaining // 60) + 1
            _log_auth('lockout_user_block', username=username, ip=ip, detail=f'remaining_s={u_remaining}')
            error = f'Muitas tentativas para esta conta. Tente novamente em {mins} minuto(s).'
            return render_template('login.html', error=error, csrf_token=csrf), 429

        with get_db_connection() as conn:
            row = conn.execute('SELECT id, username, password_hash, is_admin FROM users WHERE username = ?', (username,)).fetchone()

        # Verificação em tempo (quase) constante: sempre executa um hash, exista
        # o usuário ou não. Senhas acima do limite não são hasheadas (anti-DoS),
        # mas ainda rodam o hash dummy para não vazar timing.
        if row and len(password) <= MAX_PASSWORD_LEN:
            valid = check_password_hash(row['password_hash'], password)
        else:
            check_password_hash(_DUMMY_PASSWORD_HASH, password[:MAX_PASSWORD_LEN])
            valid = False

        if not valid:
            ip_count = _record_failed_login(ip)
            _record_failed_user(uname_key)
            _log_auth('login_fail', username=username, ip=ip)
            # Se qualquer eixo acabou de bloquear, comunica o bloqueio (429)
            ip_locked_now, ip_rem = _is_ip_locked(ip)
            user_locked_now, user_rem = _is_user_locked(uname_key)
            if ip_locked_now or user_locked_now:
                rem = max(ip_rem, user_rem)
                mins = (rem // 60) + 1
                _log_auth('lockout_triggered', username=username, ip=ip, detail=f'lock_s={rem}')
                error = f'Muitas tentativas. Conta bloqueada. Tente novamente em {mins} minuto(s).'
                return render_template('login.html', error=error, csrf_token=csrf), 429
            remaining_attempts = max(0, _LOGIN_MAX_ATTEMPTS - ip_count)
            error = f'Credenciais inválidas. Tentativas restantes: {remaining_attempts}.'
            return render_template('login.html', error=error, csrf_token=csrf), 401

        # Login bem-sucedido: reseta contadores e regenera sessão (previne session fixation)
        _reset_login_attempts(ip)
        _reset_user_attempts(uname_key)
        _log_auth('login_success', username=username, ip=ip)

        now_iso = datetime.utcnow().isoformat()
        with get_db_connection() as conn:
            prev = conn.execute('SELECT last_login_at, session_version FROM users WHERE id = ?',
                                (int(row['id']),)).fetchone()
            prev_login = prev['last_login_at'] if prev else None
            session_version = int(prev['session_version']) if prev else 0
            conn.execute('UPDATE users SET last_login_at = ? WHERE id = ?', (now_iso, int(row['id'])))
            conn.commit()

        session.clear()                       # descarta sessão anterior (novo ID gerado pelo Flask)
        session.permanent = True              # ativa expiração por PERMANENT_SESSION_LIFETIME
        session['user_id']  = int(row['id'])
        session['is_admin'] = int(row['is_admin'])
        session['sv']       = session_version  # versão de sessão (logout global)
        session['prev_login'] = prev_login     # acesso anterior (para exibir no perfil)
        _ensure_csrf_token()                  # gera novo CSRF token na sessão limpa
        return redirect(url_for('main.index'))

    return render_template('login.html', csrf_token=csrf)


@main_bp.route('/logout', methods=['POST'])
def logout():
    csrf = session.get('csrf_token')
    form_csrf = request.form.get('csrf_token')
    if not _csrf_ok(csrf, form_csrf):
        abort(403)
    user = _current_user()
    _log_auth('logout', username=(user or {}).get('username', ''), ip=_get_client_ip())
    session.clear()
    return redirect(url_for('main.login'))


# Rotas legadas: o perfil agora é um painel inline no app (index.html).
@main_bp.route('/perfil')
@main_bp.route('/admin')
@login_required
def perfil():
    return redirect(url_for('main.index'))


# ===================================================================
# Perfil / conta (API JSON)
# ===================================================================
ALLOWED_AVATAR_MIMES = {'image/png', 'image/jpeg', 'image/gif', 'image/webp'}
MAX_AVATAR_BYTES = 2 * 1024 * 1024  # 2 MB


def _sniff_image_mime(data: bytes):
    """Detecta o tipo de imagem por magic bytes (sem confiar na extensão)."""
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        return 'image/png'
    if data[:3] == b'\xff\xd8\xff':
        return 'image/jpeg'
    if data[:6] in (b'GIF87a', b'GIF89a'):
        return 'image/gif'
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'image/webp'
    return None


@api_bp.route('/profile', methods=['GET'])
def get_profile():
    user = _current_user()
    return jsonify({
        'username': user['username'],
        'is_admin': bool(user['is_admin']),
        'created_at': user.get('created_at'),
        'last_login_at': user.get('last_login_at'),
        'prev_login_at': session.get('prev_login'),
        'has_avatar': user.get('has_avatar', False),
    })


@api_bp.route('/profile/username', methods=['POST'])
def update_username():
    user = _current_user()
    data = request.get_json(silent=True) or {}
    new_username = str(data.get('new_username') or '').strip()
    password = data.get('password') or ''
    if not new_username:
        return jsonify({"error": "O nome de usuário não pode ser vazio."}), 400
    if len(new_username) > 60:
        return jsonify({"error": "Nome de usuário muito longo (máx. 60 caracteres)."}), 400
    with get_db_connection() as conn:
        row = conn.execute('SELECT password_hash FROM users WHERE id = ?', (int(user['id']),)).fetchone()
        if not row or not check_password_hash(row['password_hash'], password[:MAX_PASSWORD_LEN]):
            return jsonify({"error": "Senha incorreta."}), 400
        exists = conn.execute('SELECT id FROM users WHERE username = ? AND id != ?',
                              (new_username, int(user['id']))).fetchone()
        if exists:
            return jsonify({"error": "Esse nome de usuário já está em uso."}), 400
        conn.execute('UPDATE users SET username = ? WHERE id = ?', (new_username, int(user['id'])))
        conn.commit()
    return jsonify({"message": f'Usuário atualizado para "{new_username}".', "username": new_username})


@api_bp.route('/profile/password', methods=['POST'])
def update_password():
    user = _current_user()
    data = request.get_json(silent=True) or {}
    current_pw = data.get('current_password') or ''
    new_pw = data.get('new_password') or ''
    confirm_pw = data.get('confirm_password') or ''
    if len(new_pw.strip()) < 10:
        return jsonify({"error": "A nova senha precisa ter pelo menos 10 caracteres."}), 400
    if len(new_pw) > MAX_PASSWORD_LEN:
        return jsonify({"error": f"A senha é muito longa (máx. {MAX_PASSWORD_LEN} caracteres)."}), 400
    if new_pw != confirm_pw:
        return jsonify({"error": "A confirmação da senha não confere."}), 400
    with get_db_connection() as conn:
        row = conn.execute('SELECT password_hash FROM users WHERE id = ?', (int(user['id']),)).fetchone()
        if not row or not check_password_hash(row['password_hash'], current_pw[:MAX_PASSWORD_LEN]):
            return jsonify({"error": "Senha atual incorreta."}), 400
        conn.execute('UPDATE users SET password_hash = ? WHERE id = ?',
                     (generate_password_hash(new_pw.strip()), int(user['id'])))
        conn.commit()
    return jsonify({"message": "Senha atualizada com sucesso."})


@api_bp.route('/profile/avatar', methods=['POST'])
def upload_avatar():
    user = _current_user()
    file = request.files.get('file')
    if not file:
        return jsonify({"error": "Nenhum arquivo enviado."}), 400
    data = file.read(MAX_AVATAR_BYTES + 1)
    if len(data) > MAX_AVATAR_BYTES:
        return jsonify({"error": "Imagem muito grande (limite de 2 MB)."}), 400
    mime = _sniff_image_mime(data)
    if mime not in ALLOWED_AVATAR_MIMES:
        return jsonify({"error": "Formato inválido. Use PNG, JPEG, GIF ou WEBP."}), 400
    with get_db_connection() as conn:
        conn.execute('UPDATE users SET avatar_mime = ?, avatar_data = ? WHERE id = ?',
                     (mime, sqlite3.Binary(data), int(user['id'])))
        conn.commit()
    return jsonify({"message": "Foto atualizada.", "has_avatar": True})


@api_bp.route('/profile/avatar', methods=['DELETE'])
def delete_avatar():
    user = _current_user()
    with get_db_connection() as conn:
        conn.execute('UPDATE users SET avatar_mime = NULL, avatar_data = NULL WHERE id = ?',
                     (int(user['id']),))
        conn.commit()
    return jsonify({"message": "Foto removida.", "has_avatar": False})


@api_bp.route('/profile/logout-all', methods=['POST'])
def logout_all_devices():
    user = _current_user()
    with get_db_connection() as conn:
        conn.execute('UPDATE users SET session_version = session_version + 1 WHERE id = ?',
                     (int(user['id']),))
        new_sv = conn.execute('SELECT session_version FROM users WHERE id = ?',
                              (int(user['id']),)).fetchone()['session_version']
        conn.commit()
    # Mantém a sessão atual válida atualizando a versão no cookie.
    session['sv'] = int(new_sv)
    _log_auth('logout_all', username=user.get('username', ''), ip=_get_client_ip())
    return jsonify({"message": "As outras sessões foram encerradas."})


@api_bp.route('/avatar', methods=['GET'])
def get_avatar():
    user = _current_user()
    with get_db_connection() as conn:
        row = conn.execute('SELECT avatar_mime, avatar_data FROM users WHERE id = ?',
                           (int(user['id']),)).fetchone()
    if not row or not row['avatar_mime'] or row['avatar_data'] is None:
        return jsonify({"error": "Sem avatar"}), 404
    resp = Response(bytes(row['avatar_data']), mimetype=row['avatar_mime'])
    resp.headers['Cache-Control'] = 'private, no-cache'
    return resp


# ===================================================================
# ROTAS DA API REST (A conexão com o JavaScript Puro - "CRUD")
# ===================================================================

# ── Projetos ────────────────────────────────────────────────────────

@api_bp.route('/projects', methods=['GET'])
def get_projects():
    with get_db_connection() as conn:
        rows = conn.execute("SELECT name FROM projects ORDER BY name ASC").fetchall()
    return jsonify([r['name'] for r in rows])


@api_bp.route('/projects', methods=['POST'])
def create_project():
    data = request.json or {}
    name = str(data.get('name') or '').strip()
    if not name:
        return jsonify({"error": "Nome do projeto é obrigatório"}), 400
    if len(name) > MAX_PROJECT_LEN:
        return jsonify({"error": f"Nome muito longo (máx {MAX_PROJECT_LEN} chars)"}), 400
    with get_db_connection() as conn:
        try:
            conn.execute("INSERT INTO projects (name) VALUES (?)", (name,))
            conn.commit()
        except Exception:
            return jsonify({"error": "Projeto já existe"}), 409
    return jsonify({"name": name}), 201


@api_bp.route('/projects/<path:project_name>', methods=['DELETE'])
def delete_project(project_name):
    name = project_name.strip()
    with get_db_connection() as conn:
        conn.execute("DELETE FROM projects WHERE name = ?", (name,))
        conn.execute("UPDATE tasks SET deleted = 1 WHERE project = ?", (name,))
        conn.commit()
    return jsonify({"deleted": name})


# ── Tarefas ─────────────────────────────────────────────────────────

# 1. READ: Buscar todas as tarefas agrupadas por projeto
@api_bp.route('/tasks', methods=['GET'])
def get_tasks():
    with get_db_connection() as conn:
        cursor = conn.cursor()
        # Por consistência: o frontend trabalha por "projeto"; então ordenamos por projeto + posição.
        # Também escondemos tarefas arquivadas (deleted=1) por padrão.
        cursor.execute("SELECT * FROM tasks WHERE deleted = 0 ORDER BY project ASC, position ASC, id ASC")
        rows = cursor.fetchall()

        # O JS espera um formato Dictionary/HashMap de categorias pro Dashboard Global
        tasks_data = {}
        for row in rows:
            project = row['project']
            if project not in tasks_data:
                tasks_data[project] = []

            c_date = row['created_date'] if 'created_date' in row.keys() else None
            d_date = row['due_date'] if 'due_date' in row.keys() else None
            pos = row['position'] if 'position' in row.keys() else 0
            del_flag = bool(row['deleted']) if 'deleted' in row.keys() else False

            tasks_data[project].append({
                'id': row['id'],
                'project': row['project'],
                'text': row['text'],
                'completed': bool(row['completed']),
                'created_date': c_date,
                'due_date': d_date,
                'position': pos,
                'deleted': del_flag
            })

        return jsonify(tasks_data)

# 2. CREATE: Adicionar uma nova tarefa em um projeto
@api_bp.route('/tasks', methods=['POST'])
def create_task():
    data = request.json
    if not isinstance(data, dict):
        return jsonify({"error": "Bad Request: JSON body is required"}), 400
    project = data.get('project')
    text = data.get('text')

    # SEGURANÇA BÁSICA: Validando Entradas do Usuário para evitar crashs e spam
    if not project or not text:
        return jsonify({"error": "Bad Request: project and text are required"}), 400

    project = str(project).strip()
    text = str(text).strip()
    due_date = data.get('due_date') # Opcional
    if due_date is not None:
        due_date = str(due_date).strip()

    if len(project) == 0 or len(project) > MAX_PROJECT_LEN:
        return jsonify({"error": "Bad Request: project length invalid"}), 400

    if len(text) == 0 or len(text) > MAX_TEXT_LEN:
        return jsonify({"error": "Payload Length Exceeded or Empty"}), 400

    if due_date is not None and due_date not in ALLOWED_DUE_DAYS:
        return jsonify({"error": "Bad Request: due_date invalid"}), 400

    # Salva apenas a data formata sem hora no padrão brasileiro para minimalismo.
    today_str = date.today().strftime("%d/%m/%Y")

    with get_db_connection() as conn:
        cursor = conn.cursor()
        # Define a posição no FINAL do projeto para manter o ranking consistente
        cursor.execute(
            "SELECT COALESCE(MAX(position), -1) AS max_pos FROM tasks WHERE project = ? AND deleted = 0",
            (project,)
        )
        row = cursor.fetchone()
        max_pos = row['max_pos'] if row and row['max_pos'] is not None else -1
        new_pos = int(max_pos) + 1

        cursor.execute(
            "INSERT INTO tasks (project, text, completed, created_date, due_date, position, deleted) VALUES (?, ?, 0, ?, ?, ?, 0)",
            (project, text, today_str, due_date, new_pos)
        )
        conn.commit()
        task_id = cursor.lastrowid # Recupera ID criado para UX não piscar e deletar certo sem refresh

        return jsonify({
            "id": task_id,
            "project": project,
            "text": text,
            "completed": False,
            "created_date": today_str,
            "due_date": due_date,
            "position": new_pos,
            "deleted": False
        }), 201

# 3. UPDATE: Atualizar nome por texto ou marca de check concluído
@api_bp.route('/tasks/<int:task_id>', methods=['PUT'])
def update_task(task_id):
    data = request.json
    if not isinstance(data, dict):
        return jsonify({"error": "Bad Request: JSON body is required"}), 400
    text = data.get('text')
    completed = data.get('completed')
    due_date = data.get('due_date')

    # Sanitização do Update
    if text is not None:
        text = str(text).strip()
        if len(text) == 0 or len(text) > MAX_TEXT_LEN:
             return jsonify({"error": "Payload Length Exceeded"}), 400

    if 'due_date' in data:
        if due_date is None:
            due_date = ''
        due_date = str(due_date).strip()
        if due_date not in ALLOWED_DUE_DAYS:
            return jsonify({"error": "Bad Request: due_date invalid"}), 400

    if completed is not None:
        try:
            completed = _coerce_01(completed, 'completed')
        except ValueError as e:
            return jsonify({"error": f"Bad Request: {e}"}), 400

    with get_db_connection() as conn:
        cursor = conn.cursor()

        # Logica inteligente que aceita um payload só de update text ou só update status.
        if text is not None and completed is not None:
            cursor.execute("UPDATE tasks SET text = ?, completed = ? WHERE id = ?", (text, completed, task_id))
        elif text is not None:
             cursor.execute("UPDATE tasks SET text = ? WHERE id = ?", (text, task_id))
        elif completed is not None:
             cursor.execute("UPDATE tasks SET completed = ? WHERE id = ?", (completed, task_id))

        # Faz um update separado/adicional de due_date se ele for enviado no objeto PUT
        if 'due_date' in data:
            cursor.execute("UPDATE tasks SET due_date = ? WHERE id = ?", (due_date, task_id))

        # Faz update da flag deleted (Lixeira/Arquivo)
        if 'deleted' in data:
            try:
                deleted = _coerce_01(data['deleted'], 'deleted')
            except ValueError as e:
                return jsonify({"error": f"Bad Request: {e}"}), 400
            cursor.execute("UPDATE tasks SET deleted = ? WHERE id = ?", (deleted, task_id))

        # Update the project if changed (used for drag and drop)
        if 'project' in data and data['project']:
            new_project = str(data['project']).strip()
            if len(new_project) == 0 or len(new_project) > MAX_PROJECT_LEN:
                return jsonify({"error": "Bad Request: project length invalid"}), 400
            # Ao mover de projeto, reposiciona para o FINAL do novo projeto.
            cursor.execute(
                "SELECT COALESCE(MAX(position), -1) AS max_pos FROM tasks WHERE project = ? AND deleted = 0",
                (new_project,)
            )
            row = cursor.fetchone()
            max_pos = row['max_pos'] if row and row['max_pos'] is not None else -1
            new_pos = int(max_pos) + 1

            cursor.execute(
                "UPDATE tasks SET project = ?, position = ? WHERE id = ?",
                (new_project, new_pos, task_id)
            )

        conn.commit()

    return jsonify({"success": True})

# 3.5. BATCH UPDATE: Reordenar posições após o arrastar e soltar do usuário
@api_bp.route('/tasks/reorder', methods=['PUT'])
def reorder_tasks():
    data = request.json
    # data is expected to be a list of dicts: [{'id': 1, 'position': 0}, {'id': 2, 'position': 1}]

    if not isinstance(data, list):
        return jsonify({"error": "Bad Request: payload must be a list"}), 400

    with get_db_connection() as conn:
        cursor = conn.cursor()

        # Sanitização + normalização dos IDs/posições
        seen_ids = set()
        updates = []
        ids = []
        for item in data:
            if not isinstance(item, dict):
                return jsonify({"error": "Bad Request: each item must be an object"}), 400
            if 'id' not in item or 'position' not in item:
                return jsonify({"error": "Bad Request: id and position are required"}), 400
            try:
                tid = int(item.get('id'))
                pos = int(item.get('position'))
            except (TypeError, ValueError):
                return jsonify({"error": "Bad Request: id/position must be integers"}), 400
            if pos < 0:
                return jsonify({"error": "Bad Request: position must be >= 0"}), 400
            if tid in seen_ids:
                return jsonify({"error": "Bad Request: duplicated id in payload"}), 400
            seen_ids.add(tid)
            updates.append((pos, tid))
            ids.append(tid)

        if not ids:
            return jsonify({"success": True})

        # Garantia forte: reorder deve ser de UM único projeto e incluir todas as tarefas ativas dele.
        qmarks = ",".join(["?"] * len(ids))
        cursor.execute(f"SELECT DISTINCT project FROM tasks WHERE deleted = 0 AND id IN ({qmarks})", ids)
        projects = [r['project'] for r in cursor.fetchall()]
        if len(projects) != 1:
            return jsonify({"error": "Bad Request: reorder must target a single project"}), 400

        project = projects[0]
        cursor.execute("SELECT COUNT(*) AS cnt FROM tasks WHERE project = ? AND deleted = 0", (project,))
        cnt = cursor.fetchone()['cnt']
        if int(cnt) != len(ids):
            return jsonify({"error": "Bad Request: reorder must include all active tasks of the project"}), 400

        cursor.executemany("UPDATE tasks SET position = ? WHERE id = ?", updates)
        conn.commit()

    return jsonify({"success": True})

# 4. DELETE: Arrancar os dados de fato do SQLite
@api_bp.route('/tasks/<int:task_id>', methods=['DELETE'])
def delete_task(task_id):
    with get_db_connection() as conn:
        cursor = conn.cursor()
        # Consistência com o modelo (flag deleted): arquiva em vez de remover.
        cursor.execute("UPDATE tasks SET deleted = 1 WHERE id = ?", (task_id,))
        conn.commit()
    return jsonify({"success": True})


# ===================================================================
# Backup / Restore (produto local)
# ===================================================================
@api_bp.route('/backup', methods=['GET'])
@api_admin_required
def backup_db():
    src_path = get_db_path()
    if not os.path.exists(src_path):
        init_db()

    tmp = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
    tmp_path = tmp.name
    tmp.close()

    try:
        with sqlite3.connect(src_path) as src, sqlite3.connect(tmp_path) as dst:
            src.backup(dst)

        with open(tmp_path, 'rb') as f:
            data = f.read()
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    bio = io.BytesIO(data)
    bio.seek(0)
    filename = f"taskkill-backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}.db"
    return send_file(
        bio,
        mimetype='application/octet-stream',
        as_attachment=True,
        download_name=filename
    )


@api_bp.route('/restore', methods=['POST'])
@api_admin_required
def restore_db():
    uploaded = request.files.get('file')
    if not uploaded:
        return jsonify({"error": "Bad Request: file is required"}), 400

    tmp = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
    tmp_path = tmp.name
    tmp.close()

    try:
        uploaded.save(tmp_path)

        # Valida integridade do arquivo antes de sobrescrever o db real
        with sqlite3.connect(tmp_path) as conn:
            row = conn.execute('PRAGMA integrity_check;').fetchone()
            if not row or str(row[0]).lower() != 'ok':
                return jsonify({"error": "Bad Request: invalid/corrupted sqlite backup"}), 400

            table = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'"
            ).fetchone()
            if not table:
                return jsonify({"error": "Bad Request: tasks table not found"}), 400

        dest_path = get_db_path()
        os.makedirs(os.path.dirname(dest_path), exist_ok=True)

        # Backup do banco atual antes de restaurar (rollback simples)
        if os.path.exists(dest_path):
            bak_path = dest_path + f".bak-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
            try:
                shutil.copy2(dest_path, bak_path)
            except OSError:
                pass

        shutil.copy2(tmp_path, dest_path)

        # Reaplica migrations/índices caso a versão do backup seja antiga
        init_db()
        return jsonify({"success": True})
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ===================================================================
# Integrações externas (admin) — CRUD + test + preview + run
# ===================================================================
def _integration_row_to_dict(row):
    try:
        cfg = json.loads(row['config_json'])
    except (ValueError, TypeError):
        cfg = {}
    keys = row.keys()
    return {
        'id': row['id'],
        'name': row['name'],
        'enabled': bool(row['enabled']),
        'last_run_at': row['last_run_at'],
        'last_status': row['last_status'],
        'last_error': row['last_error'],
        'last_item_count': row['last_item_count'],
        'schedule_enabled': bool(row['schedule_enabled']) if 'schedule_enabled' in keys else False,
        'schedule_interval_minutes': (row['schedule_interval_minutes'] if 'schedule_interval_minutes' in keys else 0) or 0,
        'next_run_at': row['next_run_at'] if 'next_run_at' in keys else None,
        'config': integrations.mask_config(cfg),
    }


@api_bp.route('/integrations', methods=['GET'])
@api_admin_required
def list_integrations():
    with get_db_connection() as conn:
        rows = conn.execute('SELECT * FROM integrations ORDER BY name ASC').fetchall()
    return jsonify([_integration_row_to_dict(r) for r in rows])


@api_bp.route('/integrations', methods=['POST'])
@api_admin_required
def create_integration():
    data = request.get_json(silent=True) or {}
    name = str(data.get('name') or '').strip()
    config = data.get('config') or {}
    if not name:
        return jsonify({"error": "Nome é obrigatório"}), 400
    if not isinstance(config, dict):
        return jsonify({"error": "Config inválida"}), 400

    sched = data.get('schedule') or {}
    sched_enabled = 1 if sched.get('enabled') else 0
    interval = scheduler.clamp_interval(sched.get('interval_minutes'))
    if sched_enabled and not interval:
        return jsonify({"error": f"Intervalo mínimo é {scheduler.MIN_INTERVAL_MINUTES} minutos"}), 400
    next_run = scheduler.compute_next_run(interval) if sched_enabled else None

    now = datetime.utcnow().isoformat()
    with get_db_connection() as conn:
        cursor = conn.execute(
            "INSERT INTO integrations "
            "(name, enabled, config_json, last_status, created_at, updated_at, "
            " schedule_enabled, schedule_interval_minutes, next_run_at) "
            "VALUES (?, ?, ?, 'never', ?, ?, ?, ?, ?)",
            (name, 1 if data.get('enabled', True) else 0, json.dumps(config), now, now,
             sched_enabled, interval, next_run)
        )
        conn.commit()
        new_id = cursor.lastrowid
    return jsonify({"id": new_id}), 201


@api_bp.route('/integrations/<int:integration_id>', methods=['GET'])
@api_admin_required
def get_integration(integration_id):
    with get_db_connection() as conn:
        row = conn.execute('SELECT * FROM integrations WHERE id = ?', (integration_id,)).fetchone()
    if not row:
        return jsonify({"error": "Não encontrada"}), 404
    return jsonify(_integration_row_to_dict(row))


@api_bp.route('/integrations/<int:integration_id>', methods=['PUT'])
@api_admin_required
def update_integration(integration_id):
    data = request.get_json(silent=True) or {}
    with get_db_connection() as conn:
        row = conn.execute(
            'SELECT config_json, schedule_interval_minutes FROM integrations WHERE id = ?',
            (integration_id,)
        ).fetchone()
        if not row:
            return jsonify({"error": "Não encontrada"}), 404
        try:
            old_cfg = json.loads(row['config_json'])
        except (ValueError, TypeError):
            old_cfg = {}

        fields, params = [], []
        if 'name' in data:
            name = str(data.get('name') or '').strip()
            if not name:
                return jsonify({"error": "Nome é obrigatório"}), 400
            fields.append('name = ?')
            params.append(name)
        if 'enabled' in data:
            fields.append('enabled = ?')
            params.append(1 if data.get('enabled') else 0)
        if 'schedule' in data:
            sched = data.get('schedule') or {}
            sched_enabled = 1 if sched.get('enabled') else 0
            interval = scheduler.clamp_interval(sched.get('interval_minutes'))
            if sched_enabled and not interval:
                return jsonify({"error": f"Intervalo mínimo é {scheduler.MIN_INTERVAL_MINUTES} minutos"}), 400
            fields.append('schedule_enabled = ?')
            params.append(sched_enabled)
            fields.append('schedule_interval_minutes = ?')
            params.append(interval)
            fields.append('next_run_at = ?')
            # Reagenda a partir de agora ao ligar/alterar; ao desligar, limpa.
            params.append(scheduler.compute_next_run(interval) if sched_enabled else None)
        if 'config' in data:
            new_cfg = data.get('config') or {}
            if not isinstance(new_cfg, dict):
                return jsonify({"error": "Config inválida"}), 400
            merged = integrations.merge_secrets(new_cfg, old_cfg)
            fields.append('config_json = ?')
            params.append(json.dumps(merged))

        if not fields:
            return jsonify({"success": True})

        fields.append('updated_at = ?')
        params.append(datetime.utcnow().isoformat())
        params.append(integration_id)
        conn.execute(f"UPDATE integrations SET {', '.join(fields)} WHERE id = ?", params)
        conn.commit()
    return jsonify({"success": True})


@api_bp.route('/integrations/<int:integration_id>', methods=['DELETE'])
@api_admin_required
def delete_integration(integration_id):
    with get_db_connection() as conn:
        conn.execute('DELETE FROM integration_items WHERE integration_id = ?', (integration_id,))
        conn.execute('DELETE FROM integrations WHERE id = ?', (integration_id,))
        conn.commit()
    return jsonify({"success": True})


@api_bp.route('/integrations/test', methods=['POST'])
@api_admin_required
def test_integration():
    """Faz o fetch e devolve arrays detectados + campos + item de exemplo."""
    data = request.get_json(silent=True) or {}
    connection = data.get('connection') or {}

    # Ao editar (id presente), restaura segredos mascarados a partir do salvo,
    # para que o teste use a credencial real (mesma lógica do /preview).
    if data.get('id'):
        with get_db_connection() as conn:
            row = conn.execute('SELECT config_json FROM integrations WHERE id = ?', (int(data['id']),)).fetchone()
        if row:
            try:
                old = json.loads(row['config_json'])
            except (ValueError, TypeError):
                old = {}
            merged = integrations.merge_secrets({'connection': connection}, old)
            connection = merged.get('connection') or connection

    try:
        payload = integrations.fetch_payload(connection)
    except IntegrationError as exc:
        return jsonify({"error": str(exc)}), 400

    items_path = data.get('items_path') or ''
    items = integrations.extract_items(payload, items_path)
    sample = items[0] if items else payload
    return jsonify({
        "arrays": integrations.detect_array_paths(payload),
        "fields": integrations.sample_fields(items[0]) if items else [],
        "sample_item": sample,
        "item_count": len(items),
    })


@api_bp.route('/integrations/preview', methods=['POST'])
@api_admin_required
def preview_integration():
    """Dry-run: retorna as tasks que seriam criadas, sem persistir."""
    data = request.get_json(silent=True) or {}
    config = data.get('config') or {}
    if not isinstance(config, dict):
        return jsonify({"error": "Config inválida"}), 400

    # Se veio um id, mescla os segredos mascarados com os já salvos.
    if data.get('id'):
        with get_db_connection() as conn:
            row = conn.execute('SELECT config_json FROM integrations WHERE id = ?', (int(data['id']),)).fetchone()
        if row:
            try:
                old = json.loads(row['config_json'])
            except (ValueError, TypeError):
                old = {}
            config = integrations.merge_secrets(config, old)

    try:
        result = integrations.run_config(config, dry_run=True)
    except IntegrationError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify(result)


@api_bp.route('/integrations/<int:integration_id>/run', methods=['POST'])
@api_admin_required
def run_integration_endpoint(integration_id):
    try:
        result = integrations.run_integration(integration_id, dry_run=False)
    except IntegrationError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify(result)


@api_bp.route('/integrations/<int:integration_id>/runs', methods=['GET'])
@api_admin_required
def integration_runs(integration_id):
    """Histórico de execuções da integração (mais recentes primeiro)."""
    with get_db_connection() as conn:
        row = conn.execute('SELECT id FROM integrations WHERE id = ?', (integration_id,)).fetchone()
    if not row:
        return jsonify({"error": "Não encontrada"}), 404
    try:
        limit = int(request.args.get('limit', 50))
    except (TypeError, ValueError):
        limit = 50
    return jsonify(integrations.list_runs(integration_id, limit=limit))


@api_bp.route('/integrations/<int:integration_id>/import', methods=['POST'])
@api_admin_required
def import_integration_items(integration_id):
    """Importação interativa: cria as tasks a partir das linhas editadas na prévia."""
    data = request.get_json(silent=True) or {}
    items = data.get('items')
    if not isinstance(items, list):
        return jsonify({"error": "Envie a lista de itens a importar."}), 400
    on_update = data.get('on_update') or 'skip'
    reimport_deleted = bool(data.get('reimport_deleted'))
    try:
        result = integrations.commit_items(integration_id, items, on_update=on_update,
                                           reimport_deleted=reimport_deleted)
    except IntegrationError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify(result)
