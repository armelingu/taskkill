/**
 * Faixa da semana (sidebar): renderiza os 7 dias (Seg–Dom) da semana visível
 * com datas reais, permite navegar entre semanas (anterior/próxima/hoje),
 * destaca o dia de hoje e é o alvo de drag-drop para agendar tarefas por data.
 *
 * O prazo da tarefa (due_date) é uma data ISO YYYY-MM-DD. Cada chip de dia é um
 * `.skeleton-item.week-day` com `data-date`, então o clearing de `.active` feito
 * pelos outros navegadores (projetos/dashboard/grafo) também desmarca a faixa.
 *
 * Auto-inicializa no import (como profile/theme). Exporta renderWeek para quem
 * precisar re-renderizar após mudança externa.
 */

import { state } from './state.js';
import { apiFetch } from './api.js';
import { showToast } from './ui.js';
import { graphStop } from './graph.js';
import { renderTasks } from './tasks.js';
import { hideIntegrationsView } from './integrations.js';
import {
    emptyState, projectView, projectTitle, graphView, dashboardView, perfilView,
} from './dom.js';
import {
    todayISO, startOfWeekISO, addDaysISO, formatBR,
    weekdayShort, weekdayLong, monthShort,
} from './util.js';

const WEEKEND = new Set([0, 6]); // getDay(): 0=Dom, 6=Sáb

// Abre a visão da semana para uma data ISO específica (equivalente à antiga
// navegação por nome de dia, agora com data real).
function openWeekView(iso, chip) {
    document.querySelectorAll('.skeleton-item').forEach(s => s.classList.remove('active'));
    if (chip) chip.classList.add('active');

    hideIntegrationsView();
    if (perfilView) perfilView.classList.add('hidden');

    document.body.classList.remove('graph-mode');
    state.currentCategory = null;
    state.currentWeekDate = iso;
    state.currentTag = null;

    if (emptyState) emptyState.classList.add('hidden');
    if (dashboardView) dashboardView.classList.add('hidden');
    if (graphView) graphView.classList.add('hidden');
    graphStop();

    if (projectView) {
        projectView.classList.remove('hidden');
        projectView.style.animation = 'none';
        projectView.offsetHeight; // força reflow para reiniciar a animação
        projectView.style.animation = null;
    }

    if (projectTitle) projectTitle.textContent = `${weekdayLong(iso)}, ${formatBR(iso)}`;

    // Na visão da semana não criamos tarefas diretamente (falta o projeto).
    const inputContainer = document.querySelector('.task-input-container');
    if (inputContainer) inputContainer.style.display = 'none';

    renderTasks();
}

// Agenda a tarefa arrastada para a data do chip (drop na faixa da semana).
function scheduleDroppedTask(iso, taskId) {
    const numId = parseInt(taskId, 10);
    let target = null;
    for (const proj in state.tasksData) {
        const found = state.tasksData[proj].find(t => t.id === numId);
        if (found) { target = found; break; }
    }
    if (!target) return;
    if (target.due_date === iso) return;

    target.due_date = iso;
    apiFetch(`/api/tasks/${numId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ due_date: iso }),
    }).then(r => { if (!r.ok) console.error('Falha ao agendar tarefa'); });

    showToast(`Agendado para ${formatBR(iso)}`);
    renderTasks();
}

function _makeDayChip(iso) {
    const chip = document.createElement('div');
    chip.className = 'skeleton-item week-day';
    chip.setAttribute('data-date', iso);
    chip.setAttribute('role', 'button');
    chip.setAttribute('tabindex', '0');
    chip.setAttribute('aria-label', `${weekdayLong(iso)}, ${formatBR(iso)}`);

    const dow = new Date(iso.slice(0, 4), Number(iso.slice(5, 7)) - 1, iso.slice(8, 10)).getDay();
    if (iso === todayISO()) chip.classList.add('is-today');
    if (WEEKEND.has(dow)) chip.classList.add('is-weekend');

    const name = document.createElement('span');
    name.className = 'week-day-name';
    name.textContent = weekdayShort(iso);

    const num = document.createElement('span');
    num.className = 'week-day-num';
    num.textContent = iso.slice(8, 10);

    chip.appendChild(name);
    chip.appendChild(num);

    // Marca ativo se esta data já é a visão atual (mantém seleção ao navegar semanas).
    if (state.currentWeekDate === iso) chip.classList.add('active');

    chip.addEventListener('click', () => openWeekView(iso, chip));
    chip.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openWeekView(iso, chip); }
    });

    chip.addEventListener('dragover', e => { e.preventDefault(); chip.classList.add('drag-over'); });
    chip.addEventListener('dragleave', () => chip.classList.remove('drag-over'));
    chip.addEventListener('drop', e => {
        e.preventDefault();
        chip.classList.remove('drag-over');
        const taskId = e.dataTransfer.getData('text/plain');
        if (taskId) scheduleDroppedTask(iso, taskId);
    });

    return chip;
}

// Rótulo do intervalo da semana (ex.: "4–10 ago" ou "28 jul – 3 ago").
function _rangeLabel(startIso, endIso) {
    const startDay = startIso.slice(8, 10);
    const endDay = endIso.slice(8, 10);
    const startMonth = monthShort(startIso);
    const endMonth = monthShort(endIso);
    if (startMonth === endMonth) {
        return `${Number(startDay)}–${Number(endDay)} ${endMonth}`;
    }
    return `${Number(startDay)} ${startMonth} – ${Number(endDay)} ${endMonth}`;
}

export function renderWeek() {
    const strip = document.getElementById('week-strip');
    const range = document.getElementById('week-range');
    if (!strip) return;

    if (!state.currentWeekStart) {
        state.currentWeekStart = startOfWeekISO(todayISO());
    }

    strip.innerHTML = '';
    let iso = state.currentWeekStart;
    let last = iso;
    for (let i = 0; i < 7; i++) {
        strip.appendChild(_makeDayChip(iso));
        last = iso;
        iso = addDaysISO(iso, 1);
    }

    if (range) range.textContent = _rangeLabel(state.currentWeekStart, last);
}

function _shiftWeek(deltaDays) {
    state.currentWeekStart = addDaysISO(
        state.currentWeekStart || startOfWeekISO(todayISO()), deltaDays);
    renderWeek();
}

function initWeekControls() {
    const prev = document.getElementById('week-prev');
    const next = document.getElementById('week-next');
    const today = document.getElementById('week-today');

    if (prev) prev.addEventListener('click', () => _shiftWeek(-7));
    if (next) next.addEventListener('click', () => _shiftWeek(7));
    if (today) today.addEventListener('click', () => {
        state.currentWeekStart = startOfWeekISO(todayISO());
        renderWeek();
    });
}

initWeekControls();
renderWeek();
