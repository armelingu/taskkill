"""Testes de autenticação: login, rate-limit, CSRF e sessão."""

from conftest import _login, _csrf_of, ADMIN_USER, ADMIN_PASSWORD

import database


def test_login_page_ok(client):
    resp = client.get('/login')
    assert resp.status_code == 200


def test_login_success_redirects(client):
    resp = _login(client)
    assert resp.status_code == 302
    assert resp.headers['Location'].endswith('/')
    # Após logar, a home responde 200.
    home = client.get('/')
    assert home.status_code == 200


def test_login_wrong_password_401(client):
    client.get('/login')
    token = _csrf_of(client)
    resp = client.post('/login', data={
        'username': ADMIN_USER, 'password': 'senha-errada-xyz', 'csrf_token': token,
    })
    assert resp.status_code == 401
    assert 'Credenciais inválidas' in resp.get_data(as_text=True)


def test_login_missing_csrf_400(client):
    client.get('/login')
    resp = client.post('/login', data={'username': ADMIN_USER, 'password': ADMIN_PASSWORD})
    assert resp.status_code == 400


def test_ip_lockout_after_max_attempts(client):
    client.get('/login')
    token = _csrf_of(client)
    statuses = []
    for _ in range(6):
        r = client.post('/login', data={
            'username': ADMIN_USER, 'password': 'errada', 'csrf_token': token,
        })
        statuses.append(r.status_code)
    # Em algum momento (<=5 tentativas) o IP é bloqueado -> 429 com Retry-After.
    assert 429 in statuses
    r = client.post('/login', data={
        'username': ADMIN_USER, 'password': 'errada', 'csrf_token': token,
    })
    assert r.status_code == 429
    assert 'Retry-After' in r.headers


def test_user_lockout_across_ips(client):
    # IP diferente a cada tentativa isola o eixo por IP; o lockout por conta
    # (10 tentativas) é quem deve disparar.
    client.get('/login')
    token = _csrf_of(client)
    got_429 = False
    for i in range(11):
        r = client.post(
            '/login',
            data={'username': ADMIN_USER, 'password': 'errada', 'csrf_token': token},
            environ_base={'REMOTE_ADDR': f'203.0.113.{i}'},
        )
        if r.status_code == 429:
            got_429 = True
            break
    assert got_429


def test_api_requires_auth(client):
    resp = client.get('/api/tasks')
    assert resp.status_code == 401


def test_api_csrf_required_for_mutations(auth_client):
    # Sem header X-CSRF-Token -> 403.
    resp = auth_client.post('/api/projects', json={'name': 'NovoProj'})
    assert resp.status_code == 403
    # Com o header correto -> sucesso.
    resp = auth_client.post('/api/projects', json={'name': 'NovoProj'},
                            headers={'X-CSRF-Token': auth_client.csrf})
    assert resp.status_code in (200, 201)


def test_session_version_invalidation(auth_client):
    # Autenticado: /api/profile responde 200.
    assert auth_client.get('/api/profile').status_code == 200
    # Simula "sair de todos os dispositivos": incrementa session_version no banco.
    with database.get_db_connection() as conn:
        conn.execute("UPDATE users SET session_version = session_version + 1 "
                     "WHERE username = ?", (ADMIN_USER,))
        conn.commit()
    # O cookie antigo (sv desatualizado) deixa de valer.
    assert auth_client.get('/api/profile').status_code == 401
