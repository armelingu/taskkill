"""
Configuração compartilhada dos testes (pytest).

Pontos importantes:
- As variáveis de ambiente são definidas ANTES de importar o app, para que o
  banco de teste (TASKKILL_DB_PATH temporário) e o admin de teste sejam usados,
  sem tocar no banco real. app.py roda init_db() no import.
- TASKKILL_DEBUG=1 impede o scheduler de integrações de subir uma thread durante
  os testes (ver app.py: só inicia se não estiver em debug sem WERKZEUG_RUN_MAIN).
"""

import os
import tempfile

# --- Ambiente de teste (definir ANTES de importar o app) -------------------
_TMP_DIR = tempfile.mkdtemp(prefix='taskkill-test-')
os.environ['TASKKILL_DB_PATH'] = os.path.join(_TMP_DIR, 'test.db')
os.environ['TASKKILL_SECRET_KEY'] = 'test-secret-key-not-for-production'
os.environ['TASKKILL_ADMIN_USER'] = 'admin'
os.environ['TASKKILL_ADMIN_PASSWORD'] = 'test-admin-pass-123'
os.environ['TASKKILL_DEBUG'] = '1'          # evita subir o scheduler nos testes
os.environ.pop('TASKKILL_BEHIND_PROXY', None)

import pytest  # noqa: E402

ADMIN_USER = os.environ['TASKKILL_ADMIN_USER']
ADMIN_PASSWORD = os.environ['TASKKILL_ADMIN_PASSWORD']


@pytest.fixture(scope='session')
def flask_app():
    """App Flask único para a sessão de testes (init_db já rodou no import)."""
    import app as app_module
    app_module.app.config.update(TESTING=True)
    return app_module.app


@pytest.fixture()
def client(flask_app):
    return flask_app.test_client()


@pytest.fixture(autouse=True)
def _reset_rate_limits():
    """
    Zera os contadores de rate-limit (in-memory) entre testes, senão um teste de
    lockout contamina os seguintes.
    """
    import routes
    routes._login_attempts.clear()
    routes._user_attempts.clear()
    yield
    routes._login_attempts.clear()
    routes._user_attempts.clear()


def _login(client, username=ADMIN_USER, password=ADMIN_PASSWORD, ip='127.0.0.1'):
    """Faz login no client de teste e devolve a resposta do POST."""
    client.get('/login', environ_base={'REMOTE_ADDR': ip})
    with client.session_transaction() as sess:
        token = sess.get('csrf_token')
    return client.post(
        '/login',
        data={'username': username, 'password': password, 'csrf_token': token},
        environ_base={'REMOTE_ADDR': ip},
    )


def _csrf_of(client):
    """Lê o token CSRF atual da sessão do client (para chamadas de API)."""
    with client.session_transaction() as sess:
        return sess.get('csrf_token')


@pytest.fixture()
def auth_client(client):
    """Client já autenticado como admin, com helper .csrf disponível."""
    _login(client)
    client.csrf = _csrf_of(client)
    return client
