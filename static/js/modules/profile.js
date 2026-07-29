/**
 * Perfil inline (modal-view): dados da conta, avatar (upload/remoção), troca
 * de nome/senha, abas e "sair de todos os dispositivos". Extraído de main.js.
 *
 * Auto-inicializa no import (o módulo é deferido, DOM já pronto).
 */

import { apiFetch } from './api.js';
import { pfFmtDate } from './util.js';
import { hideIntegrationsView } from './integrations.js';

// Views que o perfil esconde ao abrir (ids estáticos do index.html).
const emptyState  = document.getElementById('empty-state');
const projectView = document.getElementById('project-view');
const graphView   = document.getElementById('graph-view');

// ── Perfil inline ──────────────────────────────────────────
const navPerfilBtn   = document.getElementById('nav-perfil');
const perfilView     = document.getElementById('perfil-view');
const perfilAlert    = document.getElementById('perfil-inline-alert');
const perfilNavBtns  = document.querySelectorAll('[data-perfil-tab]');
const perfilPanels   = document.querySelectorAll('[id^="perfil-tab-"]');

function showPerfilAlert(msg, isError) {
    if (!perfilAlert) return;
    perfilAlert.textContent = msg;
    perfilAlert.className = 'perfil-alert auth-alert ' + (isError ? 'auth-alert-error' : 'auth-alert-ok');
    perfilAlert.classList.remove('hidden');
    setTimeout(() => perfilAlert.classList.add('hidden'), 5000);
}

const perfilContent = document.querySelector('.perfil-content');

function activatePerfilTab(tabId) {
    perfilPanels.forEach(p => p.classList.toggle('hidden', p.id !== 'perfil-tab-' + tabId));
    perfilNavBtns.forEach(b => b.classList.toggle('perfil-nav-item--active', b.dataset.perfilTab === tabId));
}

// Fixa a altura do painel na maior das abas, evitando "pulos" ao trocar
function equalizePerfilHeight() {
    if (!perfilContent || !perfilPanels.length) return;
    const active = Array.from(perfilPanels).find(p => !p.classList.contains('hidden')) || perfilPanels[0];
    perfilContent.style.minHeight = '';
    let max = 0;
    perfilPanels.forEach(p => {
        perfilPanels.forEach(x => x.classList.toggle('hidden', x !== p));
        max = Math.max(max, perfilContent.offsetHeight);
    });
    perfilPanels.forEach(x => x.classList.toggle('hidden', x !== active));
    perfilContent.style.minHeight = max + 'px';
}

// Sincroniza avatar (hero + sidebar) entre imagem e iniciais
function applyAvatarState(hasAvatar) {
    const heroImg  = document.getElementById('perfil-avatar-img');
    const heroInit = document.getElementById('perfil-avatar-initials');
    const sideImg  = document.getElementById('sidebar-avatar-img');
    const sideInit = document.getElementById('sidebar-avatar-initials');
    const removeBtn = document.getElementById('pf-avatar-remove');
    if (hasAvatar) {
        const url = '/api/avatar?t=' + Date.now();  // cache-bust
        if (heroImg) { heroImg.src = url; heroImg.classList.remove('hidden'); }
        if (sideImg) { sideImg.src = url; sideImg.classList.remove('hidden'); }
        if (heroInit) heroInit.classList.add('hidden');
        if (sideInit) sideInit.classList.add('hidden');
        if (removeBtn) removeBtn.classList.remove('hidden');
    } else {
        if (heroImg) { heroImg.removeAttribute('src'); heroImg.classList.add('hidden'); }
        if (sideImg) { sideImg.removeAttribute('src'); sideImg.classList.add('hidden'); }
        if (heroInit) heroInit.classList.remove('hidden');
        if (sideInit) sideInit.classList.remove('hidden');
        if (removeBtn) removeBtn.classList.add('hidden');
    }
}

async function loadProfileMeta() {
    try {
        const res = await apiFetch('/api/profile');
        if (!res.ok) return;
        const d = await res.json();
        const cEl = document.getElementById('pf-created');
        const lEl = document.getElementById('pf-last-login');
        if (cEl) cEl.textContent = pfFmtDate(d.created_at);
        if (lEl) lEl.textContent = pfFmtDate(d.last_login_at);
        const prevLine = document.getElementById('pf-prev-login-line');
        if (prevLine) {
            prevLine.textContent = d.prev_login_at
                ? `Acesso anterior: ${pfFmtDate(d.prev_login_at)}. Encerre o acesso nos outros dispositivos — você continua conectado aqui.`
                : 'Encerre o acesso em todos os outros dispositivos onde você fez login. Você continua conectado aqui.';
        }
        applyAvatarState(!!d.has_avatar);
    } catch { /* silencioso */ }
    finally { requestAnimationFrame(equalizePerfilHeight); }
}

if (navPerfilBtn && perfilView) {
    navPerfilBtn.addEventListener('click', () => {
        // Esconde outras views e ativa o perfil
        [emptyState, projectView, graphView, document.getElementById('dashboard-view')]
            .forEach(v => v && v.classList.add('hidden'));
        hideIntegrationsView();
        perfilView.classList.remove('hidden');
        // Remove active dos itens do sidebar
        document.querySelectorAll('.skeleton-item').forEach(s => s.classList.remove('active'));
        activatePerfilTab('conta');
        requestAnimationFrame(equalizePerfilHeight);
        loadProfileMeta();
    });

    perfilNavBtns.forEach(btn => {
        btn.addEventListener('click', () => activatePerfilTab(btn.dataset.perfilTab));
    });

    // Recalcula a altura fixa quando a largura muda (quebra de texto)
    let perfilResizeRaf = 0;
    window.addEventListener('resize', () => {
        if (perfilView.classList.contains('hidden')) return;
        cancelAnimationFrame(perfilResizeRaf);
        perfilResizeRaf = requestAnimationFrame(equalizePerfilHeight);
    });

    // Avatar: upload e remoção
    const avatarEditBtn   = document.getElementById('pf-avatar-edit');
    const avatarFileInput = document.getElementById('pf-avatar-file');
    const avatarRemoveBtn  = document.getElementById('pf-avatar-remove');
    if (avatarEditBtn && avatarFileInput) {
        avatarEditBtn.addEventListener('click', () => avatarFileInput.click());
        avatarFileInput.addEventListener('change', async () => {
            const file = avatarFileInput.files[0];
            if (!file) return;
            const fd = new FormData();
            fd.append('file', file);
            try {
                const res = await apiFetch('/api/profile/avatar', { method: 'POST', body: fd });
                const json = await res.json();
                if (!res.ok) showPerfilAlert(json.error || 'Falha ao enviar a foto.', true);
                else { applyAvatarState(true); showPerfilAlert('Foto atualizada.', false); }
            } catch {
                showPerfilAlert('Erro de rede ao enviar a foto.', true);
            } finally {
                avatarFileInput.value = '';
            }
        });
    }
    if (avatarRemoveBtn) {
        avatarRemoveBtn.addEventListener('click', async () => {
            try {
                const res = await apiFetch('/api/profile/avatar', { method: 'DELETE' });
                const json = await res.json();
                if (!res.ok) showPerfilAlert(json.error || 'Falha ao remover a foto.', true);
                else { applyAvatarState(false); showPerfilAlert('Foto removida.', false); }
            } catch {
                showPerfilAlert('Erro de rede. Tente novamente.', true);
            }
        });
    }

    // Nome de usuário
    const formUsuario = document.getElementById('form-usuario');
    if (formUsuario) {
        formUsuario.addEventListener('submit', async e => {
            e.preventDefault();
            const newName = formUsuario.querySelector('[name="new_username"]').value.trim();
            const password = formUsuario.querySelector('[name="confirm_password_u"]').value;
            try {
                const res = await apiFetch('/api/profile/username', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ new_username: newName, password })
                });
                const json = await res.json();
                if (!res.ok) {
                    showPerfilAlert(json.error || 'Erro ao salvar.', true);
                } else {
                    showPerfilAlert(json.message || 'Salvo com sucesso.', false);
                    const nm = json.username || newName;
                    const lbl      = document.getElementById('sidebar-username-label');
                    const disp     = document.getElementById('perfil-username-display');
                    const heroInit = document.getElementById('perfil-avatar-initials');
                    const sideInit = document.getElementById('sidebar-avatar-initials');
                    if (lbl) lbl.textContent = nm;
                    if (disp) disp.textContent = nm;
                    if (nm) {
                        if (heroInit) heroInit.textContent = nm[0].toUpperCase();
                        if (sideInit) sideInit.textContent = nm[0].toUpperCase();
                    }
                    formUsuario.querySelector('[name="confirm_password_u"]').value = '';
                }
            } catch {
                showPerfilAlert('Erro de rede. Tente novamente.', true);
            }
        });
    }

    // Senha
    const formSenha = document.getElementById('form-senha');
    if (formSenha) {
        formSenha.addEventListener('submit', async e => {
            e.preventDefault();
            const body = {
                current_password: formSenha.querySelector('[name="current_password"]').value,
                new_password: formSenha.querySelector('[name="new_password"]').value,
                confirm_password: formSenha.querySelector('[name="confirm_password"]').value
            };
            try {
                const res = await apiFetch('/api/profile/password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                const json = await res.json();
                if (!res.ok) showPerfilAlert(json.error || 'Erro ao salvar.', true);
                else { showPerfilAlert(json.message || 'Senha atualizada.', false); formSenha.reset(); }
            } catch {
                showPerfilAlert('Erro de rede. Tente novamente.', true);
            }
        });
    }

    // Sair de todos os dispositivos
    const logoutAllBtn = document.getElementById('pf-logout-all');
    if (logoutAllBtn) {
        logoutAllBtn.addEventListener('click', async () => {
            logoutAllBtn.disabled = true;
            try {
                const res = await apiFetch('/api/profile/logout-all', { method: 'POST' });
                const json = await res.json();
                if (!res.ok) showPerfilAlert(json.error || 'Falha ao encerrar sessões.', true);
                else showPerfilAlert(json.message || 'As outras sessões foram encerradas.', false);
            } catch {
                showPerfilAlert('Erro de rede. Tente novamente.', true);
            } finally {
                logoutAllBtn.disabled = false;
            }
        });
    }
}
