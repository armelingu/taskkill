"""
Recorrência de tarefas (lógica pura, sem estado/DB — fácil de testar).

Modelo "reagenda a mesma tarefa": ao concluir uma tarefa recorrente, o back
avança o `due_date` para a próxima ocorrência e a mantém desmarcada, então
existe sempre uma única tarefa viva (estilo Todoist).

Presets suportados:
    none      — sem recorrência
    daily     — todo dia
    weekdays  — dias úteis (pula sábado/domingo)
    weekly    — a cada 7 dias
    monthly   — todo mês (mesmo dia, com clamp no fim do mês)
"""

from datetime import date, timedelta

ALLOWED_RECURRENCE = ('none', 'daily', 'weekdays', 'weekly', 'monthly')


def valid_recurrence(value) -> bool:
    """True se `value` é uma regra de recorrência conhecida."""
    return value in ALLOWED_RECURRENCE


def _add_months(d: date, months: int) -> date:
    """Soma `months` a `d`, fazendo clamp do dia ao último dia do mês alvo."""
    total = d.month - 1 + months
    year = d.year + total // 12
    month = total % 12 + 1
    if month == 12:
        last_day = 31
    else:
        last_day = (date(year, month + 1, 1) - timedelta(days=1)).day
    return date(year, month, min(d.day, last_day))


def next_occurrence(iso: str, rule: str):
    """
    Próxima data ISO (YYYY-MM-DD) após `iso` conforme `rule`.
    Retorna None quando não há data-base ou a regra é vazia/'none'/desconhecida.
    """
    if not iso or rule in (None, '', 'none'):
        return None
    try:
        d = date.fromisoformat(iso)
    except (ValueError, TypeError):
        return None

    if rule == 'daily':
        nd = d + timedelta(days=1)
    elif rule == 'weekly':
        nd = d + timedelta(days=7)
    elif rule == 'weekdays':
        nd = d + timedelta(days=1)
        while nd.weekday() >= 5:  # 5=sábado, 6=domingo
            nd += timedelta(days=1)
    elif rule == 'monthly':
        nd = _add_months(d, 1)
    else:
        return None

    return nd.isoformat()
