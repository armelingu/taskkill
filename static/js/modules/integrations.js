/**
 * Módulo de Integrações externas (admin): wizard de 4 passos, CRUD, auth,
 * paginação, agendamento, prévia e histórico. Extraído de main.js.
 *
 * Só usa helpers já modularizados + o próprio DOM (ids `int-*`, estáticos).
 * A troca de views / reset de estado ao abrir fica no main.js (nav handler);
 * aqui só cuidamos do painel de integrações em si.
 */

import { apiFetch } from './api.js';
import { showToast, confirmModal } from './ui.js';
import { openModal } from './focus.js';
import { escapeHTML, normText } from './util.js';
import { intRenderTemplate } from './templates.js';

// Avisa o app (main.js) que tarefas mudaram após import/execução, para ele
// recarregar o cache/sidebar. Desacopla das internals do main (sem import cíclico).
function notifyTasksChanged() {
    document.dispatchEvent(new CustomEvent('taskkill:tasks-changed'));
}

// ================================================================
// INTEGRAÇÕES EXTERNAS (admin) — wizard + CRUD
// ================================================================
const integrationsView = document.getElementById('integrations-view');
const intListPanel   = document.getElementById('int-list-panel');
const intListEl      = document.getElementById('int-list');
const intEmptyEl     = document.getElementById('int-empty');
const intEditor      = document.getElementById('int-editor');
const intEditorTitle = document.getElementById('int-editor-title');
const intAlert       = document.getElementById('int-alert');
const intStepper     = document.getElementById('int-stepper');
const intJson        = document.getElementById('int-json');
const intJsonApply   = document.getElementById('int-json-apply');
const intId          = document.getElementById('int-id');
const intName        = document.getElementById('int-name');
const intUrl         = document.getElementById('int-url');
const intMethod      = document.getElementById('int-method');
const intAuthType    = document.getElementById('int-auth-type');
const intAuthFields  = document.getElementById('int-auth-fields');
const intPagMode     = document.getElementById('int-pag-mode');
const intPagFields   = document.getElementById('int-pag-fields');
const intHeaders     = document.getElementById('int-headers');
const intQuery       = document.getElementById('int-query');
const intAllowPrivate= document.getElementById('int-allow-private');
const intItemsPathSel= document.getElementById('int-items-path-sel');
const intItemsChoice = document.getElementById('int-items-choice');
const intItemsSummary= document.getElementById('int-items-summary');
const intSample      = document.getElementById('int-sample');
const intExternalId  = document.getElementById('int-external-id');
const intProjectByField = document.getElementById('int-project-by-field');
const intProjectMode = document.getElementById('int-project-mode');
const intProjectValue= document.getElementById('int-project-value');
const intProjectField= document.getElementById('int-project-field');
const intTextTemplate= document.getElementById('int-text-template');
const intTitlePreview= document.getElementById('int-title-preview');
const intFieldChips  = document.getElementById('int-field-chips');
const intConfigRecap = document.getElementById('int-config-recap');
const intOnUpdate    = document.getElementById('int-on-update');
const intReimportDeleted = document.getElementById('int-reimport-deleted');
const intSchedEnabled = document.getElementById('int-sched-enabled');
const intSchedInterval = document.getElementById('int-sched-interval');
const intPreviewResult = document.getElementById('int-preview-result');
const intBulkBar     = document.getElementById('int-bulk-bar');
const intBulkCount   = document.getElementById('int-bulk-count');
const intBulkProject = document.getElementById('int-bulk-project');
const intBulkProjectApply = document.getElementById('int-bulk-project-apply');
const intBulkWeekday = document.getElementById('int-bulk-weekday');
const intBulkWeekdayApply = document.getElementById('int-bulk-weekday-apply');
const intNewBtn      = document.getElementById('int-new-btn');
const intBackBtn     = document.getElementById('int-back-btn');
const intAddHeader   = document.getElementById('int-add-header');
const intAddQuery    = document.getElementById('int-add-query');
const intFetchBtn    = document.getElementById('int-fetch-btn');
const intFetchStatus = document.getElementById('int-fetch-status');
const intTo3Btn      = document.getElementById('int-to-3-btn');
const intTo4Btn      = document.getElementById('int-to-4-btn');
const intSaveBtn     = document.getElementById('int-save-btn');
const intRunBtn      = document.getElementById('int-run-btn');
const intDeleteBtn   = document.getElementById('int-delete-btn');

// Estado do wizard
let intStep = 1;
let intSampleItem = null;   // item de exemplo vindo do "Buscar dados"
let intFieldsList = [];     // campos detectados do item
let intPreviewRows = [];    // linhas editáveis da prévia (passo 4)
let intPreviewTotal = 0;
let intPreviewSig = '';     // assinatura da config quando a prévia foi gerada

// O prazo agora é uma data real ISO YYYY-MM-DD (ou vazio = sem prazo).
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const TITLE_HINT_FIELDS = ['title', 'subject', 'name', 'nome', 'titulo', 'assunto',
    'summary', 'resumo', 'text', 'texto', 'description', 'descricao'];

function updateTitlePreview() {
    if (!intTitlePreview) return;
    const rendered = intRenderTemplate(intTextTemplate.value, intSampleItem || {}).trim();
    intTitlePreview.textContent = rendered || '—';
}

// ── Navegação ──────────────────────────────────────────────────
export function hideIntegrationsView() {
    if (integrationsView) integrationsView.classList.add('hidden');
}

// Mostra o painel de integrações. A troca de views e o reset de estado
// (currentCategory/WeekDay/Tag, graphStop, esconder outras views) são
// responsabilidade do nav handler no main.js — aqui só abrimos o painel.
export function openIntegrations() {
    if (!integrationsView) return;
    integrationsView.classList.remove('hidden');
    intShowList();
    loadIntegrations();
}

function intShowList() {
    if (intListPanel) intListPanel.classList.remove('hidden');
    if (intEditor)    intEditor.classList.add('hidden');
}

function intShowEditor() {
    if (intListPanel) intListPanel.classList.add('hidden');
    if (intEditor)    intEditor.classList.remove('hidden');
}

function goToStep(n) {
    intStep = n;
    intEditor.querySelectorAll('.int-step-panel').forEach(p => {
        p.classList.toggle('hidden', parseInt(p.dataset.panel, 10) !== n);
    });
    intStepper.querySelectorAll('.int-step').forEach(s => {
        const sn = parseInt(s.dataset.step, 10);
        s.classList.toggle('is-active', sn === n);
        s.classList.toggle('is-done', sn < n);
    });
    if (n === 2 && !intSampleItem && intItemsSummary && !intItemsSummary.innerHTML.trim()) {
        intItemsSummary.innerHTML = '<div class="int-muted">Volte ao passo 1 e clique em "Buscar dados" para carregar os itens da API.</div>';
    }
    if (n === 3) { renderFieldChips(intFieldsList); updateTitlePreview(); }
    if (n === 4) {
        renderConfigRecap();
        // Só regenera a prévia se a configuração mudou (senão preserva os ajustes por linha).
        if (intPreviewRows.length && getPreviewSig() === intPreviewSig) {
            renderPreviewTable();
        } else {
            onPreview();
        }
    }
}

// ── Resumo da configuração (passo 4) ───────────────────────────
function humanAuth(type) {
    return {
        none: 'Nenhuma (API aberta)',
        bearer: 'Token (Bearer)',
        api_key: 'Chave de API (no cabeçalho)',
        query_key: 'Chave/token na URL',
        basic: 'Usuário e senha',
        oauth2: 'OAuth2 (client credentials)',
    }[(type || 'none')] || 'Nenhuma (API aberta)';
}

function humanPagination(pag) {
    pag = pag || {};
    const base = {
        none: 'Sem paginação',
        page: 'Por número de página',
        offset: 'Por offset',
        cursor: 'Por cursor/next',
    }[(pag.mode || 'none')] || 'Sem paginação';
    return pag.mode && pag.mode !== 'none' && pag.max_pages
        ? `${base} (até ${pag.max_pages} páginas)`
        : base;
}

function humanOnUpdate(v) {
    return {
        skip: 'Ignora (não duplica)',
        update_text: 'Atualiza o texto',
        update_all: 'Atualiza texto, projeto e prazo',
    }[(v || 'skip')] || 'Ignora (não duplica)';
}

function renderConfigRecap() {
    if (!intConfigRecap) return;
    const c = getFormConfig();
    const sched = readSchedule();
    const conn = c.connection || {};
    const map = c.mapping || {};
    const proj = map.project || {};
    const upd = humanOnUpdate(c.on_update) + (c.reimport_deleted ? ' • recria excluídas' : '');
    const rows = [
        ['Fonte', (conn.base_url || '—') + (conn.method && conn.method !== 'GET' ? ` (${conn.method})` : '')],
        ['Autenticação', humanAuth((conn.auth || {}).type)],
        ['Paginação', humanPagination(c.pagination)],
        ['Projeto', proj.mode === 'field' ? `do campo "${proj.field || '—'}"` : `"${proj.value || '—'}"`],
        ['Identificador', map.external_id || 'id'],
        ['Se já importado', upd],
        ['Agendamento', sched.enabled && sched.interval_minutes ? `a cada ${sched.interval_minutes} min` : 'manual'],
    ];
    intConfigRecap.innerHTML = rows.map(([k, v]) =>
        `<div class="int-recap-row"><span class="int-recap-key">${escapeHTML(k)}</span><span class="int-recap-val">${escapeHTML(v)}</span></div>`
    ).join('');
}

function getPreviewSig() {
    const c = getFormConfig();
    return JSON.stringify([c.connection, c.items_path, c.mapping]);
}

function intAlertShow(msg, isError, hide) {
    if (!intAlert) return;
    if (hide || !msg) {
        intAlert.classList.add('hidden');
        intAlert.textContent = '';
        return;
    }
    intAlert.textContent = msg;
    intAlert.className = 'auth-alert ' + (isError ? 'auth-alert-error' : 'auth-alert-ok');
    intAlert.classList.remove('hidden');
}

function intValOf(id) {
    const el = document.getElementById(id);
    return el ? el.value : '';
}

// ── Autenticação ───────────────────────────────────────────────
function intAuthFieldRow(label, id, value, type, help) {
    const wrap = document.createElement('div');
    const lbl = document.createElement('label');
    lbl.className = 'auth-label';
    lbl.setAttribute('for', id);
    lbl.textContent = label;
    wrap.appendChild(lbl);
    const inp = document.createElement('input');
    inp.className = 'auth-input';
    inp.id = id;
    inp.type = type || 'text';
    inp.value = value || '';
    inp.autocomplete = 'off';
    wrap.appendChild(inp);
    if (help) {
        const h = document.createElement('p');
        h.className = 'int-step-help';
        h.textContent = help;
        wrap.appendChild(h);
    }
    return wrap;
}

function renderAuthFields(type, vals) {
    vals = vals || {};
    if (!intAuthFields) return;
    intAuthFields.innerHTML = '';
    if (type === 'api_key') {
        intAuthFields.appendChild(intAuthFieldRow('Nome do cabeçalho', 'int-auth-header', vals.header || 'X-API-Key', 'text', 'Geralmente algo como "X-API-Key" ou "apikey".'));
        intAuthFields.appendChild(intAuthFieldRow('Chave', 'int-auth-value', vals.value || '', 'text'));
    } else if (type === 'bearer') {
        intAuthFields.appendChild(intAuthFieldRow('Token de acesso', 'int-auth-token', vals.token || '', 'text', 'Cole o token; ele será enviado como "Authorization: Bearer ...".'));
    } else if (type === 'query_key') {
        intAuthFields.appendChild(intAuthFieldRow('Nome do parâmetro na URL', 'int-auth-param', vals.param || 'api_key', 'text', 'Ex: "api_key" ou "token" — vira ?api_key=...'));
        intAuthFields.appendChild(intAuthFieldRow('Valor da chave/token', 'int-auth-value', vals.value || '', 'text'));
    } else if (type === 'basic') {
        intAuthFields.appendChild(intAuthFieldRow('Usuário', 'int-auth-username', vals.username || '', 'text'));
        intAuthFields.appendChild(intAuthFieldRow('Senha', 'int-auth-password', vals.password || '', 'password'));
    } else if (type === 'oauth2') {
        intAuthFields.appendChild(intAuthFieldRow('URL do token', 'int-auth-token-url', vals.token_url || '', 'text', 'Endpoint que emite o token (grant_type=client_credentials).'));
        intAuthFields.appendChild(intAuthFieldRow('Client ID', 'int-auth-client-id', vals.client_id || '', 'text'));
        intAuthFields.appendChild(intAuthFieldRow('Client Secret', 'int-auth-client-secret', vals.client_secret || '', 'text'));
        intAuthFields.appendChild(intAuthFieldRow('Escopo (opcional)', 'int-auth-scope', vals.scope || '', 'text'));
    }
}

// ── Paginação ──────────────────────────────────────────────────
function renderPagFields(mode, vals) {
    vals = vals || {};
    if (!intPagFields) return;
    intPagFields.innerHTML = '';
    if (mode === 'page' || mode === 'offset') {
        const paramLbl = mode === 'page' ? 'Nome do parâmetro de página' : 'Nome do parâmetro de offset';
        const paramPh = mode === 'page' ? 'page' : 'offset';
        intPagFields.appendChild(intAuthFieldRow(paramLbl, 'int-pag-param', vals.param || paramPh, 'text'));
        const startLbl = mode === 'page' ? 'Página inicial' : 'Offset inicial';
        const startDef = mode === 'page' ? 1 : 0;
        intPagFields.appendChild(intAuthFieldRow(startLbl, 'int-pag-start', (vals.start ?? startDef), 'number'));
        intPagFields.appendChild(intAuthFieldRow('Nome do parâmetro de tamanho (opcional)', 'int-pag-size-param', vals.size_param || (mode === 'offset' ? 'limit' : ''), 'text'));
        intPagFields.appendChild(intAuthFieldRow('Itens por página (tamanho)', 'int-pag-size', (vals.size ?? (mode === 'offset' ? 50 : '')), 'number'));
    } else if (mode === 'cursor') {
        intPagFields.appendChild(intAuthFieldRow('Onde está o próximo cursor/URL na resposta', 'int-pag-next-path', vals.next_path || '', 'text', 'Ex: meta.next ou links.next. Pode ser uma URL completa ou um token.'));
        intPagFields.appendChild(intAuthFieldRow('Nome do parâmetro do cursor (se for token)', 'int-pag-param', vals.param || 'cursor', 'text', 'Ignorado quando a resposta já traz uma URL completa.'));
    }
    if (mode !== 'none') {
        intPagFields.appendChild(intAuthFieldRow('Máximo de páginas a buscar', 'int-pag-max', (vals.max_pages ?? 10), 'number'));
    }
}

function readSchedule() {
    const enabled = !!(intSchedEnabled && intSchedEnabled.checked);
    let interval = parseInt(intSchedInterval ? intSchedInterval.value : '0', 10);
    if (isNaN(interval)) interval = 0;
    return { enabled, interval_minutes: interval };
}

function updateSchedUI() {
    const on = !!(intSchedEnabled && intSchedEnabled.checked);
    if (intSchedInterval) {
        intSchedInterval.disabled = !on;
        intSchedInterval.classList.toggle('is-disabled', !on);
    }
}

function applySchedule(integ) {
    if (intSchedEnabled) intSchedEnabled.checked = !!(integ && integ.schedule_enabled);
    if (intSchedInterval) {
        const iv = integ && integ.schedule_interval_minutes ? integ.schedule_interval_minutes : 60;
        intSchedInterval.value = iv;
    }
    updateSchedUI();
}

function readPagination() {
    const mode = intPagMode ? intPagMode.value : 'none';
    if (!mode || mode === 'none') return { mode: 'none' };
    const pag = { mode };
    const num = (id, def) => {
        const v = parseInt(intValOf(id), 10);
        return isNaN(v) ? def : v;
    };
    if (mode === 'page' || mode === 'offset') {
        pag.param = intValOf('int-pag-param').trim();
        pag.start = num('int-pag-start', mode === 'page' ? 1 : 0);
        const sp = intValOf('int-pag-size-param').trim();
        if (sp) pag.size_param = sp;
        const sz = num('int-pag-size', 0);
        if (sz) pag.size = sz;
    } else if (mode === 'cursor') {
        pag.next_path = intValOf('int-pag-next-path').trim();
        pag.param = intValOf('int-pag-param').trim();
    }
    pag.max_pages = num('int-pag-max', 10);
    return pag;
}

function readAuth() {
    const type = intAuthType.value;
    const auth = { type };
    if (type === 'api_key') {
        auth.header = intValOf('int-auth-header');
        auth.value = intValOf('int-auth-value');
    } else if (type === 'bearer') {
        auth.token = intValOf('int-auth-token');
    } else if (type === 'query_key') {
        auth.param = intValOf('int-auth-param');
        auth.value = intValOf('int-auth-value');
    } else if (type === 'basic') {
        auth.username = intValOf('int-auth-username');
        auth.password = intValOf('int-auth-password');
    } else if (type === 'oauth2') {
        auth.token_url = intValOf('int-auth-token-url');
        auth.client_id = intValOf('int-auth-client-id');
        auth.client_secret = intValOf('int-auth-client-secret');
        auth.scope = intValOf('int-auth-scope');
    }
    return auth;
}

// ── Chave/valor (headers e query) ──────────────────────────────
function kvAddRow(container, key, value) {
    if (!container) return;
    const row = document.createElement('div');
    row.className = 'int-kv-row';
    const kEl = document.createElement('input');
    kEl.className = 'auth-input int-kv-key';
    kEl.type = 'text';
    kEl.placeholder = 'chave';
    kEl.value = key || '';
    const vEl = document.createElement('input');
    vEl.className = 'auth-input int-kv-val';
    vEl.type = 'text';
    vEl.placeholder = 'valor';
    vEl.value = value || '';
    const del = document.createElement('button');
    del.className = 'int-kv-del';
    del.type = 'button';
    del.setAttribute('aria-label', 'Remover');
    del.textContent = '×';
    del.addEventListener('click', () => row.remove());
    row.appendChild(kEl);
    row.appendChild(vEl);
    row.appendChild(del);
    container.appendChild(row);
}

function collectKv(container) {
    const obj = {};
    if (!container) return obj;
    container.querySelectorAll('.int-kv-row').forEach(row => {
        const k = row.querySelector('.int-kv-key').value.trim();
        const v = row.querySelector('.int-kv-val').value;
        if (k) obj[k] = v;
    });
    return obj;
}

// ── Projeto ────────────────────────────────────────────────────
function updateProjectModeUI() {
    const isField = intProjectByField.checked;
    intProjectMode.value = isField ? 'field' : 'fixed';
    intProjectValue.classList.toggle('hidden', isField);
    intProjectField.classList.toggle('hidden', !isField);
}

function syncProjectDropdown(selected) {
    const names = Array.from(document.querySelectorAll('.project-nav'))
        .map(el => normText(el.textContent)).filter(Boolean);
    intProjectValue.innerHTML = '';
    names.forEach(n => {
        const opt = document.createElement('option');
        opt.value = n;
        opt.textContent = n;
        if (n === selected) opt.selected = true;
        intProjectValue.appendChild(opt);
    });
    if (selected && !names.includes(selected)) {
        const opt = document.createElement('option');
        opt.value = selected;
        opt.textContent = selected;
        opt.selected = true;
        intProjectValue.appendChild(opt);
    }
}

// ── Campos: dropdowns e chips ──────────────────────────────────
function fillSelect(select, options, selected) {
    if (!select) return;
    select.innerHTML = '';
    const uniq = [];
    (options || []).forEach(o => { if (uniq.indexOf(o) === -1) uniq.push(o); });
    if (selected && uniq.indexOf(selected) === -1) uniq.unshift(selected);
    uniq.forEach(o => {
        const opt = document.createElement('option');
        opt.value = o;
        opt.textContent = o;
        if (o === selected) opt.selected = true;
        select.appendChild(opt);
    });
}

function guessExternalId(fields) {
    if (fields.indexOf('id') !== -1) return 'id';
    const idLike = fields.find(f => /(^|\.)id$|_id$|uuid|key|codigo|código/i.test(f));
    return idLike || fields[0] || 'id';
}

function guessTitleField(fields) {
    for (const hint of TITLE_HINT_FIELDS) {
        const found = fields.find(f => f.toLowerCase() === hint || f.toLowerCase().endsWith('.' + hint));
        if (found) return found;
    }
    return fields.find(f => f !== 'id') || fields[0] || '';
}

function insertAtCursor(textarea, text) {
    const start = textarea.selectionStart != null ? textarea.selectionStart : textarea.value.length;
    const end = textarea.selectionEnd != null ? textarea.selectionEnd : textarea.value.length;
    const before = textarea.value.slice(0, start);
    const sep = (before && !/\s$/.test(before)) ? ' ' : '';
    const insert = sep + text;
    textarea.value = before + insert + textarea.value.slice(end);
    textarea.focus();
    const pos = start + insert.length;
    textarea.setSelectionRange(pos, pos);
    updateTitlePreview();
}

function renderFieldChips(fields) {
    if (!intFieldChips) return;
    intFieldChips.innerHTML = '';
    (fields || []).forEach(f => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'int-chip';
        chip.textContent = f;
        chip.addEventListener('click', () => insertAtCursor(intTextTemplate, `{{ ${f} }}`));
        intFieldChips.appendChild(chip);
    });
    if (!fields || !fields.length) {
        const span = document.createElement('span');
        span.className = 'int-muted';
        span.textContent = 'Nenhum campo detectado. Volte ao passo 1 e clique em "Buscar dados".';
        intFieldChips.appendChild(span);
    }
}

// ── Serialização form <-> config ───────────────────────────────
function getFormConfig() {
    const isField = intProjectByField.checked;
    const project = isField
        ? { mode: 'field', field: intProjectField.value.trim() }
        : { mode: 'fixed', value: intProjectValue.value };
    return {
        connection: {
            base_url: intUrl.value.trim(),
            path: '',
            method: intMethod.value,
            headers: collectKv(intHeaders),
            query: collectKv(intQuery),
            auth: readAuth(),
            allow_private: intAllowPrivate.checked,
        },
        items_path: intItemsPathSel.value || '',
        mapping: {
            external_id: (intExternalId.value || '').trim() || 'id',
            project: project,
            text_template: intTextTemplate.value,
            // O dia da semana é definido por tarefa na revisão (passo 4).
            due_date: { mode: 'none' },
        },
        on_update: intOnUpdate.value,
        reimport_deleted: !!(intReimportDeleted && intReimportDeleted.checked),
        pagination: readPagination(),
    };
}

function applyConfig(cfg) {
    cfg = cfg || {};
    const conn = cfg.connection || {};
    const map = cfg.mapping || {};
    // Junta base_url + path numa URL única (compatível com configs antigas).
    let url = (conn.base_url || '').trim();
    const path = (conn.path || '').trim();
    if (path) {
        url = url.replace(/\/$/, '') + (path.startsWith('/') ? path : '/' + path);
    }
    intUrl.value = url;
    intMethod.value = (conn.method || 'GET').toUpperCase();
    intAllowPrivate.checked = !!conn.allow_private;
    const auth = conn.auth || { type: 'none' };
    intAuthType.value = auth.type || 'none';
    renderAuthFields(intAuthType.value, auth);
    intHeaders.innerHTML = '';
    Object.entries(conn.headers || {}).forEach(([k, v]) => kvAddRow(intHeaders, k, v));
    intQuery.innerHTML = '';
    Object.entries(conn.query || {}).forEach(([k, v]) => kvAddRow(intQuery, k, v));

    fillSelect(intItemsPathSel, cfg.items_path ? [cfg.items_path] : [], cfg.items_path || '');
    const proj = map.project || { mode: 'fixed' };
    const byField = proj.mode === 'field';
    intProjectByField.checked = byField;
    syncProjectDropdown(byField ? '' : (proj.value || ''));
    intProjectField.value = proj.field || '';
    updateProjectModeUI();

    const savedExt = map.external_id || 'id';
    fillSelect(intExternalId, [savedExt], savedExt);
    intTextTemplate.value = map.text_template || '';
    intOnUpdate.value = cfg.on_update || 'skip';
    if (intReimportDeleted) intReimportDeleted.checked = !!cfg.reimport_deleted;

    const pag = cfg.pagination || { mode: 'none' };
    if (intPagMode) {
        intPagMode.value = pag.mode || 'none';
        renderPagFields(intPagMode.value, pag);
    }
}

function fillForm(integ) {
    intId.value = integ && integ.id ? integ.id : '';
    intName.value = integ && integ.name ? integ.name : '';
    intSampleItem = null;
    intFieldsList = [];
    intPreviewRows = [];
    intPreviewTotal = 0;
    intPreviewSig = '';
    applyConfig((integ && integ.config) || {});
    applySchedule(integ);
    renderFieldChips([]);
    if (intItemsSummary) intItemsSummary.innerHTML = '';
    if (intItemsChoice) intItemsChoice.classList.add('hidden');
    if (intSample) intSample.textContent = '';
    if (intFetchStatus) intFetchStatus.textContent = '';
    if (intPreviewResult) intPreviewResult.innerHTML = '';
    if (intBulkBar) intBulkBar.classList.add('hidden');
    updateTitlePreview();
}

function syncJsonFromForm() {
    if (intJson) intJson.value = JSON.stringify(getFormConfig(), null, 2);
}

// ── Lista ──────────────────────────────────────────────────────
async function loadIntegrations() {
    if (!intListEl) return;
    try {
        const res = await apiFetch('/api/integrations');
        if (!res.ok) return;
        renderIntList(await res.json());
    } catch (e) {
        console.error('Erro ao listar integrações:', e);
    }
}

function intFmtWhen(iso) {
    if (!iso) return '';
    // Backend grava em UTC sem sufixo; força interpretação como UTC.
    const norm = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z';
    const d = new Date(norm);
    if (isNaN(d.getTime())) return '';
    const min = Math.floor((Date.now() - d.getTime()) / 60000);
    if (min < 1) return 'agora mesmo';
    if (min < 60) return `há ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `há ${h} h`;
    const days = Math.floor(h / 24);
    return days === 1 ? 'ontem' : `há ${days} dias`;
}

function intFmtNext(iso) {
    if (!iso) return '';
    const norm = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z';
    const d = new Date(norm);
    if (isNaN(d.getTime())) return '';
    const min = Math.round((d.getTime() - Date.now()) / 60000);
    if (min <= 0) return 'em instantes';
    if (min < 60) return `em ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `em ${h} h`;
    const days = Math.floor(h / 24);
    return days === 1 ? 'amanhã' : `em ${days} dias`;
}

function renderIntList(list) {
    intListEl.innerHTML = '';
    if (!list.length) {
        intEmptyEl.classList.remove('hidden');
        return;
    }
    intEmptyEl.classList.add('hidden');
    list.forEach(integ => {
        const status = integ.last_status || 'never';
        const statusText = status === 'ok' ? 'OK' : (status === 'error' ? 'Erro' : 'Nunca rodou');
        const baseUrl = (integ.config && integ.config.connection && integ.config.connection.base_url) || '';
        const when = intFmtWhen(integ.last_run_at);
        let meta;
        if (status === 'ok') {
            const n = integ.last_item_count || 0;
            meta = `Última importação: ${n} tarefa(s)${when ? ' • ' + when : ''}`;
        } else if (status === 'error') {
            meta = `Falhou${when ? ' ' + when : ''}: ${integ.last_error || 'erro desconhecido'}`;
        } else {
            meta = 'Ainda não foi executada';
        }
        const paused = !integ.enabled;
        let schedLine = '';
        if (paused) {
            schedLine = '<div class="int-card-sched int-card-sched--paused">⏸ Pausada — não roda automaticamente</div>';
        } else if (integ.schedule_enabled && integ.schedule_interval_minutes) {
            const nextWhen = intFmtNext(integ.next_run_at);
            schedLine = `<div class="int-card-sched">⏱ A cada ${integ.schedule_interval_minutes} min${nextWhen ? ' • próxima ' + nextWhen : ''}</div>`;
        }
        const card = document.createElement('div');
        card.className = 'int-card' + (paused ? ' int-card--paused' : '');
        const toggleLabel = paused ? 'Ativar' : 'Pausar';
        const toggleTitle = paused
            ? 'Reativa a integração (volta a rodar no agendamento)'
            : 'Pausa a integração (não roda no agendamento; ainda dá para executar manualmente)';
        card.innerHTML = `
            <div class="int-card-main">
                <div class="int-card-title">${escapeHTML(integ.name)}</div>
                <div class="int-card-sub">${escapeHTML(baseUrl)}</div>
                <div class="int-card-meta int-meta-${escapeHTML(status)}">${escapeHTML(meta)}</div>
                ${schedLine}
            </div>
            <div class="int-card-status int-status-${escapeHTML(status)}">${statusText}</div>
            <div class="int-card-actions">
                <button class="int-text-btn" data-act="edit">Editar</button>
                <button class="int-text-btn" data-act="history">Histórico</button>
                <button class="int-text-btn" data-act="toggle" title="${toggleTitle}">${toggleLabel}</button>
                <button class="int-text-btn int-btn-runcard" data-act="run" title="Re-importa da fonte aplicando as regras automáticas (sem os ajustes manuais da revisão)">Executar</button>
            </div>`;
        card.querySelector('[data-act="edit"]').addEventListener('click', () => openEditorById(integ.id));
        card.querySelector('[data-act="history"]').addEventListener('click', () => openHistory(integ.id, integ.name));
        card.querySelector('[data-act="toggle"]').addEventListener('click', () => toggleEnabled(integ.id, !integ.enabled));
        card.querySelector('[data-act="run"]').addEventListener('click', () => runById(integ.id));
        intListEl.appendChild(card);
    });
}

async function openEditorById(id) {
    try {
        const res = await apiFetch(`/api/integrations/${id}`);
        if (!res.ok) { showToast('Falha ao carregar integração'); return; }
        const integ = await res.json();
        intAlertShow('', false, true);
        fillForm(integ);
        intEditorTitle.textContent = integ.name;
        intRunBtn.textContent = 'Importar agora';
        intDeleteBtn.classList.remove('hidden');
        intShowEditor();
        goToStep(1);
    } catch (e) {
        showToast('Erro ao carregar integração');
    }
}

function openNewIntegration() {
    intAlertShow('', false, true);
    fillForm(null);
    renderAuthFields('none', {});
    intEditorTitle.textContent = 'Nova integração';
    intRunBtn.textContent = 'Salvar e importar agora';
    intDeleteBtn.classList.add('hidden');
    intShowEditor();
    goToStep(1);
}

// ── Passo 1 -> 2: buscar dados e detectar ──────────────────────
function intTestBody() {
    const cfg = getFormConfig();
    const body = { connection: cfg.connection, items_path: cfg.items_path };
    // Ao editar, envia o id para o backend restaurar segredos mascarados.
    if (intId.value) body.id = parseInt(intId.value, 10);
    return body;
}

async function onFetch() {
    if (!intUrl.value.trim()) { intFetchStatus.textContent = 'Informe a URL da API.'; return; }
    intFetchBtn.disabled = true;
    intFetchStatus.textContent = 'Buscando…';
    try {
        const res = await apiFetch('/api/integrations/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(intTestBody()),
        });
        const data = await res.json();
        if (!res.ok) {
            intFetchStatus.innerHTML = `<span class="int-error-inline">${escapeHTML(data.error || 'Falha ao buscar.')}</span>`;
            return;
        }
        applyFetchResult(data);
        intFetchStatus.textContent = '';
        goToStep(2);
    } catch (e) {
        intFetchStatus.innerHTML = '<span class="int-error-inline">Erro de rede ao buscar dados.</span>';
    } finally {
        intFetchBtn.disabled = false;
    }
}

function applyFetchResult(data) {
    const arrays = data.arrays || [];
    // Escolhe automaticamente o array com mais itens (ou o caminho atual, se houver).
    let chosen = intItemsPathSel.value || '';
    const arrayPaths = arrays.map(a => a.path);
    if (!chosen || arrayPaths.indexOf(chosen) === -1) {
        if (arrays.length) {
            chosen = arrays.slice().sort((a, b) => (b.count || 0) - (a.count || 0))[0].path;
        } else {
            chosen = '';
        }
    }
    // Popula dropdown de "onde estão os itens".
    intItemsPathSel.innerHTML = '';
    if (arrays.length) {
        arrays.forEach(a => {
            const opt = document.createElement('option');
            opt.value = a.path;
            opt.textContent = (a.path || '(raiz)') + ` — ${a.count} item(ns)`;
            if (a.path === chosen) opt.selected = true;
            intItemsPathSel.appendChild(opt);
        });
        intItemsChoice.classList.toggle('hidden', arrays.length <= 1);
    } else {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '(resposta inteira)';
        intItemsPathSel.appendChild(opt);
        intItemsChoice.classList.add('hidden');
    }

    intSampleItem = data.sample_item || null;
    intFieldsList = data.fields || [];

    // Resumo amigável.
    const count = data.item_count || 0;
    intItemsSummary.innerHTML = count
        ? `<div class="int-big-count">${count}</div><div class="int-muted">item(ns) encontrado(s) e prontos para virar tarefas.</div>`
        : '<div class="int-muted">Nenhum item encontrado no caminho detectado. Tente ajustar a URL ou escolher outra lista abaixo.</div>';

    // Amostra do item.
    const sampleStr = JSON.stringify(intSampleItem, null, 2) || '';
    intSample.textContent = sampleStr.slice(0, 4000);

    // Auto-seleções amigáveis.
    fillSelect(intExternalId, intFieldsList, guessExternalId(intFieldsList));
    if (!intTextTemplate.value.trim() && intFieldsList.length) {
        const idf = guessExternalId(intFieldsList);
        const titf = guessTitleField(intFieldsList);
        intTextTemplate.value = titf && titf !== idf ? `{{ ${idf} }} — {{ ${titf} }}` : `{{ ${titf || idf} }}`;
    }
    renderFieldChips(intFieldsList);
    updateTitlePreview();
}

async function onItemsPathChange() {
    // Rebusca para atualizar contagem/campos ao trocar a lista de itens.
    try {
        const res = await apiFetch('/api/integrations/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(intTestBody()),
        });
        const data = await res.json();
        if (!res.ok) return;
        intSampleItem = data.sample_item || null;
        intFieldsList = data.fields || [];
        const count = data.item_count || 0;
        intItemsSummary.innerHTML = count
            ? `<div class="int-big-count">${count}</div><div class="int-muted">item(ns) encontrado(s) e prontos para virar tarefas.</div>`
            : '<div class="int-muted">Nenhum item encontrado nesta lista.</div>';
        intSample.textContent = (JSON.stringify(intSampleItem, null, 2) || '').slice(0, 4000);
        fillSelect(intExternalId, intFieldsList, guessExternalId(intFieldsList));
    } catch (e) { /* silencioso */ }
}

// ── Preview interativa ─────────────────────────────────────────
function intProjectNames() {
    return Array.from(document.querySelectorAll('.project-nav'))
        .map(el => normText(el.textContent)).filter(Boolean);
}

function optionsHtml(values, selected) {
    return values.map(v =>
        `<option value="${escapeHTML(v)}"${v === selected ? ' selected' : ''}>${escapeHTML(v || '—')}</option>`
    ).join('');
}

function rowIsValid(r) {
    return !!(r.external_id && (r.project || '').trim() && (r.text || '').trim());
}

async function onPreview() {
    intPreviewResult.innerHTML = '<p class="int-muted">Gerando prévia…</p>';
    if (intBulkBar) intBulkBar.classList.add('hidden');
    const body = { config: getFormConfig() };
    if (intId.value) body.id = parseInt(intId.value, 10);
    try {
        const res = await apiFetch('/api/integrations/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
            intPreviewResult.innerHTML = `<div class="int-error">${escapeHTML(data.error || 'Falha na prévia.')}</div>`;
            return;
        }
        intPreviewTotal = data.total_items || 0;
        intPreviewRows = (data.preview || []).map(r => ({
            external_id: r.external_id || '',
            project: r.project || '',
            text: r.text || '',
            due_date: ISO_DATE_RE.test(r.due_date || '') ? r.due_date : '',
            include: !!r.valid,
        }));
        intPreviewSig = getPreviewSig();
        renderPreviewTable();
    } catch (e) {
        intPreviewResult.innerHTML = '<div class="int-error">Erro de rede na prévia.</div>';
    }
}

function renderPreviewTable() {
    if (!intPreviewRows.length) {
        intPreviewResult.innerHTML = '<p class="int-muted">Nenhum item para importar. Revise os passos anteriores.</p>';
        if (intBulkBar) intBulkBar.classList.add('hidden');
        return;
    }
    const projects = intProjectNames();
    const shown = intPreviewRows.length;
    let html = `<div class="int-preview-head"><span class="int-muted">${intPreviewTotal} item(ns) no total • exibindo ${shown}. Ajuste o que quiser antes de importar.</span>` +
        '<button id="int-reload-preview" class="int-text-btn" type="button" title="Descarta ajustes e busca de novo da fonte">↻ Recarregar da fonte</button></div>';
    if (intPreviewTotal > shown) {
        html += `<div class="int-warn">Mostrando os primeiros ${shown} de ${intPreviewTotal} itens. O assistente importa apenas os exibidos; para importar todos de uma vez (aplicando as regras automáticas), use "Executar" na lista.</div>`;
    }
    html += '<table class="int-table int-table-edit"><thead><tr>' +
        '<th class="int-col-check"><input type="checkbox" id="int-check-all" title="Selecionar todas"></th>' +
        '<th>Identificador</th><th>Projeto</th><th>Prazo</th><th>Texto da tarefa</th><th></th>' +
        '</tr></thead><tbody>';
    intPreviewRows.forEach((r, i) => {
        const valid = rowIsValid(r);
        // Monta as opções de projeto garantindo que o valor atual (mesmo vazio
        // ou vindo de um campo) apareça e fique selecionado, sem desalinhar do estado.
        const projValues = [];
        if (!r.project) projValues.push('');
        if (r.project && projects.indexOf(r.project) === -1) projValues.push(r.project);
        projects.forEach(p => projValues.push(p));
        const projOpts = optionsHtml(projValues, r.project);
        const dueVal = ISO_DATE_RE.test(r.due_date || '') ? r.due_date : '';
        html += `<tr class="${valid ? '' : 'int-row-invalid'}" data-i="${i}">
            <td class="int-col-check"><input type="checkbox" class="int-row-check" ${r.include ? 'checked' : ''}></td>
            <td>${escapeHTML(r.external_id)}</td>
            <td><select class="auth-input int-cell-select int-cell-project">${projOpts}</select></td>
            <td><input type="date" class="auth-input int-cell-date" value="${escapeHTML(dueVal)}"></td>
            <td class="int-cell-text" title="${escapeHTML(r.text)}">${escapeHTML(r.text)}</td>
            <td>${valid ? '✓' : '⚠'}</td></tr>`;
    });
    html += '</tbody></table>';
    intPreviewResult.innerHTML = html;

    // Liga os eventos das células.
    intPreviewResult.querySelectorAll('tr[data-i]').forEach(tr => {
        const i = parseInt(tr.dataset.i, 10);
        tr.querySelector('.int-row-check').addEventListener('change', (e) => {
            intPreviewRows[i].include = e.target.checked;
            updateBulkCount();
        });
        tr.querySelector('.int-cell-project').addEventListener('change', (e) => {
            intPreviewRows[i].project = e.target.value;
            tr.classList.toggle('int-row-invalid', !rowIsValid(intPreviewRows[i]));
            tr.querySelector('td:last-child').textContent = rowIsValid(intPreviewRows[i]) ? '✓' : '⚠';
        });
        tr.querySelector('.int-cell-date').addEventListener('change', (e) => {
            intPreviewRows[i].due_date = e.target.value;
        });
    });
    const checkAll = document.getElementById('int-check-all');
    if (checkAll) {
        checkAll.addEventListener('change', (e) => {
            const on = e.target.checked;
            intPreviewRows.forEach(r => { r.include = on; });
            intPreviewResult.querySelectorAll('.int-row-check').forEach(cb => { cb.checked = on; });
            updateBulkCount();
        });
    }
    const reloadBtn = document.getElementById('int-reload-preview');
    if (reloadBtn) reloadBtn.addEventListener('click', () => onPreview());

    // Barra de ações em massa.
    if (intBulkBar) {
        intBulkBar.classList.remove('hidden');
        fillSelect(intBulkProject, projects, projects[0] || '');
    }
    updateBulkCount();
}

function updateBulkCount() {
    if (!intBulkCount) return;
    const n = intPreviewRows.filter(r => r.include).length;
    intBulkCount.textContent = `${n} selecionada(s)`;
}

function applyBulkProject() {
    const proj = intBulkProject.value;
    if (!proj) return;
    let changed = 0;
    intPreviewRows.forEach(r => { if (r.include) { r.project = proj; changed++; } });
    if (changed) { renderPreviewTable(); showToast(`${changed} tarefa(s) movida(s) para "${proj}"`); }
}

function applyBulkWeekday() {
    const due = intBulkWeekday.value; // input type=date -> ISO ou ''
    if (due && !ISO_DATE_RE.test(due)) return;
    let changed = 0;
    intPreviewRows.forEach(r => { if (r.include) { r.due_date = due; changed++; } });
    if (changed) { renderPreviewTable(); showToast(`Prazo atualizado em ${changed} tarefa(s)`); }
}

// ── Salvar / executar / excluir ────────────────────────────────
async function saveIntegration() {
    const name = intName.value.trim();
    if (!name) { intAlertShow('Dê um nome à integração (passo 1).', true); return null; }
    const config = getFormConfig();
    const schedule = readSchedule();
    const editingId = intId.value ? parseInt(intId.value, 10) : null;
    const payload = { name, config, schedule };
    const res = editingId
        ? await apiFetch(`/api/integrations/${editingId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
        : await apiFetch('/api/integrations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
    const data = await res.json();
    if (!res.ok) { intAlertShow(data.error || 'Falha ao salvar.', true); return null; }
    if (!editingId && data.id) intId.value = data.id;
    intEditorTitle.textContent = name;
    intDeleteBtn.classList.remove('hidden');
    intRunBtn.textContent = 'Importar agora';
    return parseInt(intId.value, 10);
}

async function onSave() {
    intSetBusy(true);
    try {
        const id = await saveIntegration();
        if (id) {
            const sched = readSchedule();
            const msg = sched.enabled && sched.interval_minutes
                ? `Integração salva • agendada a cada ${sched.interval_minutes} min`
                : 'Integração salva';
            intAlertShow(msg, false);
            showToast(msg);
            loadIntegrations();
        }
    } catch (e) {
        intAlertShow('Erro de rede ao salvar.', true);
    } finally {
        intSetBusy(false);
    }
}

function intSetBusy(busy) {
    [intSaveBtn, intRunBtn, intDeleteBtn].forEach(b => { if (b) b.disabled = busy; });
}

async function onImport() {
    const chosen = intPreviewRows.filter(r => r.include && rowIsValid(r));
    if (!chosen.length) {
        intAlertShow('Selecione ao menos uma tarefa válida para importar.', true);
        return;
    }
    intSetBusy(true);
    try {
        const id = await saveIntegration();
        if (!id) return;
        intAlertShow('Importando…', false);
        const items = chosen.map(r => ({
            external_id: r.external_id,
            project: r.project,
            text: r.text,
            due_date: r.due_date,
        }));
        const res = await apiFetch(`/api/integrations/${id}/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items,
                on_update: intOnUpdate.value,
                reimport_deleted: !!(intReimportDeleted && intReimportDeleted.checked),
            }),
        });
        const data = await res.json();
        if (!res.ok) { intAlertShow(data.error || 'Falha ao importar.', true); return; }
        const parts = [`${data.created} criada(s)`];
        if (data.updated) parts.push(`${data.updated} atualizada(s)`);
        if (data.skipped) parts.push(`${data.skipped} ignorada(s)`);
        showToast('Importado: ' + parts.join(' • '));
        notifyTasksChanged();
        intAlertShow('', false, true);
        intShowList();
        loadIntegrations();
    } catch (e) {
        intAlertShow('Erro de rede ao importar.', true);
    } finally {
        intSetBusy(false);
    }
}

async function toggleEnabled(id, enabled) {
    try {
        const res = await apiFetch(`/api/integrations/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled }),
        });
        if (!res.ok) { showToast('Falha ao atualizar'); return; }
        showToast(enabled ? 'Integração reativada' : 'Integração pausada');
        loadIntegrations();
    } catch (e) {
        showToast('Erro de rede');
    }
}

async function runById(id) {
    showToast('Executando integração…');
    try {
        const res = await apiFetch(`/api/integrations/${id}/run`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) { showToast(data.error || 'Falha ao executar'); return; }
        const parts = [`${data.created} criada(s)`];
        if (data.updated) parts.push(`${data.updated} atualizada(s)`);
        if (data.skipped) parts.push(`${data.skipped} ignorada(s)`);
        showToast('Importado: ' + parts.join(' • '));
        notifyTasksChanged();
        loadIntegrations();
        if (intHistoryCurrent && intHistoryCurrent.id === id) loadHistory();
    } catch (e) {
        showToast('Erro ao executar');
    }
}

// ── Histórico de execuções ─────────────────────────────────────
const intHistoryOverlay = document.getElementById('int-history-overlay');
const intHistoryBody    = document.getElementById('int-history-body');
const intHistoryTitle   = document.getElementById('int-history-title');
const intHistoryClose   = document.getElementById('int-history-close');
const intHistoryRefresh = document.getElementById('int-history-refresh');
let intHistoryCurrent   = null;

function intTriggerLabel(t) {
    if (t === 'import') return 'Revisão manual';
    if (t === 'schedule') return 'Agendado';
    return 'Manual';
}

function renderRuns(runs) {
    if (!runs.length) {
        intHistoryBody.innerHTML = '<p class="int-muted">Nenhuma execução registrada ainda.</p>';
        return;
    }
    const rows = runs.map(r => {
        const when = intFmtWhen(r.finished_at || r.started_at) || '';
        const st = r.status === 'ok' ? 'ok' : 'error';
        const stText = r.status === 'ok' ? 'OK' : 'Erro';
        const detail = r.status === 'ok'
            ? `${r.created} criada(s) • ${r.updated} atualizada(s) • ${r.skipped} ignorada(s)`
            : escapeHTML(r.error || 'erro desconhecido');
        return `
            <div class="int-run-row">
                <span class="int-run-status int-status-${st}">${stText}</span>
                <div class="int-run-info">
                    <div class="int-run-detail">${detail}</div>
                    <div class="int-run-meta">${escapeHTML(intTriggerLabel(r.trigger))}${when ? ' • ' + when : ''} • ${r.total_items} item(ns)</div>
                </div>
            </div>`;
    }).join('');
    intHistoryBody.innerHTML = rows;
}

async function loadHistory() {
    if (!intHistoryCurrent) return;
    intHistoryBody.innerHTML = '<p class="int-muted">Carregando…</p>';
    try {
        const res = await apiFetch(`/api/integrations/${intHistoryCurrent.id}/runs?limit=50`);
        const data = await res.json();
        if (!res.ok) {
            intHistoryBody.innerHTML = `<p class="int-error-inline">${escapeHTML(data.error || 'Falha ao carregar histórico.')}</p>`;
            return;
        }
        renderRuns(data);
    } catch (e) {
        intHistoryBody.innerHTML = '<p class="int-error-inline">Erro de rede ao carregar histórico.</p>';
    }
}

let closeHistoryModal = null;

function openHistory(id, name) {
    if (!intHistoryOverlay) return;
    intHistoryCurrent = { id, name };
    intHistoryTitle.textContent = `Histórico — ${name}`;
    closeHistoryModal = openModal(intHistoryOverlay, { initialFocus: intHistoryClose });
    loadHistory();
}

function closeHistory() {
    if (closeHistoryModal) closeHistoryModal();
    closeHistoryModal = null;
    intHistoryCurrent = null;
}

async function onDelete() {
    if (!intId.value) return;
    const ok = await confirmModal(
        'Excluir integração?',
        'A configuração será removida. As tarefas já criadas permanecem.'
    );
    if (!ok) return;
    try {
        const res = await apiFetch(`/api/integrations/${parseInt(intId.value, 10)}`, { method: 'DELETE' });
        if (res.ok) {
            showToast('Integração excluída');
            intShowList();
            loadIntegrations();
        } else {
            intAlertShow('Falha ao excluir.', true);
        }
    } catch (e) {
        intAlertShow('Erro de rede ao excluir.', true);
    }
}

// ── Listeners ──────────────────────────────────────────────────
if (integrationsView) {
    intNewBtn.addEventListener('click', openNewIntegration);
    intBackBtn.addEventListener('click', () => { intShowList(); loadIntegrations(); });
    intAuthType.addEventListener('change', () => renderAuthFields(intAuthType.value, {}));
    if (intPagMode) intPagMode.addEventListener('change', () => renderPagFields(intPagMode.value, {}));
    if (intSchedEnabled) intSchedEnabled.addEventListener('change', updateSchedUI);
    intAddHeader.addEventListener('click', () => kvAddRow(intHeaders, '', ''));
    intAddQuery.addEventListener('click', () => kvAddRow(intQuery, '', ''));
    intProjectByField.addEventListener('change', updateProjectModeUI);
    intFetchBtn.addEventListener('click', onFetch);
    intItemsPathSel.addEventListener('change', onItemsPathChange);
    intTo3Btn.addEventListener('click', () => goToStep(3));
    intTo4Btn.addEventListener('click', () => goToStep(4));
    intTextTemplate.addEventListener('input', updateTitlePreview);
    intSaveBtn.addEventListener('click', onSave);
    intRunBtn.addEventListener('click', onImport);
    intDeleteBtn.addEventListener('click', onDelete);
    if (intBulkProjectApply) intBulkProjectApply.addEventListener('click', applyBulkProject);
    if (intBulkWeekdayApply) intBulkWeekdayApply.addEventListener('click', applyBulkWeekday);

    if (intHistoryClose) intHistoryClose.addEventListener('click', closeHistory);
    if (intHistoryRefresh) intHistoryRefresh.addEventListener('click', loadHistory);
    if (intHistoryOverlay) {
        intHistoryOverlay.addEventListener('click', (e) => {
            if (e.target === intHistoryOverlay) closeHistory();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !intHistoryOverlay.classList.contains('hidden')) {
                closeHistory();
            }
        });
    }

    // Navegação livre pelos números do stepper.
    intStepper.querySelectorAll('.int-step').forEach(s => {
        s.addEventListener('click', () => goToStep(parseInt(s.dataset.step, 10)));
    });
    // Botões "← Voltar" internos dos passos.
    intEditor.querySelectorAll('[data-goto]').forEach(b => {
        b.addEventListener('click', () => goToStep(parseInt(b.dataset.goto, 10)));
    });

    // JSON avançado: preencher ao abrir, aplicar ao clicar.
    const jsonDetails = document.querySelector('.int-json-advanced');
    if (jsonDetails) {
        jsonDetails.addEventListener('toggle', () => { if (jsonDetails.open) syncJsonFromForm(); });
    }
    if (intJsonApply) {
        intJsonApply.addEventListener('click', () => {
            try {
                applyConfig(JSON.parse(intJson.value));
                intAlertShow('JSON aplicado ao formulário.', false);
            } catch (e) {
                intAlertShow('JSON inválido.', true);
            }
        });
    }
}
