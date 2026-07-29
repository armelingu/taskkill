/**
 * Projetos (sidebar): render dos itens, criar (input inline) e excluir, além do
 * drag-drop de tarefas SOBRE um projeto (mover) e a navegação ao clicar. Cada
 * item recebe seus eventos em _attachProjectItemEvents. Extraído de main.js.
 *
 * Auto-liga o botão "+" (novo projeto) no import. Exporta renderSidebarProjects,
 * usado pelo bootstrap (fetchInitialData) do main.
 */

import { state } from './state.js';
import { normText } from './util.js';
import { apiFetch } from './api.js';
import { confirmModal } from './ui.js';
import { hideIntegrationsView } from './integrations.js';
import { graphStop } from './graph.js';
import { renderTasks } from './tasks.js';
import {
    emptyState, projectView, projectTitle, graphView, dashboardView, perfilView,
} from './dom.js';

// ── Projetos dinâmicos ─────────────────────────────────────────────

// SVGs reutilizáveis
const _SVG_TRASH = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <polyline points="3 6 5 6 21 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M10 11v6M14 11v6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

function _attachProjectItemEvents(wrapper) {
    const item     = wrapper.querySelector('.project-nav');
    const btnDel   = wrapper.querySelector('.btn-delete-project');

    // Clique no item → navegar para o projeto
    item.addEventListener('click', () => {
        document.querySelectorAll('.skeleton-item').forEach(s => s.classList.remove('active'));
        item.classList.add('active');

        hideIntegrationsView();
        if (perfilView) perfilView.classList.add('hidden');

        document.body.classList.remove('graph-mode');
        state.currentCategory = normText(item.textContent);
        state.currentWeekDay = null;
        state.currentTag = null;

        if (!state.tasksData[state.currentCategory]) state.tasksData[state.currentCategory] = [];

        if (emptyState)    emptyState.classList.add('hidden');
        if (dashboardView) dashboardView.classList.add('hidden');
        if (graphView)     graphView.classList.add('hidden');
        graphStop();
        if (projectView) {
            projectView.classList.remove('hidden');
            projectView.style.animation = 'none';
            projectView.offsetHeight;
            projectView.style.animation = null;
        }

        document.querySelector('.task-input-container').style.display = 'flex';
        if (projectTitle) projectTitle.textContent = state.currentCategory;
        renderTasks();
    });

    // Drag-and-drop para mover tarefas entre projetos
    item.addEventListener('dragover', e => { e.preventDefault(); item.classList.add('drag-over'); });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', e => {
        e.preventDefault();
        item.classList.remove('drag-over');
        const taskId = e.dataTransfer.getData('text/plain');
        const newProject = normText(item.textContent);
        if (!taskId || !newProject) return;

        const numId = parseInt(taskId, 10);
        let movedTask = null;
        for (const proj in state.tasksData) {
            const idx = state.tasksData[proj].findIndex(t => t.id === numId);
            if (idx !== -1) {
                [movedTask] = state.tasksData[proj].splice(idx, 1);
                break;
            }
        }
        if (!movedTask) return;

        movedTask.project = newProject;
        movedTask.originalProject = newProject;
        if (!state.tasksData[newProject]) state.tasksData[newProject] = [];
        state.tasksData[newProject].push(movedTask);

        apiFetch(`/api/tasks/${numId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project: newProject }),
        }).then(r => { if (!r.ok) console.error('Falha ao mover tarefa'); });

        if (state.currentCategory) renderTasks();
    });

    // Botão lixeira — excluir projeto
    if (btnDel) {
        btnDel.addEventListener('click', async e => {
            e.stopPropagation();
            const name = normText(item.textContent);
            const ok = await confirmModal(
                `Excluir "${name}"?`,
                'Todas as tarefas do projeto serão arquivadas e não aparecerão mais na lista.'
            );
            if (!ok) return;

            const res = await apiFetch(`/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' });
            if (res.ok) {
                delete state.tasksData[name];
                wrapper.remove();
                if (state.currentCategory === name) {
                    state.currentCategory = null;
                    if (projectView) projectView.classList.add('hidden');
                    if (emptyState)  emptyState.classList.remove('hidden');
                }
            } else {
                alert('Erro ao excluir o projeto.');
            }
        });
    }
}

function _makeProjectWrapper(name) {
    const wrapper = document.createElement('div');
    wrapper.className = 'project-nav-item';

    const item = document.createElement('div');
    item.className = 'skeleton-item project-nav';
    item.setAttribute('aria-label', `Projeto ${name}`);
    item.textContent = name;

    const btnDel = document.createElement('button');
    btnDel.className = 'btn-delete-project';
    btnDel.title = `Excluir ${name}`;
    btnDel.setAttribute('aria-label', `Excluir projeto ${name}`);
    btnDel.innerHTML = _SVG_TRASH;

    wrapper.appendChild(item);
    wrapper.appendChild(btnDel);
    return wrapper;
}

export function renderSidebarProjects(names) {
    const list = document.getElementById('project-list');
    if (!list) return;
    list.innerHTML = '';
    names.forEach(name => {
        const wrapper = _makeProjectWrapper(name);
        list.appendChild(wrapper);
        _attachProjectItemEvents(wrapper);
    });
}

// Botão + para criar novo projeto inline
const btnAddProject = document.getElementById('btn-add-project');
if (btnAddProject) {
    btnAddProject.addEventListener('click', () => {
        const list = document.getElementById('project-list');
        if (!list) return;

        // Evita abrir dois inputs ao mesmo tempo
        if (list.querySelector('.project-new-input')) return;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'project-new-input skeleton-item';
        input.placeholder = 'Nome do projeto…';
        input.maxLength = 18;
        list.appendChild(input);
        input.focus();

        const confirmCreate = async () => {
            const name = input.value.trim();
            if (!name) { input.remove(); return; }

            const res = await apiFetch('/api/projects', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });

            if (res.ok) {
                input.remove();
                if (!state.tasksData[name]) state.tasksData[name] = [];

                const wrapper = _makeProjectWrapper(name);
                list.appendChild(wrapper);
                _attachProjectItemEvents(wrapper);

                // Aciona o clique para ir direto ao projeto novo
                wrapper.querySelector('.project-nav').click();
            } else {
                const err = await res.json().catch(() => ({}));
                alert(err.error || 'Erro ao criar projeto.');
                input.remove();
            }
        };

        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') confirmCreate();
            if (e.key === 'Escape') input.remove();
        });
        input.addEventListener('blur', () => setTimeout(() => input.remove(), 150));
    });
}
