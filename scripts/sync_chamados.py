import os
import sys
import time
import traceback
from datetime import date, datetime

import pymysql

from pathlib import Path

# Permite rodar o script de qualquer diretório (ex.: dentro de scripts/)
PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

import database


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


load_dotenv_if_present(PROJECT_ROOT)


def env_int(name: str, default: int) -> int:
    v = os.environ.get(name)
    if v is None or str(v).strip() == "":
        return default
    try:
        return int(str(v).strip())
    except ValueError:
        return default


def env_str(name: str, default: str = "") -> str:
    v = os.environ.get(name)
    if v is None:
        return default
    return str(v)


def connect_mysql():
    host = env_str("CHAMADOS_MYSQL_HOST")
    user = env_str("CHAMADOS_MYSQL_USER")
    password = env_str("CHAMADOS_MYSQL_PASSWORD")
    dbname = env_str("CHAMADOS_MYSQL_DB")
    port = env_int("CHAMADOS_MYSQL_PORT", 3306)

    if not host or not user or not password or not dbname:
        raise RuntimeError("Variáveis CHAMADOS_MYSQL_* incompletas (HOST/USER/PASSWORD/DB).")

    return pymysql.connect(
        host=host,
        user=user,
        password=password,
        database=dbname,
        port=port,
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
        read_timeout=10,
        write_timeout=10,
        connect_timeout=10,
        autocommit=True,
    )


def fetch_tickets(conn, agente_id: str, limit: int):
    # Query alinhada com o select atualizado (com nomes via JOIN).
    sql = """
        SELECT 
            c.numero_fila,
            c.solicitante_id,
            c.titulo,
            c.prioridade,
            u_agente.nome AS nome_agente,
            u_solicitante.nome AS nome_solicitante
        FROM chamados c
        JOIN usuarios u_agente 
            ON c.agente_id = u_agente.id
        JOIN usuarios u_solicitante 
            ON c.solicitante_id = u_solicitante.id
        WHERE c.agente_id = %s
        ORDER BY c.numero_fila DESC
        LIMIT %s
    """
    with conn.cursor() as cur:
        cur.execute(sql, (agente_id, limit))
        return cur.fetchall()


def already_synced(conn_sqlite, numero_fila: str) -> bool:
    row = conn_sqlite.execute(
        "SELECT 1 FROM chamados_sync WHERE ticket_numero_fila = ? AND task_id IS NOT NULL",
        (str(numero_fila),),
    ).fetchone()
    return bool(row)


def create_task_for_ticket(
    conn_sqlite,
    numero_fila: str,
    titulo: str,
    prioridade: str | int | None,
    nome_solicitante: str | None,
):
    project = "Protheus"
    today_str = date.today().strftime("%d/%m/%Y")

    titulo = (titulo or "").strip()
    nome_solicitante = (nome_solicitante or "").strip()
    prioridade_txt = "" if prioridade is None else str(prioridade).strip()

    ti = f"TI-{numero_fila}".strip()
    base_parts = [ti]
    if titulo:
        base_parts.append(titulo)
    base = " — ".join([p for p in base_parts if p]).strip()
    parts = [base]
    if prioridade_txt:
        parts.append(f"Prioridade: {prioridade_txt}")
    if nome_solicitante:
        parts.append(f"Solicitante: {nome_solicitante}")
    text = " — ".join([p for p in parts if p])

    # Respeita o limite do sistema
    text = text[:1000]

    cur = conn_sqlite.cursor()
    cur.execute(
        "SELECT COALESCE(MAX(position), -1) AS max_pos FROM tasks WHERE project = ? AND deleted = 0",
        (project,),
    )
    row = cur.fetchone()
    max_pos = row["max_pos"] if row and row["max_pos"] is not None else -1
    new_pos = int(max_pos) + 1

    cur.execute(
        "INSERT INTO tasks (project, text, completed, created_date, due_date, position, deleted) VALUES (?, ?, 0, ?, ?, ?, 0)",
        (project, text, today_str, None, new_pos),
    )
    return int(cur.lastrowid)


def try_claim_ticket(conn_sqlite, numero_fila: str) -> bool:
    """
    Reserva o ticket no SQLite para evitar duplicação, mesmo com múltiplos processos.
    Retorna True se este processo "ganhou" o direito de criar a task.
    """
    cur = conn_sqlite.cursor()
    cur.execute(
        "INSERT OR IGNORE INTO chamados_sync (ticket_numero_fila, task_id, created_at) VALUES (?, NULL, ?)",
        (str(numero_fila), datetime.utcnow().isoformat()),
    )
    return int(cur.rowcount or 0) == 1


def mark_task_id(conn_sqlite, numero_fila: str, task_id: int):
    conn_sqlite.execute(
        "UPDATE chamados_sync SET task_id = ? WHERE ticket_numero_fila = ?",
        (int(task_id), str(numero_fila)),
    )


def run_once():
    agente_id = env_str("CHAMADOS_AGENT_ID", "228")
    limit = env_int("CHAMADOS_FETCH_LIMIT", 200)

    mysql = connect_mysql()
    try:
        tickets = fetch_tickets(mysql, agente_id=agente_id, limit=limit)
    finally:
        try:
            mysql.close()
        except Exception:
            pass

    created = 0
    skipped = 0

    # garante schema (fora de qualquer transação/conn já aberta)
    database.init_db()

    with database.get_db_connection() as sqlite_conn:
        sqlite_conn.execute("BEGIN")
        for t in tickets:
            numero = str(t.get("numero_fila", "")).strip()
            if not numero:
                continue
            if already_synced(sqlite_conn, numero) or not try_claim_ticket(sqlite_conn, numero):
                skipped += 1
                continue

            task_id = create_task_for_ticket(
                sqlite_conn,
                numero_fila=numero,
                titulo=t.get("titulo") or "",
                prioridade=t.get("prioridade"),
                nome_solicitante=t.get("nome_solicitante"),
            )
            mark_task_id(sqlite_conn, numero, task_id)
            created += 1

        sqlite_conn.commit()

    return created, skipped


def main():
    enabled = env_str("CHAMADOS_SYNC_ENABLED", "0").strip() == "1"
    if not enabled:
        print("CHAMADOS_SYNC_ENABLED != 1. Sync desligado.")
        return

    interval = env_int("CHAMADOS_POLL_SECONDS", 45)
    print(f"Sync chamados ligado. Intervalo: {interval}s")

    while True:
        try:
            created, skipped = run_once()
            if created:
                print(f"[sync] criadas: {created} | já existentes: {skipped}")
        except Exception as e:
            print("[sync] erro:", str(e))
            traceback.print_exc()
        time.sleep(max(10, interval))


if __name__ == "__main__":
    main()

