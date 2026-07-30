/**
 * Lembretes in-app (sem push): ao abrir o app, mostra um resumo discreto de
 * quantas tarefas vencem hoje e quantas estão atrasadas, com atalho para a
 * visão de hoje. A ênfase visual por tarefa (hoje/atrasada) fica no render de
 * tasks.js. Nada de notificações do sistema — honesto para um app local.
 */

import { state } from './state.js';
import { todayISO } from './util.js';
import { showToast } from './ui.js';
import { goToToday } from './week.js';

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

// Conta tarefas ativas (não concluídas/arquivadas) que vencem hoje ou atrasaram.
export function countReminders() {
    const today = todayISO();
    let dueToday = 0;
    let overdue = 0;
    const data = state.tasksData || {};
    for (const project of Object.keys(data)) {
        for (const t of data[project] || []) {
            if (!t || t.completed || t.deleted) continue;
            const d = t.due_date;
            if (!d || !ISO_RE.test(d)) continue;
            if (d === today) dueToday += 1;
            else if (d < today) overdue += 1;
        }
    }
    return { dueToday, overdue };
}

let _shown = false;

// Resumo discreto, exibido uma única vez por carregamento do app.
export function showRemindersSummary() {
    if (_shown) return;
    _shown = true;

    const { dueToday, overdue } = countReminders();
    if (!dueToday && !overdue) return;

    const parts = [];
    if (dueToday) parts.push(`${dueToday} para hoje`);
    if (overdue) parts.push(`${overdue} atrasada${overdue > 1 ? 's' : ''}`);

    showToast(`Você tem ${parts.join(' e ')}.`, {
        variant: overdue ? 'error' : 'success',
        duration: 6000,
        action: { label: 'Ver hoje', onClick: () => goToToday() },
    });
}
