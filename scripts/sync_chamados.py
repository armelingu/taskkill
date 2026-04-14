import os
import sys
import time
import traceback
from datetime import date, datetime, timezone

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


_WEEKDAY_TO_DUE: dict[int, str] = {
    0: "Segunda",
    1: "Terça",
    2: "Quarta",
    3: "Quinta",
    4: "Sexta",
    # Sábado (5) e Domingo (6) sem mapeamento — campo fica None
}


def _due_date_from_abertura(data_abertura) -> str | None:
    """Converte data_abertura (date, datetime ou str ISO) no dia da semana do sistema."""
    if data_abertura is None:
        return None
    if isinstance(data_abertura, str):
        try:
            data_abertura = date.fromisoformat(data_abertura[:10])
        except ValueError:
            return None
    if isinstance(data_abertura, datetime):
        data_abertura = data_abertura.date()
    if not isinstance(data_abertura, date):
        return None
    return _WEEKDAY_TO_DUE.get(data_abertura.weekday())


def fetch_tickets(conn, agente_id: str, limit: int):
    # Query alinhada com o select atualizado (com nomes via JOIN e data de abertura).
    sql = """
        SELECT 
            c.numero_fila,
            c.solicitante_id,
            c.titulo,
            c.prioridade,
            c.status,
            c.data_abertura,
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


def get_task_id_for_ticket(conn_sqlite, numero_fila: str) -> int | None:
    row = conn_sqlite.execute(
        "SELECT task_id FROM chamados_sync WHERE ticket_numero_fila = ?",
        (str(numero_fila),),
    ).fetchone()
    if not row:
        return None
    v = row["task_id"]
    return None if v is None else int(v)


def _norm_status(status: str | None) -> str:
    if status is None:
        return ""
    return str(status).strip().upper()


def is_closed_status(status: str | None) -> bool:
    s = _norm_status(status)
    return s in {"FECHADO", "RESOLVIDO", "CANCELADO", "FINALIZADO"}


def create_task_for_ticket(
    conn_sqlite,
    numero_fila: str,
    titulo: str,
    prioridade: str | int | None,
    status: str | None,
    nome_solicitante: str | None,
    data_abertura=None,
):
    project = "Protheus"
    # Usa data_abertura como data da task para vincular corretamente no grafo.
    # Fallback para hoje apenas se data_abertura for nulo/inválido.
    if data_abertura is not None:
        try:
            if isinstance(data_abertura, str):
                abertura_date = date.fromisoformat(data_abertura[:10])
            else:
                abertura_date = date(data_abertura.year, data_abertura.month, data_abertura.day)
            created_str = abertura_date.strftime("%d/%m/%Y")
        except (ValueError, AttributeError):
            created_str = date.today().strftime("%d/%m/%Y")
    else:
        created_str = date.today().strftime("%d/%m/%Y")
    due_date = _due_date_from_abertura(data_abertura)  # dia da semana em que foi aberto

    titulo = (titulo or "").strip()
    nome_solicitante = (nome_solicitante or "").strip()
    prioridade_txt = "" if prioridade is None else str(prioridade).strip()
    status_txt = (status or "").strip()

    # `numero_fila` já vem com o prefixo do sistema de chamados (ex.: TI-0673/2026).
    # Não adicionamos prefixo fixo para evitar duplicar.
    ticket_key = str(numero_fila).strip()
    base_parts = [ticket_key]
    if titulo:
        base_parts.append(titulo)
    base = " — ".join([p for p in base_parts if p]).strip()
    parts = [base]
    if prioridade_txt:
        parts.append(f"Prioridade: {prioridade_txt}")
    if status_txt:
        parts.append(f"Status: {status_txt}")
    if nome_solicitante:
        parts.append(f"Solicitante: {nome_solicitante}")
    text = " — ".join([p for p in parts if p])

    # Respeita o limite do sistema
    text = text[:1000]

    completed = 1 if is_closed_status(status_txt) else 0

    cur = conn_sqlite.cursor()
    cur.execute(
        "SELECT COALESCE(MAX(position), -1) AS max_pos FROM tasks WHERE project = ? AND deleted = 0",
        (project,),
    )
    row = cur.fetchone()
    max_pos = row["max_pos"] if row and row["max_pos"] is not None else -1
    new_pos = int(max_pos) + 1

    cur.execute(
        "INSERT INTO tasks (project, text, completed, created_date, due_date, position, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)",
        (project, text, completed, created_str, due_date, new_pos),
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
        (str(numero_fila), datetime.now(timezone.utc).isoformat()),
    )
    return int(cur.rowcount or 0) == 1


def try_claim_existing_null(conn_sqlite, numero_fila: str) -> bool:
    """
    Recupera casos raros onde existe registro em chamados_sync mas task_id ficou NULL
    (ex.: queda no meio do processo). Mantém idempotência via lock/transação do SQLite.
    """
    cur = conn_sqlite.cursor()
    cur.execute(
        "UPDATE chamados_sync SET created_at = created_at WHERE ticket_numero_fila = ? AND task_id IS NULL",
        (str(numero_fila),),
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
    completed_auto = 0

    # garante schema (fora de qualquer transação/conn já aberta)
    database.init_db()

    with database.get_db_connection() as sqlite_conn:
        sqlite_conn.execute("BEGIN")
        for t in tickets:
            numero = str(t.get("numero_fila", "")).strip()
            if not numero:
                continue
            status = t.get("status")

            # Se já existe task, só garante auto-complete para status fechados.
            if already_synced(sqlite_conn, numero):
                task_id = get_task_id_for_ticket(sqlite_conn, numero)
                if task_id and is_closed_status(status):
                    cur = sqlite_conn.cursor()
                    cur.execute(
                        "UPDATE tasks SET completed = 1 WHERE id = ? AND completed = 0",
                        (int(task_id),),
                    )
                    completed_auto += int(cur.rowcount or 0)
                skipped += 1
                continue

            # Claim para criação (novo ou recuperação de claim antigo com task_id NULL)
            if not try_claim_ticket(sqlite_conn, numero) and not try_claim_existing_null(sqlite_conn, numero):
                skipped += 1
                continue

            task_id = create_task_for_ticket(
                sqlite_conn,
                numero_fila=numero,
                titulo=t.get("titulo") or "",
                prioridade=t.get("prioridade"),
                status=t.get("status"),
                nome_solicitante=t.get("nome_solicitante"),
                data_abertura=t.get("data_abertura"),
            )
            mark_task_id(sqlite_conn, numero, task_id)
            created += 1

        sqlite_conn.commit()

    return created, skipped, completed_auto


def main():
    enabled = env_str("CHAMADOS_SYNC_ENABLED", "0").strip() == "1"
    if not enabled:
        print("CHAMADOS_SYNC_ENABLED != 1. Sync desligado.")
        return

    interval = env_int("CHAMADOS_POLL_SECONDS", 45)
    print(f"Sync chamados ligado. Intervalo: {interval}s")

    while True:
        try:
            created, skipped, completed_auto = run_once()
            if created or completed_auto:
                print(f"[sync] criadas: {created} | já existentes: {skipped} | auto-concluídas: {completed_auto}")
        except Exception as e:
            print("[sync] erro:", str(e))
            traceback.print_exc()
        time.sleep(max(10, interval))


if __name__ == "__main__":
    main()

