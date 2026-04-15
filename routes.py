import io
import os
import shutil
import sqlite3
import tempfile
import threading
from datetime import date, datetime, timedelta

from functools import wraps

from flask import Blueprint, render_template, request, jsonify, send_file, session, redirect, url_for, abort

from database import get_db_connection, get_db_path, init_db
from werkzeug.security import check_password_hash, generate_password_hash

# ---------------------------------------------------------------------------
# Rate-limit de login (in-memory, por IP)
# ---------------------------------------------------------------------------
_LOGIN_MAX_ATTEMPTS  = int(os.environ.get('LOGIN_MAX_ATTEMPTS', '5'))
_LOGIN_LOCKOUT_SECS  = int(os.environ.get('LOGIN_LOCKOUT_SECONDS', '900'))  # 15 min
_login_attempts: dict = {}   # { ip: {'count': int, 'locked_until': datetime | None} }
_login_lock = threading.Lock()


def _get_client_ip() -> str:
    return request.headers.get('X-Forwarded-For', request.remote_addr or '').split(',')[0].strip()


def _is_ip_locked(ip: str) -> tuple[bool, int]:
    """Retorna (bloqueado, segundos_restantes)."""
    with _login_lock:
        entry = _login_attempts.get(ip)
        if not entry:
            return False, 0
        locked_until = entry.get('locked_until')
        if locked_until and datetime.utcnow() < locked_until:
            remaining = int((locked_until - datetime.utcnow()).total_seconds())
            return True, remaining
        return False, 0


def _record_failed_login(ip: str) -> int:
    """Registra tentativa falha. Retorna contagem atual."""
    with _login_lock:
        entry = _login_attempts.setdefault(ip, {'count': 0, 'locked_until': None})
        # Reseta o lock expirado antes de incrementar
        if entry.get('locked_until') and datetime.utcnow() >= entry['locked_until']:
            entry['count'] = 0
            entry['locked_until'] = None
        entry['count'] += 1
        if entry['count'] >= _LOGIN_MAX_ATTEMPTS:
            entry['locked_until'] = datetime.utcnow() + timedelta(seconds=_LOGIN_LOCKOUT_SECS)
        return int(entry['count'])


def _reset_login_attempts(ip: str) -> None:
    with _login_lock:
        _login_attempts.pop(ip, None)

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
        row = conn.execute('SELECT id, username, is_admin FROM users WHERE id = ?', (int(uid),)).fetchone()
        return dict(row) if row else None


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get('user_id'):
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
    # Bloqueia API sem sessão
    if not session.get('user_id'):
        return jsonify({"error": "Unauthorized"}), 401

    # CSRF para métodos mutáveis
    if request.method in ('POST', 'PUT', 'DELETE'):
        expected = session.get('csrf_token')
        got = request.headers.get('X-CSRF-Token')
        if not expected or got != expected:
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
        # Rate-limit: verifica bloqueio antes de qualquer processamento
        locked, remaining = _is_ip_locked(ip)
        if locked:
            mins = (remaining // 60) + 1
            error = f'Muitas tentativas. Tente novamente em {mins} minuto(s).'
            return render_template('login.html', error=error, csrf_token=csrf), 429

        form_csrf = request.form.get('csrf_token')
        if not form_csrf or form_csrf != csrf:
            return render_template('login.html', error='Sessão expirada. Recarregue e tente novamente.', csrf_token=csrf), 400

        username = (request.form.get('username') or '').strip()
        password = (request.form.get('password') or '')
        if not username or not password:
            return render_template('login.html', error='Usuário e senha são obrigatórios.', csrf_token=csrf), 400

        with get_db_connection() as conn:
            row = conn.execute('SELECT id, username, password_hash, is_admin FROM users WHERE username = ?', (username,)).fetchone()
            if not row or not check_password_hash(row['password_hash'], password):
                count = _record_failed_login(ip)
                remaining_attempts = max(0, _LOGIN_MAX_ATTEMPTS - count)
                if remaining_attempts == 0:
                    error = f'Muitas tentativas. Conta bloqueada por {_LOGIN_LOCKOUT_SECS // 60} minuto(s).'
                else:
                    error = f'Credenciais inválidas. Tentativas restantes: {remaining_attempts}.'
                return render_template('login.html', error=error, csrf_token=csrf), 401

        # Login bem-sucedido: reseta contador e regenera sessão (previne session fixation)
        _reset_login_attempts(ip)
        session.clear()                       # descarta sessão anterior (novo ID gerado pelo Flask)
        session.permanent = True              # ativa expiração por PERMANENT_SESSION_LIFETIME
        session['user_id']  = int(row['id'])
        session['is_admin'] = int(row['is_admin'])
        _ensure_csrf_token()                  # gera novo CSRF token na sessão limpa
        return redirect(url_for('main.index'))

    return render_template('login.html', csrf_token=csrf)


@main_bp.route('/logout', methods=['POST'])
def logout():
    csrf = session.get('csrf_token')
    form_csrf = request.form.get('csrf_token')
    if not csrf or not form_csrf or form_csrf != csrf:
        abort(403)
    session.clear()
    return redirect(url_for('main.login'))


@main_bp.route('/perfil', methods=['GET', 'POST'])
@login_required
def perfil():
    user = _current_user()
    csrf = _ensure_csrf_token()
    message = None
    error = None
    section = request.args.get('s', 'usuario')  # 'senha' | 'usuario' | 'sistema'

    if request.method == 'POST':
        form_csrf = request.form.get('csrf_token')
        if not form_csrf or form_csrf != csrf:
            error = 'Sessão expirada. Recarregue e tente novamente.'
        else:
            action = request.form.get('action')

            if action == 'senha':
                section = 'senha'
                current_pw  = request.form.get('current_password') or ''
                new_pw      = request.form.get('new_password') or ''
                confirm_pw  = request.form.get('confirm_password') or ''

                if len(new_pw.strip()) < 10:
                    error = 'A nova senha precisa ter pelo menos 10 caracteres.'
                elif new_pw != confirm_pw:
                    error = 'A confirmação da senha não confere.'
                else:
                    with get_db_connection() as conn:
                        row = conn.execute('SELECT password_hash FROM users WHERE id = ?', (int(user['id']),)).fetchone()
                        if not row or not check_password_hash(row['password_hash'], current_pw):
                            error = 'Senha atual incorreta.'
                        else:
                            conn.execute('UPDATE users SET password_hash = ? WHERE id = ?',
                                         (generate_password_hash(new_pw.strip()), int(user['id'])))
                            conn.commit()
                            message = 'Senha atualizada com sucesso.'

            elif action == 'usuario':
                section = 'usuario'
                new_username = (request.form.get('new_username') or '').strip()
                confirm_pw   = request.form.get('confirm_password_u') or ''

                if not new_username:
                    error = 'O nome de usuário não pode ser vazio.'
                elif len(new_username) > 60:
                    error = 'Nome de usuário muito longo (máx. 60 caracteres).'
                else:
                    with get_db_connection() as conn:
                        row = conn.execute('SELECT password_hash FROM users WHERE id = ?', (int(user['id']),)).fetchone()
                        if not row or not check_password_hash(row['password_hash'], confirm_pw):
                            error = 'Senha incorreta.'
                        else:
                            exists = conn.execute('SELECT id FROM users WHERE username = ? AND id != ?',
                                                  (new_username, int(user['id']))).fetchone()
                            if exists:
                                error = 'Esse nome de usuário já está em uso.'
                            else:
                                conn.execute('UPDATE users SET username = ? WHERE id = ?',
                                             (new_username, int(user['id'])))
                                conn.commit()
                                message = f'Usuário atualizado para "{new_username}".'

    if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
        if error:
            return jsonify({'error': error}), 400
        return jsonify({'message': message, 'user': _current_user()})

    return render_template('perfil.html', user=_current_user(), csrf_token=csrf,
                           message=message, error=error, section=section)


@main_bp.route('/admin')
@login_required
def admin():
    return redirect(url_for('main.perfil'))


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
