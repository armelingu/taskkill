import os
import socket
import threading
import time
import webbrowser

from waitress import serve

from app import app


def pick_free_port(host: str = "127.0.0.1") -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return int(s.getsockname()[1])


def open_browser_later(url: str, delay_s: float = 0.6) -> None:
    time.sleep(delay_s)
    try:
        webbrowser.open(url)
    except Exception:
        pass


if __name__ == "__main__":
    host = os.environ.get("TASKKILL_HOST", "127.0.0.1")
    port_env = os.environ.get("TASKKILL_PORT", "0").strip()
    port = int(port_env) if port_env.isdigit() else 0
    if port == 0:
        port = pick_free_port(host)

    threads = int(os.environ.get("TASKKILL_THREADS", "4"))
    url = f"http://{host}:{port}/"

    threading.Thread(target=open_browser_later, args=(url,), daemon=True).start()
    print(f"Taskkill (produto local) rodando em {url}", flush=True)

    serve(app, host=host, port=port, threads=threads)

