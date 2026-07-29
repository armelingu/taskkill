/**
 * Camada de acesso à API: injeta o token CSRF e as credenciais de sessão.
 * O backend exige X-CSRF-Token em POST/PUT/DELETE de /api (ver routes.py).
 */

// CSRF token por sessão, lido da <meta name="csrf-token"> em index.html.
export function getCsrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? (meta.getAttribute('content') || '') : '';
}

// fetch com CSRF + cookies de sessão. Mesma assinatura do fetch nativo.
export function apiFetch(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {}, {
        'X-CSRF-Token': getCsrfToken(),
    });
    return fetch(path, Object.assign({}, opts, { headers, credentials: 'same-origin' }));
}
