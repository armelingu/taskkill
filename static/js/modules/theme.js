/*
 * theme.js — controle de tema (Claro / Escuro / Sistema).
 *
 * O tema inicial já é aplicado por theme-boot.js no <head> (anti-FOUC). Este
 * módulo apenas gerencia a troca em runtime: persiste o modo em localStorage +
 * no servidor (users.theme_pref, sincroniza entre dispositivos), reage a
 * mudanças do SO quando em "system", sincroniza a UI (controle segmentado do
 * perfil + botão-ícone do sidebar) e emite `taskkill:theme-changed` para quem
 * precisa repintar fora do CSS (ex.: o canvas do grafo).
 *
 * Fonte de verdade: a preferência do servidor, injetada em
 * <html data-theme-mode> pelo backend; o localStorage é só um cache local.
 */

import { apiFetch } from './api.js';

const KEY = 'taskkill-theme';
const MODES = ['light', 'dark', 'system'];
const LABELS = { light: 'Claro', dark: 'Escuro', system: 'Sistema' };

const ICONS = {
    sun: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="12" cy="12" r="4.2" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M20 13.2A8 8 0 1 1 10.8 4a6.3 6.3 0 0 0 9.2 9.2Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    system: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="3" y="4.5" width="18" height="12" rx="1.6" stroke="currentColor" stroke-width="1.8"/><path d="M9 20h6M12 16.5V20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};

const mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function getMode() {
    const stored = localStorage.getItem(KEY);
    return MODES.includes(stored) ? stored : 'system';
}

// Modo salvo no servidor, injetado em <html data-theme-mode> (fonte de verdade).
function getServerMode() {
    const m = document.documentElement.dataset.themeMode;
    return MODES.includes(m) ? m : null;
}

// Persiste no servidor (fire-and-forget); offline mantém só o cache local.
function syncServer(mode) {
    apiFetch('/api/profile/theme', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
    }).catch(() => { /* sem rede: fica só no localStorage */ });
}

function resolve(mode) {
    if (mode === 'system') {
        return mql && mql.matches ? 'dark' : 'light';
    }
    return mode;
}

function syncUI(mode, resolved) {
    document.querySelectorAll('#theme-segmented .theme-seg-btn').forEach((btn) => {
        const active = btn.dataset.themeMode === mode;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-checked', active ? 'true' : 'false');
    });

    const toggle = document.getElementById('sidebar-theme-toggle');
    if (toggle) {
        const icon = toggle.querySelector('.sidebar-theme-icon');
        if (icon) {
            icon.innerHTML = mode === 'system' ? ICONS.system : (resolved === 'dark' ? ICONS.moon : ICONS.sun);
        }
        toggle.title = `Tema: ${LABELS[mode]}`;
        toggle.setAttribute('aria-label', `Alternar tema (atual: ${LABELS[mode]})`);
    }
}

function apply(mode, { persist = true } = {}) {
    const resolved = resolve(mode);
    document.documentElement.setAttribute('data-theme', resolved);
    if (persist) {
        localStorage.setItem(KEY, mode);
        document.documentElement.dataset.themeMode = mode;
        syncServer(mode);
    }
    syncUI(mode, resolved);
    document.dispatchEvent(new CustomEvent('taskkill:theme-changed', {
        detail: { mode, resolved },
    }));
}

function initThemeControls() {
    // Reconcilia com o servidor (fonte de verdade): se o modo salvo no banco
    // difere do cache local, adota o do servidor. O boot já pintou com ele,
    // então isto só alinha o localStorage/UI — sem flash.
    const serverMode = getServerMode();
    if (serverMode && serverMode !== getMode()) {
        localStorage.setItem(KEY, serverMode);
    }

    const mode = getMode();
    syncUI(mode, resolve(mode));

    const segmented = document.getElementById('theme-segmented');
    if (segmented) {
        segmented.addEventListener('click', (e) => {
            const btn = e.target.closest('.theme-seg-btn');
            if (!btn) return;
            apply(btn.dataset.themeMode);
        });
    }

    const toggle = document.getElementById('sidebar-theme-toggle');
    if (toggle) {
        toggle.addEventListener('click', () => {
            const next = MODES[(MODES.indexOf(getMode()) + 1) % MODES.length];
            apply(next);
        });
    }

    // Em "system", acompanha a mudança de tema do SO em tempo real.
    if (mql) {
        const onChange = () => {
            if (getMode() === 'system') apply('system', { persist: false });
        };
        if (mql.addEventListener) mql.addEventListener('change', onChange);
        else if (mql.addListener) mql.addListener(onChange);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initThemeControls);
} else {
    initThemeControls();
}
