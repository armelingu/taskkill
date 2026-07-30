/**
 * Utilitários puros (sem estado da aplicação, sem dependências de módulos).
 * Fáceis de testar isoladamente (ver tests/js/util.test.mjs).
 */

// Sanitização contra XSS: neutraliza caracteres perigosos antes de ir ao DOM.
export function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g,
        tag => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        }[tag] || tag)
    );
}

// Normaliza espaços em branco (colapsa e apara).
export function normText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
}

// Formata ISO -> "27 jul 2026 · 20:14" (ou "—" se inválido).
export function pfFmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    const data = d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
    const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `${data} · ${hora}`;
}

// ── Datas (ISO YYYY-MM-DD, timezone-safe via componentes locais) ──────
const _WEEKDAYS_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const _MONTHS_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun',
                       'jul', 'ago', 'set', 'out', 'nov', 'dez'];

// Constrói uma Date LOCAL a partir de 'YYYY-MM-DD' (evita o parse UTC do
// construtor de string, que desloca o dia dependendo do fuso).
function _parseISO(iso) {
    if (!iso) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
}

function _toISO(d) {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    return `${y}-${mo}-${da}`;
}

// Data de hoje (local) como 'YYYY-MM-DD'.
export function todayISO() {
    return _toISO(new Date());
}

// Segunda-feira da semana que contém `iso` (semana começa na segunda).
export function startOfWeekISO(iso) {
    const d = _parseISO(iso) || new Date();
    const mondayOffset = (d.getDay() + 6) % 7; // 0=Seg … 6=Dom
    d.setDate(d.getDate() - mondayOffset);
    return _toISO(d);
}

// Soma `n` dias a uma data ISO e devolve nova ISO.
export function addDaysISO(iso, n) {
    const d = _parseISO(iso);
    if (!d) return iso;
    d.setDate(d.getDate() + n);
    return _toISO(d);
}

// Formata ISO -> 'dd/mm' (ou '' se inválido).
export function formatBR(iso) {
    const d = _parseISO(iso);
    if (!d) return '';
    const da = String(d.getDate()).padStart(2, '0');
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    return `${da}/${mo}`;
}

// Rótulo curto do dia da semana de uma data ISO ('Seg'…'Dom' / 'Sáb').
export function weekdayShort(iso) {
    const d = _parseISO(iso);
    if (!d) return '';
    return _WEEKDAYS_SHORT[d.getDay()];
}

const _WEEKDAYS_LONG = ['Domingo', 'Segunda', 'Terça', 'Quarta',
                        'Quinta', 'Sexta', 'Sábado'];

// Nome completo do dia da semana de uma data ISO ('Segunda'…'Domingo').
export function weekdayLong(iso) {
    const d = _parseISO(iso);
    if (!d) return '';
    return _WEEKDAYS_LONG[d.getDay()];
}

// Nome curto do mês (para o cabeçalho da semana), ex.: 'ago'.
export function monthShort(iso) {
    const d = _parseISO(iso);
    if (!d) return '';
    return _MONTHS_SHORT[d.getMonth()];
}

// Dispara o download de um Blob no navegador.
export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'taskkill-backup.db';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
