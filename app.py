import os
import secrets
import sys

from flask import Flask, request
from werkzeug.middleware.proxy_fix import ProxyFix
from database import init_db
from routes import main_bp, api_bp

# Ponto de Partida Principal Minimalista
BASE_DIR = getattr(sys, "_MEIPASS", os.path.dirname(__file__))
app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, "templates"),
    static_folder=os.path.join(BASE_DIR, "static"),
    static_url_path="/static",
)

app.config['SECRET_KEY'] = os.environ.get('TASKKILL_SECRET_KEY') or secrets.token_urlsafe(32)

# Limite global de payload para evitar abuso/acidente (DoS local via request gigante).
# Precisa ser suficiente para upload de backup/restore do SQLite.
app.config['MAX_CONTENT_LENGTH'] = int(os.environ.get('TASKKILL_MAX_CONTENT_LENGTH', str(10 * 1024 * 1024)))

# Cookies de sessão (web)
cookie_secure = os.environ.get('TASKKILL_COOKIE_SECURE', '').strip() == '1'
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['SESSION_COOKIE_SECURE'] = cookie_secure

# Configurações Iniciais de Banco (Tabela, SQLite)
init_db()

# Registrando módulos separados que criamos (Nossas "Mini Aplicações")
app.register_blueprint(main_bp)
app.register_blueprint(api_bp)

# Quando rodar atrás de proxy (Caddy/Nginx), isso corrige request.is_secure e host/proto.
if os.environ.get('TASKKILL_BEHIND_PROXY', '').strip() == '1':
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# ===================================================================
# MIDDLEWARE DE SEGURANÇA MÁXIMA (Defense in Depth)
# ===================================================================
@app.after_request
def add_security_headers(response):
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
    csp = "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; object-src 'none';"
    response.headers['Content-Security-Policy'] = csp
    # Esconde a tecnologia do servidor por motivos de segurança
    response.headers['Server'] = 'Taskkill-Core'
    return response

if __name__ == '__main__':
    # Modo dev local (não use em distribuição/mercado).
    # Para “produto”, vamos rodar via waitress (arquivo separado) e sempre em 127.0.0.1.
    debug = os.environ.get('TASKKILL_DEBUG', '').strip() == '1'
    host = os.environ.get('TASKKILL_HOST', '127.0.0.1')
    port = int(os.environ.get('TASKKILL_PORT', '5091'))
    app.run(debug=debug, host=host, port=port, use_reloader=debug)
