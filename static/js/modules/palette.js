/**
 * Command Palette (Cmd/Ctrl-K) — busca fuzzy sobre comandos de navegação,
 * ações e itens dinâmicos (projetos e #tags). Navegação 100% por teclado
 * (setas + Enter), com focus-trap e retorno de foco ao fechar.
 *
 * Reaproveita a navegação existente acionando os elementos reais da sidebar
 * (nenhuma regra de negócio é duplicada). Registra o atalho mod+k no sistema
 * central de atalhos, então aparece automaticamente na cheatsheet ('?').
 */

import { state } from './state.js';
import { openModal } from './focus.js';
import { registerShortcut, openCheatsheet } from './shortcuts.js';
import { openTagView } from './tasks.js';
import { goToToday } from './week.js';

const IS_MAC = /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');
const MOD = IS_MAC ? '⌘' : 'Ctrl';

let els = null;          // refs do DOM (lazy)
let closePalette = null; // fn de fechamento (openModal)
let commands = [];       // catálogo atual (recomputado ao abrir)
let filtered = [];       // resultado filtrado
let selected = 0;        // índice selecionado

function clickById(id) {
    const el = document.getElementById(id);
    if (el) el.click();
}

// Coleta #tags únicas de todas as tarefas em cache.
function collectTags() {
    const set = new Set();
    for (const proj in state.tasksData) {
        for (const t of state.tasksData[proj]) {
            const matches = String(t.text || '').match(/#[\p{L}\p{N}_-]+/gu);
            if (matches) matches.forEach(m => set.add(m.slice(1).toLowerCase()));
        }
    }
    return Array.from(set).sort();
}

// Nomes de projeto pela sidebar real (reflete o estado atual + ordem).
function collectProjects() {
    return Array.from(document.querySelectorAll('#project-list .project-nav'))
        .map(el => ({ name: (el.textContent || '').trim(), el }))
        .filter(p => p.name);
}

function buildCommands() {
    const list = [];

    // Navegação
    list.push({ title: 'Ir para o Painel', group: 'Ir para', keywords: 'dashboard inicio home', hint: ['G', 'D'], run: () => clickById('nav-dashboard') });
    list.push({ title: 'Ir para o Grafo', group: 'Ir para', keywords: 'graph rede visual', hint: ['G', 'G'], run: () => clickById('nav-graph') });
    list.push({ title: 'Ir para a Semana (hoje)', group: 'Ir para', keywords: 'week hoje calendario dias', hint: ['G', 'S'], run: () => goToToday() });
    list.push({ title: 'Ir para Integrações', group: 'Ir para', keywords: 'integrations api import', hint: ['G', 'I'], run: () => clickById('nav-integrations') });
    list.push({ title: 'Ir para Meu perfil', group: 'Ir para', keywords: 'profile conta usuario', hint: ['G', 'P'], run: () => clickById('nav-perfil') });

    // Ações
    if (state.currentCategory) {
        list.push({ title: 'Nova demanda', group: 'Ações', keywords: 'add criar tarefa nova', hint: ['N'], run: () => { const i = document.getElementById('new-task-input'); if (i) i.focus(); } });
    }
    list.push({ title: 'Alternar tema (claro/escuro)', group: 'Ações', keywords: 'dark light theme tema modo', run: () => clickById('sidebar-theme-toggle') });
    list.push({ title: 'Mostrar atalhos de teclado', group: 'Ações', keywords: 'shortcuts ajuda help teclas', hint: ['?'], run: () => openCheatsheet() });
    list.push({ title: 'Sair do sistema', group: 'Ações', keywords: 'logout sair encerrar', run: () => clickById('sidebar-logout-trigger') });

    // Projetos (dinâmico)
    for (const p of collectProjects()) {
        list.push({ title: p.name, group: 'Projetos', keywords: `projeto ${p.name}`, run: () => p.el.click() });
    }

    // Tags (dinâmico)
    for (const tag of collectTags()) {
        list.push({ title: `#${tag}`, group: 'Tags', keywords: `tag etiqueta ${tag}`, run: () => openTagView(tag) });
    }

    return list;
}

// Fuzzy: casamento por subsequência com bônus de início/consecutivos.
function fuzzyScore(query, text) {
    if (!query) return 0;
    const q = query.toLowerCase();
    const t = text.toLowerCase();
    let qi = 0;
    let score = 0;
    let prev = -2;
    for (let i = 0; i < t.length && qi < q.length; i++) {
        if (t[i] === q[qi]) {
            score += (i === prev + 1) ? 6 : 1;
            if (i === 0) score += 4;
            prev = i;
            qi++;
        }
    }
    if (qi < q.length) return -1; // não casou tudo
    return score - t.length * 0.02;
}

function scoreCommand(query, cmd) {
    if (!query) return 0;
    const a = fuzzyScore(query, cmd.title);
    const b = fuzzyScore(query, cmd.keywords || '');
    return Math.max(a, b === -1 ? -1 : b - 1); // título tem prioridade
}

function applyFilter(query) {
    const q = query.trim();
    if (!q) {
        filtered = commands.slice();
    } else {
        filtered = commands
            .map(cmd => ({ cmd, score: scoreCommand(q, cmd) }))
            .filter(x => x.score >= 0)
            .sort((a, b) => b.score - a.score)
            .map(x => x.cmd);
    }
    selected = 0;
    renderResults();
}

function renderResults() {
    const { results, empty } = els;
    results.innerHTML = '';
    if (!filtered.length) {
        empty.classList.remove('hidden');
        return;
    }
    empty.classList.add('hidden');

    let lastGroup = null;
    filtered.forEach((cmd, idx) => {
        if (cmd.group !== lastGroup) {
            lastGroup = cmd.group;
            const gh = document.createElement('div');
            gh.className = 'palette-group';
            gh.textContent = cmd.group;
            results.appendChild(gh);
        }

        const row = document.createElement('div');
        row.className = 'palette-item' + (idx === selected ? ' is-selected' : '');
        row.setAttribute('role', 'option');
        row.dataset.idx = String(idx);

        const label = document.createElement('span');
        label.className = 'palette-item-label';
        label.textContent = cmd.title;
        row.appendChild(label);

        if (cmd.hint) {
            const keys = document.createElement('span');
            keys.className = 'palette-item-keys';
            cmd.hint.forEach(k => {
                const kbd = document.createElement('kbd');
                kbd.textContent = k;
                keys.appendChild(kbd);
            });
            row.appendChild(keys);
        }

        row.addEventListener('mousemove', () => {
            if (selected !== idx) { selected = idx; highlight(); }
        });
        row.addEventListener('click', () => runSelected(idx));

        results.appendChild(row);
    });
}

function highlight() {
    const rows = els.results.querySelectorAll('.palette-item');
    rows.forEach(r => r.classList.toggle('is-selected', Number(r.dataset.idx) === selected));
    const active = els.results.querySelector('.palette-item.is-selected');
    if (active) active.scrollIntoView({ block: 'nearest' });
}

function move(delta) {
    if (!filtered.length) return;
    selected = (selected + delta + filtered.length) % filtered.length;
    highlight();
}

function runSelected(idx) {
    const i = typeof idx === 'number' ? idx : selected;
    const cmd = filtered[i];
    close();
    if (cmd) cmd.run();
}

function build() {
    const overlay = document.createElement('div');
    overlay.className = 'palette-overlay hidden';
    overlay.id = 'command-palette';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Paleta de comandos');

    const panel = document.createElement('div');
    panel.className = 'palette-panel';

    const inputWrap = document.createElement('div');
    inputWrap.className = 'palette-input-wrap';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'palette-input';
    input.placeholder = 'Buscar comando, projeto ou #tag…';
    input.setAttribute('aria-label', 'Buscar comando');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'true');
    input.autocomplete = 'off';
    input.spellcheck = false;
    inputWrap.appendChild(input);

    const results = document.createElement('div');
    results.className = 'palette-results';
    results.setAttribute('role', 'listbox');

    const empty = document.createElement('div');
    empty.className = 'palette-empty hidden';
    empty.textContent = 'Nenhum comando encontrado.';

    const footer = document.createElement('div');
    footer.className = 'palette-footer';
    footer.innerHTML = '<span><kbd>↑</kbd><kbd>↓</kbd> navegar</span>'
        + '<span><kbd>Enter</kbd> abrir</span>'
        + '<span><kbd>Esc</kbd> fechar</span>';

    panel.appendChild(inputWrap);
    panel.appendChild(results);
    panel.appendChild(empty);
    panel.appendChild(footer);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    input.addEventListener('input', () => applyFilter(input.value));
    input.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); runSelected(); }
        else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    return { overlay, input, results, empty };
}

function open() {
    if (closePalette) { close(); return; } // toggle
    if (!els) els = build();
    commands = buildCommands();
    els.input.value = '';
    applyFilter('');
    closePalette = openModal(els.overlay, { initialFocus: els.input });
}

function close() {
    if (closePalette) { closePalette(); closePalette = null; }
}

registerShortcut({
    keys: 'mod+k', group: 'Geral', label: 'Paleta de comandos', global: true,
    run: () => open(),
});
