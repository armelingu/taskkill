"""
Servidor WSGI de produção para uso local (Windows/macOS/Linux).

Usa waitress porque é multiplataforma e estável — o gunicorn (usado no
Dockerfile) não roda no Windows. Para deploy em VPS/Docker, continue usando
o gunicorn definido no Dockerfile.

Uso:
    python serve.py

Variáveis de ambiente (opcionais):
    TASKKILL_HOST     (default 127.0.0.1)
    TASKKILL_PORT     (default 5091)
    TASKKILL_THREADS  (default 8)
"""

import os

from waitress import serve

from app import app  # importa também dispara init_db() (bootstrap do banco)


def main() -> None:
    host = os.environ.get('TASKKILL_HOST', '127.0.0.1')
    port = int(os.environ.get('TASKKILL_PORT', '5091'))
    threads = int(os.environ.get('TASKKILL_THREADS', '8'))

    print(f"Taskkill rodando em http://{host}:{port}  (waitress, {threads} threads)")
    print("Pressione Ctrl+C para encerrar.")
    serve(app, host=host, port=port, threads=threads)


if __name__ == '__main__':
    main()
