"""
Agendador de integrações (in-process).

Roda uma thread daemon que, a cada tick, procura integrações habilitadas com
agendamento vencido e as executa. O deploy padrão é single-worker
(gunicorn -w 1 / waitress), então uma única thread basta; mesmo assim usamos
um "claim" atômico (compare-and-set em next_run_at) para evitar execução
duplicada caso haja mais de um processo.

Controle por variável de ambiente:
    TASKKILL_SCHEDULER      '1' (default) liga; '0' desliga.
    TASKKILL_SCHEDULER_TICK segundos entre ticks (default 60).
"""

import logging
import os
import threading
from datetime import datetime, timedelta

from storage.db import connection
from storage import integrations as store

logger = logging.getLogger('taskkill.scheduler')

MIN_INTERVAL_MINUTES = 5
MAX_INTERVAL_MINUTES = 40320  # ~4 semanas

_started = False
_start_lock = threading.Lock()


def clamp_interval(minutes):
    """Garante um intervalo dentro de limites sãos (min 5 min)."""
    try:
        minutes = int(minutes)
    except (TypeError, ValueError):
        return 0
    if minutes <= 0:
        return 0
    return max(MIN_INTERVAL_MINUTES, min(minutes, MAX_INTERVAL_MINUTES))


def compute_next_run(interval_minutes, base=None):
    """Próximo horário (ISO UTC) a partir de agora + intervalo."""
    interval_minutes = clamp_interval(interval_minutes)
    if not interval_minutes:
        return None
    base = base or datetime.utcnow()
    return (base + timedelta(minutes=interval_minutes)).isoformat()


def _claim_due(conn, now_iso):
    """
    Retorna a lista de ids de integrações vencidas que este processo conseguiu
    reservar (compare-and-set), já reagendando o próximo horário.
    """
    rows = store.select_due(conn, now_iso)

    claimed = []
    now = datetime.utcnow()
    for r in rows:
        new_next = compute_next_run(r['schedule_interval_minutes'], base=now)
        if not new_next:
            continue
        if store.claim_next_run(conn, r['id'], new_next, r['next_run_at']) == 1:
            claimed.append(r['id'])
    conn.commit()
    return claimed


def run_due_now():
    """Executa uma varredura única (útil para testes). Retorna ids executados."""
    # Import tardio evita ciclo de import (integrations não depende do scheduler).
    import integrations

    now_iso = datetime.utcnow().isoformat()
    with connection() as conn:
        claimed = _claim_due(conn, now_iso)

    for integration_id in claimed:
        try:
            integrations.run_integration(integration_id, dry_run=False, trigger='schedule')
        except Exception as exc:  # noqa: BLE001 — não pode derrubar a thread
            logger.warning('Integração %s falhou no agendamento: %s', integration_id, exc)
    return claimed


def _loop(tick_seconds, stop_event):
    while not stop_event.is_set():
        try:
            run_due_now()
        except Exception as exc:  # noqa: BLE001 — mantém a thread viva
            logger.warning('Erro no tick do agendador: %s', exc)
        stop_event.wait(tick_seconds)


def start_scheduler():
    """Inicia a thread do agendador uma única vez por processo."""
    global _started
    if os.environ.get('TASKKILL_SCHEDULER', '1').strip() == '0':
        logger.info('Agendador desativado por TASKKILL_SCHEDULER=0.')
        return None

    with _start_lock:
        if _started:
            return None
        _started = True

    try:
        tick_seconds = int(os.environ.get('TASKKILL_SCHEDULER_TICK', '60'))
    except (TypeError, ValueError):
        tick_seconds = 60
    tick_seconds = max(10, tick_seconds)

    stop_event = threading.Event()
    thread = threading.Thread(
        target=_loop, args=(tick_seconds, stop_event),
        name='taskkill-scheduler', daemon=True
    )
    thread.start()
    logger.info('Agendador iniciado (tick=%ss).', tick_seconds)
    return thread
