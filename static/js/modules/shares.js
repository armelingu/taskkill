/**
 * Compartilhamento de projetos (colaboração leve).
 *
 * Dois lados:
 *  - Membro: seção "Compartilhados comigo" na sidebar + abertura do projeto do
 *    dono (tarefas ficam em state.sharedTasks[chave], fora de tasksData, para
 *    não vazar em grafo/semana/dashboard/insights).
 *  - Dono: botão "Compartilhar" no header do projeto abre um modal para
 *    adicionar/remover membros (por username) e definir papel (viewer/editor).
 */

import { state } from './state.js';
import { apiFetch } from './api.js';
import { escapeHTML } from './util.js';
import { showToast } from './ui.js';
import { openModal } from './focus.js';
import { graphStop } from './graph.js';
import { hideIntegrationsView } from './integrations.js';
import { renderTasks } from './tasks.js';
import {
    emptyState, projectView, projectTitle, graphView, dashboardView, perfilView,
} from './dom.js';

// Chave interna do projeto compartilhado. Usa NUL como separador (não aparece
// em nomes de projeto), garantindo que nunca colida com um nome real.
function sharedKey(ownerId, project) {
    return `\u0000${ownerId}\u0000${project}`;
}

// ── Membro: sidebar "Compartilhados comigo" ─────────────────────────

export async function loadSharedWithMe() {
    const list = document.getElementById('shared-list');
    const section = document.getElementById('shared-section');
    if (!list || !section) return;

    let entries = [];
    try {
        const res = await apiFetch('/api/shared');
        if (res.ok) entries = (await res.json()).shared || [];
    } catch (_e) { /* silencioso: sidebar apenas não mostra a seção */ }

    // Reconstrói o registro de chaves conhecidas (preserva tarefas já carregadas).
    list.innerHTML = '';
    if (!entries.length) {
        section.hidden = true;
        return;
    }
    section.hidden = false;

    entries.forEach((e) => {
        const key = sharedKey(e.owner_id, e.project);
        state.shares[key] = {
            ownerId: e.owner_id,
            ownerName: e.owner_username,
            project: e.project,
            role: e.role,
        };

        const item = document.createElement('div');
        item.className = 'skeleton-item shared-nav';
        item.setAttribute('role', 'button');
        item.setAttribute('aria-label', `Projeto ${e.project} de ${e.owner_username}`);
        item.innerHTML = `
            <span class="shared-nav-name">${escapeHTML(e.project)}</span>
            <span class="shared-nav-meta">@${escapeHTML(e.owner_username)}${e.role === 'viewer' ? ' · leitor' : ''}</span>`;
        item.addEventListener('click', () => {
            document.querySelectorAll('.skeleton-item').forEach((s) => s.classList.remove('active'));
            item.classList.add('active');
            openSharedProject(key);
        });
        list.appendChild(item);
    });
}

async function openSharedProject(key) {
    const meta = state.shares[key];
    if (!meta) return;

    hideIntegrationsView();
    if (perfilView) perfilView.classList.add('hidden');
    document.body.classList.remove('graph-mode');

    // Carrega as tarefas do projeto do dono (fonte da verdade a cada abertura).
    try {
        const res = await apiFetch(`/api/shared/${meta.ownerId}/${encodeURIComponent(meta.project)}/tasks`);
        if (!res.ok) {
            showToast('Não foi possível abrir o projeto compartilhado.', { variant: 'error' });
            return;
        }
        const data = await res.json();
        state.sharedTasks[key] = data.tasks || [];
        meta.role = data.role || meta.role; // papel pode ter mudado
    } catch (_e) {
        showToast('Erro ao abrir o projeto compartilhado.', { variant: 'error' });
        return;
    }

    state.currentCategory = key;
    state.currentWeekDate = null;
    state.currentTag = null;

    if (emptyState) emptyState.classList.add('hidden');
    if (dashboardView) dashboardView.classList.add('hidden');
    if (graphView) graphView.classList.add('hidden');
    graphStop();
    if (projectView) {
        projectView.classList.remove('hidden');
        projectView.style.animation = 'none';
        projectView.offsetHeight;
        projectView.style.animation = null;
    }
    if (projectTitle) projectTitle.textContent = meta.project;
    renderTasks();
}

// ── Dono: modal de compartilhamento ─────────────────────────────────

const ROLE_LABEL = { editor: 'Editor', viewer: 'Leitor' };

function renderMembers(project, members) {
    const ul = document.getElementById('share-members');
    if (!ul) return;
    ul.innerHTML = '';
    if (!members.length) {
        const li = document.createElement('li');
        li.className = 'share-member share-member--empty';
        li.textContent = 'Ainda não compartilhado com ninguém.';
        ul.appendChild(li);
        return;
    }
    members.forEach((m) => {
        const li = document.createElement('li');
        li.className = 'share-member';
        li.innerHTML = `
            <span class="share-member-name">@${escapeHTML(m.username)}</span>
            <span class="share-member-role">${escapeHTML(ROLE_LABEL[m.role] || m.role)}</span>
            <button type="button" class="share-member-remove" title="Remover acesso" aria-label="Remover ${escapeHTML(m.username)}">×</button>`;
        li.querySelector('.share-member-remove').addEventListener('click', async () => {
            const res = await apiFetch(`/api/projects/${encodeURIComponent(project)}/shares/${m.member_id}`, { method: 'DELETE' });
            if (res.ok) {
                loadMembers(project);
                showToast(`Acesso de @${m.username} removido`, { variant: 'success' });
            }
        });
        ul.appendChild(li);
    });
}

async function loadMembers(project) {
    try {
        const res = await apiFetch(`/api/projects/${encodeURIComponent(project)}/shares`);
        if (res.ok) renderMembers(project, (await res.json()).members || []);
    } catch (_e) { /* silencioso */ }
}

function showShareError(msg) {
    const el = document.getElementById('share-error');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
}

function setupShareModal() {
    const overlay = document.getElementById('share-overlay');
    const btn = document.getElementById('btn-share-project');
    if (!overlay || !btn) return;

    const closeBtn = document.getElementById('share-close');
    const form = document.getElementById('share-add-form');
    const userInput = document.getElementById('share-username');
    const roleSelect = document.getElementById('share-role');
    const sub = document.getElementById('share-modal-sub');
    let closeModal = null;

    const open = () => {
        // Só faz sentido em projeto próprio (o botão fica oculto no compartilhado).
        const project = state.currentCategory;
        if (!project || (state.shares && state.shares[project])) return;
        showShareError('');
        if (userInput) userInput.value = '';
        if (sub) sub.textContent = `Convide alguém desta instância para "${project}".`;
        overlay.dataset.project = project;
        loadMembers(project);
        closeModal = openModal(overlay, { initialFocus: userInput });
    };

    btn.addEventListener('click', open);
    if (closeBtn) closeBtn.addEventListener('click', () => closeModal && closeModal());

    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const project = overlay.dataset.project;
            const username = (userInput.value || '').trim();
            const role = roleSelect.value || 'editor';
            if (!username) return;
            showShareError('');
            const res = await apiFetch(`/api/projects/${encodeURIComponent(project)}/shares`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, role }),
            });
            if (res.ok) {
                userInput.value = '';
                loadMembers(project);
                showToast(`Compartilhado com @${username}`, { variant: 'success' });
            } else {
                const err = await res.json().catch(() => ({}));
                showShareError(err.error || 'Não foi possível compartilhar.');
            }
        });
    }
}

setupShareModal();
