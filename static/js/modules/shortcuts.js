/**
 * Sistema central de atalhos de teclado (estilo Linear).
 *
 * Suporta três formatos de tecla:
 *   - simples:   'n', '?'            (uma tecla)
 *   - chord:     'g d', 'g g'        (líder "g" seguido de outra tecla)
 *   - modificador: 'mod+k'          (Cmd no macOS / Ctrl no resto)
 *
 * Regras de contexto:
 *   - Atalhos de caractere são ignorados quando o foco está em input/textarea/
 *     contenteditable (para não roubar a digitação).
 *   - Atalhos com `global: true` (ex.: Esc, mod+k) funcionam mesmo digitando.
 *   - `when()` opcional decide se o atalho está ativo no momento.
 *
 * Expõe registerShortcut/getShortcuts para outros módulos (ex.: palette) e
 * monta a cheatsheet do overlay '?'. Auto-inicializa no import.
 */

import { state } from './state.js';
import { goToToday } from './week.js';
import { openModal } from './focus.js';

const IS_MAC = /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');
const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl';
const CHORD_TIMEOUT = 1200; // ms para completar um chord

/** @type {Array<object>} registro de atalhos */
const shortcuts = [];

// Converte a string de tecla em um descritor tipado + rótulo p/ a cheatsheet.
function parseKeys(keys) {
    if (keys.includes(' ')) {
        const [lead, key] = keys.split(/\s+/);
        return {
            type: 'chord',
            lead: lead.toLowerCase(),
            key: key.toLowerCase(),
            display: [lead.toUpperCase(), key.toUpperCase()],
        };
    }
    if (keys.startsWith('mod+')) {
        const key = keys.slice(4).toLowerCase();
        return { type: 'combo', mod: true, key, display: [MOD_LABEL, key.toUpperCase()] };
    }
    // simples
    const key = keys.toLowerCase();
    const disp = key === '?' ? '?' : key.toUpperCase();
    return { type: 'single', key, display: [disp] };
}

/**
 * Registra um atalho.
 * @param {{ keys:string, label:string, group?:string, when?:()=>boolean,
 *           run:(e:KeyboardEvent)=>void, global?:boolean }} def
 */
export function registerShortcut(def) {
    shortcuts.push({ ...parseKeys(def.keys), ...def, group: def.group || 'Geral' });
}

export function getShortcuts() {
    return shortcuts.slice();
}

// ── Dispatcher ─────────────────────────────────────────────────
let pendingLead = null;
let leadTimer = null;

function clearLead() {
    pendingLead = null;
    if (leadTimer) { clearTimeout(leadTimer); leadTimer = null; }
}

function isTyping() {
    const el = document.activeElement;
    if (!el) return false;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

function passes(s) {
    return typeof s.when !== 'function' || s.when();
}

function run(s, e) {
    e.preventDefault();
    s.run(e);
}

function onKeydown(e) {
    // 1) Combos com modificador (funcionam mesmo digitando se global).
    if (e.metaKey || e.ctrlKey) {
        const combo = shortcuts.find(s => s.type === 'combo' && s.key === e.key.toLowerCase());
        if (combo && (combo.global || !isTyping()) && passes(combo)) {
            clearLead();
            run(combo, e);
        }
        return;
    }
    if (e.altKey) return;

    // 2) Esc só limpa chord pendente; overlays tratam o fechamento.
    if (e.key === 'Escape') { clearLead(); return; }

    const typing = isTyping();
    const lower = e.key.toLowerCase();

    // 3) Chord em progresso: tenta completar líder + tecla.
    if (pendingLead && !typing) {
        const chord = shortcuts.find(s => s.type === 'chord' && s.lead === pendingLead && s.key === lower);
        clearLead();
        if (chord && passes(chord)) run(chord, e);
        return;
    }

    if (typing) { clearLead(); return; }

    // 4) Inicia um chord se a tecla é líder de algum atalho registrado.
    if (shortcuts.some(s => s.type === 'chord' && s.lead === lower)) {
        pendingLead = lower;
        leadTimer = setTimeout(clearLead, CHORD_TIMEOUT);
        return;
    }

    // 5) Atalho simples (compara e.key bruto p/ '?' e minúsculo p/ letras).
    const single = shortcuts.find(s => s.type === 'single' && (s.key === e.key || s.key === lower));
    if (single && passes(single)) run(single, e);
}

// ── Cheatsheet (overlay '?') ───────────────────────────────────
let sheetOverlay = null;
let closeSheet = null;

function buildSheet() {
    const overlay = document.createElement('div');
    overlay.className = 'shortcuts-overlay hidden';
    overlay.id = 'shortcuts-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'shortcuts-title');

    const sheet = document.createElement('div');
    sheet.className = 'shortcuts-sheet';

    const head = document.createElement('div');
    head.className = 'shortcuts-head';
    const title = document.createElement('h3');
    title.id = 'shortcuts-title';
    title.textContent = 'Atalhos de teclado';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'shortcuts-close';
    closeBtn.setAttribute('aria-label', 'Fechar');
    closeBtn.textContent = '×';
    head.appendChild(title);
    head.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'shortcuts-body';

    sheet.appendChild(head);
    sheet.appendChild(body);
    overlay.appendChild(sheet);
    document.body.appendChild(overlay);

    closeBtn.addEventListener('click', () => hideCheatsheet());
    overlay.addEventListener('click', e => { if (e.target === overlay) hideCheatsheet(); });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !overlay.classList.contains('hidden')) hideCheatsheet();
    });

    return { overlay, body };
}

function renderSheetBody(body) {
    body.innerHTML = '';
    const groups = new Map();
    for (const s of shortcuts) {
        if (s.hidden) continue;
        if (!groups.has(s.group)) groups.set(s.group, []);
        groups.get(s.group).push(s);
    }

    for (const [group, items] of groups) {
        const section = document.createElement('div');
        section.className = 'shortcuts-group';
        const h = document.createElement('h4');
        h.className = 'shortcuts-group-title';
        h.textContent = group;
        section.appendChild(h);

        for (const s of items) {
            const row = document.createElement('div');
            row.className = 'shortcut-row';

            const label = document.createElement('span');
            label.className = 'shortcut-label';
            label.textContent = s.label;

            const keys = document.createElement('span');
            keys.className = 'shortcut-keys';
            s.display.forEach((k, i) => {
                const kbd = document.createElement('kbd');
                kbd.textContent = k;
                keys.appendChild(kbd);
                if (i < s.display.length - 1) {
                    const plus = document.createElement('span');
                    plus.className = 'shortcut-sep';
                    plus.textContent = s.type === 'chord' ? 'depois' : '+';
                    keys.appendChild(plus);
                }
            });

            row.appendChild(label);
            row.appendChild(keys);
            section.appendChild(row);
        }
        body.appendChild(section);
    }
}

export function openCheatsheet() {
    if (!sheetOverlay) sheetOverlay = buildSheet();
    renderSheetBody(sheetOverlay.body);
    closeSheet = openModal(sheetOverlay.overlay);
}

function hideCheatsheet() {
    if (closeSheet) { closeSheet(); closeSheet = null; }
}

// ── Atalhos padrão ─────────────────────────────────────────────
function clickById(id) {
    const el = document.getElementById(id);
    if (el) el.click();
}

registerShortcut({ keys: 'g d', group: 'Ir para', label: 'Painel (dashboard)', run: () => clickById('nav-dashboard') });
registerShortcut({ keys: 'g g', group: 'Ir para', label: 'Grafo', run: () => clickById('nav-graph') });
registerShortcut({ keys: 'g s', group: 'Ir para', label: 'Semana (hoje)', run: () => goToToday() });
registerShortcut({ keys: 'g i', group: 'Ir para', label: 'Integrações', run: () => clickById('nav-integrations') });
registerShortcut({ keys: 'g p', group: 'Ir para', label: 'Meu perfil', run: () => clickById('nav-perfil') });

registerShortcut({
    keys: 'n', group: 'Ações', label: 'Nova demanda',
    when: () => !!state.currentCategory,
    run: () => {
        const input = document.getElementById('new-task-input');
        if (input) input.focus();
    },
});

registerShortcut({ keys: '?', group: 'Geral', label: 'Mostrar atalhos', run: () => openCheatsheet() });

document.addEventListener('keydown', onKeydown);
