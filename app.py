import logging
import os
import secrets
import sys
from datetime import timedelta

from flask import Flask, request, jsonify, render_template
from werkzeug.middleware.proxy_fix import ProxyFix
from database import init_db
from routes import main_bp, api_bp

# Logging básico: garante que eventos de autenticação (taskkill.auth) e demais
# logs apareçam no stdout/stderr (capturados pelo gunicorn/waitress/Docker).
# basicConfig só instala handler se ainda não houver um configurado.
logging.basicConfig(
    level=os.environ.get('TASKKILL_LOG_LEVEL', 'INFO').upper(),
    format='%(asctime)s %(levelname)s %(name)s %(message)s',
)

def _load_dotenv_if_present() -> None:
    """
    Carrega variáveis de um arquivo .env local (se existir).
    - Não sobrescreve variáveis já definidas no ambiente (Docker/VPS).
    - Mantém o uso local simples (não precisa setar env toda vez).
    """
    env_path = os.path.join(os.path.dirname(__file__), '.env')
    if not os.path.exists(env_path):
        return

    try:
        with open(env_path, 'r', encoding='utf-8') as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith('#'):
                    continue
                if '=' not in line:
                    continue
                key, value = line.split('=', 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if not key:
                    continue
                os.environ.setdefault(key, value)
    except OSError:
        # Se não conseguir ler por permissão/lock, segue sem travar o app.
        return


_load_dotenv_if_present()

# Ponto de Partida Principal Minimalista
BASE_DIR = getattr(sys, "_MEIPASS", os.path.dirname(__file__))
app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, "templates"),
    static_folder=os.path.join(BASE_DIR, "static"),
    static_url_path="/static",
)

# SECRET_KEY: precisa ser ESTÁVEL e persistente. Se cada boot gerar uma chave
# nova, todas as sessões são invalidadas ao reiniciar (e, em multi-worker, cada
# processo assinaria com uma chave diferente). Por isso, em produção (atrás de
# proxy) a variável é obrigatória — falha cedo com mensagem clara. No uso local
# aceitamos uma chave efêmera, mas avisamos.
_secret_key = os.environ.get('TASKKILL_SECRET_KEY')
_behind_proxy = os.environ.get('TASKKILL_BEHIND_PROXY', '').strip() == '1'
if not _secret_key:
    if _behind_proxy:
        raise RuntimeError(
            "TASKKILL_SECRET_KEY é obrigatória em produção (TASKKILL_BEHIND_PROXY=1). "
            "Defina uma chave estável e secreta (ex.: python -c \"import secrets; "
            "print(secrets.token_hex(32))\") antes de subir o app."
        )
    _secret_key = secrets.token_urlsafe(32)
    print(
        "[Taskkill][AVISO] TASKKILL_SECRET_KEY não definida — usando chave efêmera. "
        "As sessões serão perdidas a cada reinício. Defina a variável para uso persistente.",
        file=sys.stderr,
    )
app.config['SECRET_KEY'] = _secret_key

# Recarrega templates do disco a cada render (sem isso, o Jinja mantém a versão
# compilada em memória e mudanças no HTML só aparecem após reiniciar o servidor).
# Custo é um stat() por render — irrelevante para o volume deste app.
app.config['TEMPLATES_AUTO_RELOAD'] = True
app.jinja_env.auto_reload = True

# Limite global de payload para evitar abuso/acidente (DoS local via request gigante).
# Precisa ser suficiente para upload de backup/restore do SQLite.
app.config['MAX_CONTENT_LENGTH'] = int(os.environ.get('TASKKILL_MAX_CONTENT_LENGTH', str(10 * 1024 * 1024)))

# Cookies de sessão (web)
cookie_secure_env = os.environ.get('TASKKILL_COOKIE_SECURE')
if cookie_secure_env is None:
    # Default seguro e pragmático:
    # - VPS atrás de proxy/HTTPS: true
    # - uso local (HTTP): false
    cookie_secure = _behind_proxy
else:
    cookie_secure = cookie_secure_env.strip() == '1'

# Aviso de misconfig: rodar atrás de proxy (HTTPS) mas com cookie não-secure faz
# o cookie de sessão trafegar sem a flag Secure — risco de sequestro em HTTP.
if _behind_proxy and not cookie_secure:
    print(
        "[Taskkill][AVISO] TASKKILL_BEHIND_PROXY=1 porém o cookie de sessão não é "
        "Secure. Defina TASKKILL_COOKIE_SECURE=1 para produção HTTPS.",
        file=sys.stderr,
    )

app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['SESSION_COOKIE_SECURE'] = cookie_secure
# Cookie com nome discreto (não revela a tecnologia). Em produção HTTPS usa o
# prefixo __Host- (o navegador só devolve o cookie via HTTPS, mesmo host e path
# raiz — blinda contra fixação via subdomínio/host).
app.config['SESSION_COOKIE_NAME'] = '__Host-tk_s' if cookie_secure else 'tk_s'
# Sessão permanente com expiração por inatividade (8h por padrão, configurável)
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(
    seconds=int(os.environ.get('TASKKILL_SESSION_LIFETIME_SECONDS', str(8 * 3600)))
)
app.config['SESSION_REFRESH_EACH_REQUEST'] = True

# Módulos ES são importados por caminho relativo (sem ?v=<mtime> nos sub-imports).
# Com max-age=0 o navegador revalida via ETag/Last-Modified (304 quando não muda),
# evitando servir um módulo velho após deploy. O entry (main.js) ainda usa asset().
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0

# Cache-busting de assets estáticos: gera /static/<arquivo>?v=<mtime>.
# Assim, ao editar CSS/JS, a URL muda e o navegador baixa a versão nova
# (evita o clássico "recarreguei e continua o JS antigo em cache").
@app.context_processor
def inject_asset_helper():
    def asset(filename):
        try:
            full = os.path.join(app.static_folder, filename)
            version = int(os.path.getmtime(full))
        except OSError:
            version = 0
        return f"{app.static_url_path}/{filename}?v={version}"
    return {'asset': asset}


# Configurações Iniciais de Banco (Tabela, SQLite)
init_db()

# Registrando módulos separados que criamos (Nossas "Mini Aplicações")
app.register_blueprint(main_bp)
app.register_blueprint(api_bp)

# Agendador de integrações (thread daemon). Em modo debug com reloader, só
# inicia no processo filho (WERKZEUG_RUN_MAIN) para não rodar em duplicidade.
from scheduler import start_scheduler  # noqa: E402
_debug_mode = os.environ.get('TASKKILL_DEBUG', '').strip() == '1'
if not (_debug_mode and os.environ.get('WERKZEUG_RUN_MAIN') != 'true'):
    start_scheduler()

# Quando rodar atrás de proxy (Caddy/Nginx), isso corrige request.is_secure e host/proto.
if os.environ.get('TASKKILL_BEHIND_PROXY', '').strip() == '1':
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# ===================================================================
# MIDDLEWARE DE SEGURANÇA MÁXIMA (Defense in Depth)
# ===================================================================
@app.after_request
def add_security_headers(response):
    # Documentos HTML nunca devem ser cacheados: garante que mudanças na
    # estrutura da página apareçam sempre no reload (os assets CSS/JS têm
    # cache-busting via ?v=<mtime>, então podem ser cacheados normalmente).
    if response.mimetype == 'text/html':
        response.headers['Cache-Control'] = 'no-store'
    # Força navegadores a só usar HTTPS (somente faz sentido quando a requisição é HTTPS)
    if request.is_secure:
        response.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
    # Evita que navegadores tentem "adivinhar" o tipo de um arquivo (previne mime-sniffing)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    # Proíbe que o seu sistema seja embutido num iFrame malicioso de terceiros (Clickjacking)
    response.headers['X-Frame-Options'] = 'SAMEORIGIN'
    # Evita vazamento de URL/paths em navegações externas
    response.headers['Referrer-Policy'] = 'no-referrer'
    # Restringe APIs do browser que não são necessárias
    response.headers['Permissions-Policy'] = (
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), "
        "serial=(), bluetooth=(), magnetometer=(), gyroscope=(), accelerometer=()"
    )
    # Isola o contexto de navegação (mitiga algumas classes de ataque por janela/aba)
    response.headers['Cross-Origin-Opener-Policy'] = 'same-origin'
    # Impede que outros sites usem seus recursos como “subresource” de forma relaxada
    response.headers['Cross-Origin-Resource-Policy'] = 'same-origin'
    # Content Security Policy (CSP): Uma lista branca bloqueando execução de código não autorizado
    # Permite Google Fonts, e restringe JS apenas aos seus arquivos locais.
    csp = (
        "default-src 'self'; "
        "base-uri 'none'; "
        "form-action 'self'; "
        "frame-ancestors 'none'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "script-src 'self'; "
        "connect-src 'self'; "
        "object-src 'none';"
    )
    response.headers['Content-Security-Policy'] = csp
    # Esconde a tecnologia do servidor por motivos de segurança
    response.headers['Server'] = 'Taskkill-Core'
    return response


# ===================================================================
# PÁGINAS DE ERRO CUSTOMIZADAS
# ===================================================================
# As respostas padrão do Werkzeug ("The requested URL was not found...")
# revelam que o backend é Flask/Python, facilitando fingerprinting. Aqui
# devolvemos páginas próprias (HTML branded para o app; JSON limpo para a API).
def _wants_json() -> bool:
    return request.path.startswith('/api/')


def _error_response(code: int, message: str):
    if _wants_json():
        return jsonify({"error": message}), code
    return render_template('error.html', code=code, message=message), code


@app.errorhandler(403)
def _err_403(e):
    return _error_response(403, 'Acesso negado.')


@app.errorhandler(404)
def _err_404(e):
    return _error_response(404, 'Página não encontrada.')


@app.errorhandler(405)
def _err_405(e):
    return _error_response(405, 'Método não permitido.')


@app.errorhandler(500)
def _err_500(e):
    # Nunca expõe stack trace/detalhes ao cliente (debug fica desligado em prod).
    return _error_response(500, 'Ocorreu um erro interno. Tente novamente.')


if __name__ == '__main__':
    # Modo dev local (não use em distribuição/mercado).
    # Para “produto”, vamos rodar via waitress (arquivo separado) e sempre em 127.0.0.1.
    debug = os.environ.get('TASKKILL_DEBUG', '').strip() == '1'
    host = os.environ.get('TASKKILL_HOST', '127.0.0.1')
    port = int(os.environ.get('TASKKILL_PORT', '5091'))
    app.run(debug=debug, host=host, port=port, use_reloader=debug)
