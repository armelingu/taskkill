/**
 * Helpers de template do lado do cliente. ESPELHAM a lógica do backend
 * (integrations.resolve_path / render_template) para a prévia ao vivo do
 * assistente de integrações. Mantê-los aqui, puros e testados, garante que a
 * prévia case com o que o servidor realmente vai gerar.
 */

// Acessa um valor aninhado via 'a.b.0.c' (suporta índices de lista).
export function intResolvePath(obj, path) {
    if (path === null || path === undefined || path === '') return obj;
    let cur = obj;
    const parts = String(path).replace(/\[/g, '.').replace(/\]/g, '').split('.');
    for (let p of parts) {
        p = p.trim();
        if (p === '') continue;
        if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
            if (!(p in cur)) return null;
            cur = cur[p];
        } else if (Array.isArray(cur)) {
            const i = parseInt(p, 10);
            if (isNaN(i) || i < 0 || i >= cur.length) return null;
            cur = cur[i];
        } else {
            return null;
        }
    }
    return cur;
}

// Substitui apenas {{ campo }} pelo valor do item. Nunca executa código.
export function intRenderTemplate(tpl, item) {
    if (!tpl) return '';
    return String(tpl).replace(/\{\{\s*([\w.\[\]]+)\s*\}\}/g, (m, g) => {
        const v = intResolvePath(item, g);
        if (v === null || v === undefined) return '';
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        if (typeof v === 'object') return JSON.stringify(v);
        return String(v);
    });
}
