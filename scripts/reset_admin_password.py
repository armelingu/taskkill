import os
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

from werkzeug.security import generate_password_hash


def load_dotenv_if_present(project_root: Path) -> None:
    env_path = project_root / ".env"
    if not env_path.exists():
        return

    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            os.environ.setdefault(key, value)


def main() -> int:
    project_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(project_root))

    load_dotenv_if_present(project_root)

    import database  # noqa: E402

    # garante schema (inclui users)
    database.init_db()

    username = (os.environ.get("TASKKILL_ADMIN_USER") or "admin").strip()
    password = os.environ.get("TASKKILL_ADMIN_PASSWORD") or ""
    password = password.strip()
    if len(password) < 10:
        print("ERRO: TASKKILL_ADMIN_PASSWORD precisa ter pelo menos 10 caracteres.")
        print(f"Comprimento atual: {len(password)}")
        return 2

    db_path = database.get_db_path()
    conn = sqlite3.connect(db_path)
    try:
        conn.row_factory = sqlite3.Row
        pw_hash = generate_password_hash(password)

        row = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
        if row:
            conn.execute(
                "UPDATE users SET password_hash = ?, is_admin = 1 WHERE id = ?",
                (pw_hash, int(row["id"])),
            )
        else:
            conn.execute(
                "INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, 1, ?)",
                (username, pw_hash, datetime.utcnow().isoformat()),
            )

        conn.commit()
    finally:
        conn.close()

    print("OK: senha do admin atualizada.")
    print(f"- usuário: {username}")
    print("- reinicie o servidor e faça login em /login")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

