import os
import re
import importlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

os.environ.setdefault("TASKKILL_ADMIN_PASSWORD", "senha-super-forte-123")
os.environ.setdefault("TASKKILL_SECRET_KEY", "dev-secret")

import database

importlib.reload(database)
database.init_db()

from app import app


def main():
    c = app.test_client()

    r = c.get("/")
    print("GET / ->", r.status_code, r.headers.get("Location"))

    login = c.get("/login")
    print("GET /login ->", login.status_code)

    html = login.get_data(as_text=True)
    m = re.search(r'name="csrf_token" value="([^"]+)"', html)
    csrf = m.group(1) if m else ""
    assert csrf, "csrf_token not found in login form"

    resp = c.post("/login", data={"username": "admin", "password": os.environ["TASKKILL_ADMIN_PASSWORD"], "csrf_token": csrf})
    print("POST /login ->", resp.status_code, resp.headers.get("Location"))

    api = c.get("/api/tasks")
    print("GET /api/tasks ->", api.status_code)

    blocked = c.post("/api/tasks", json={"project": "Pessoal", "text": "Teste"})
    print("POST /api/tasks sem CSRF header ->", blocked.status_code)

    ok = c.post("/api/tasks", headers={"X-CSRF-Token": csrf}, json={"project": "Pessoal", "text": "Teste"})
    print("POST /api/tasks com CSRF header ->", ok.status_code)


if __name__ == "__main__":
    main()

