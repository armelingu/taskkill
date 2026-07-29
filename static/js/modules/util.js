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
