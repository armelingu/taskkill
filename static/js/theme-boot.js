/*
 * theme-boot.js — resolve o tema ANTES da primeira pintura (anti-FOUC).
 *
 * Script externo e bloqueante (não é module) porque a CSP usa
 * `script-src 'self'`, que proíbe script inline. Deve ser incluído no <head>,
 * antes do CSS, tanto no app quanto na tela de login (funciona pré-auth).
 *
 * Fonte de verdade: a preferência salva no servidor, injetada em
 * <html data-theme-mode="..."> (sincroniza entre dispositivos). Se ausente
 * (ex.: tela de login pré-auth), cai para localStorage['taskkill-theme'].
 * Valores: 'light' | 'dark' | 'system' (default 'system'); 'system' é resolvido
 * via prefers-color-scheme. Aplica data-theme no <html>.
 */
(function () {
    var KEY = 'taskkill-theme';
    var VALID = { light: 1, dark: 1, system: 1 };
    try {
        var serverMode = document.documentElement.getAttribute('data-theme-mode');
        var mode = (serverMode && VALID[serverMode]) ? serverMode : (localStorage.getItem(KEY) || 'system');
        if (!VALID[mode]) {
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
