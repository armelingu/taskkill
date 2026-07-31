"""
Auto-cadastro (/register): criação de conta, login automático, validações
(senha, confirmação, duplicidade, CSRF) e rate-limit por IP.
"""

import uuid


def _csrf(client):
    with client.session_transaction() as sess:
        return sess.get('csrf_token')


def _register(client, username, password, confirm=None, csrf=None):
    client.get('/register')
    token = csrf if csrf is not None else _csrf(client)
    return client.post('/register', data={
        'username': username,
        'password': password,
        'confirm_password': confirm if confirm is not None else password,
        'csrf_token': token,
    })


def _u(prefix='novo'):
    return f'{prefix}-{uuid.uuid4().hex[:8]}'


def test_register_page_renders(client):
    r = client.get('/register')
    assert r.status_code == 200
    assert b'Criar conta' in r.data


def test_register_creates_and_logs_in_with_empty_workspace(client):
    r = _register(client, _u(), 'senha-bem-longa-123')
    assert r.status_code == 302

    # Sessão já autenticada: novo usuário começa sem tarefas nem projetos.
    tasks = client.get('/api/tasks')
    assert tasks.status_code == 200
    assert tasks.get_json() == {}
    assert client.get('/api/projects').get_json() == []


def test_register_duplicate_username(client):
    # 'admin' é criado no boot dos testes
    r = _register(client, 'admin', 'senha-bem-longa-123')
    assert r.status_code == 409


def test_register_weak_password(client):
    r = _register(client, _u('weak'), 'curta')
    assert r.status_code == 400


def test_register_password_mismatch(client):
    r = _register(client, _u('mism'), 'senha-bem-longa-123', confirm='outra-senha-456')
    assert r.status_code == 400


def test_register_bad_csrf(client):
    r = _register(client, _u('csrf'), 'senha-bem-longa-123', csrf='token-invalido')
    assert r.status_code == 400


def test_register_already_logged_in_redirects(auth_client):
    # Logado como admin: GET /register redireciona pro app
    r = auth_client.get('/register')
    assert r.status_code == 302


def test_register_rate_limited_por_ip(flask_app):
    import routes
    routes._register_attempts.clear()

    for _ in range(routes._REGISTER_MAX_ATTEMPTS):
        c = flask_app.test_client()
        r = _register(c, _u('rl'), 'senha-bem-longa-123')
        assert r.status_code == 302

    # Excedeu o limite de contas por IP -> 429
    c = flask_app.test_client()
    r = _register(c, _u('rl'), 'senha-bem-longa-123')
    assert r.status_code == 429
    routes._register_attempts.clear()
