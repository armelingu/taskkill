/*
 * theme-boot.js — resolve o tema ANTES da primeira pintura (anti-FOUC).
 *
 * Script externo e bloqueante (não é module) porque a CSP usa
 * `script-src 'self'`, que proíbe script inline. Deve ser incluído no <head>,
 * antes do CSS, tanto no app quanto na tela de login (funciona pré-auth).
 *
 * Lê localStorage['taskkill-theme'] com os valores 'light' | 'dark' | 'system'
 * (default 'system') e resolve 'system' via prefers-color-scheme, aplicando
 * data-theme no <html>.
 */
(function () {
    var KEY = 'taskkill-theme';
    try {
        var mode = localStorage.getItem(KEY) || 'system';
        if (mode !== 'light' && mode !== 'dark' && mode !== 'system') {
            mode = 'system';
        }
        var resolved = mode;
        if (mode === 'system') {
            resolved = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
                ? 'dark'
                : 'light';
        }
        document.documentElement.setAttribute('data-theme', resolved);
    } catch (e) {
        document.documentElement.setAttribute('data-theme', 'light');
    }
})();
