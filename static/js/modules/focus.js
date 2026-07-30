/**
 * Utilitários de foco para acessibilidade de overlays/diálogos:
 *  - focus-trap: mantém o Tab/Shift+Tab dentro do container enquanto aberto
 *  - retorno de foco: ao fechar, devolve o foco ao elemento que abriu
 *
 * Sem estado global; cada overlay recebe seu próprio ciclo open/close.
 */

const FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled])',
    'select:not([disabled])', 'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

// Elementos focáveis atualmente visíveis dentro do container.
export function getFocusable(container) {
    if (!container) return [];
    return Array.from(container.querySelectorAll(FOCUSABLE))
        .filter(el => !el.hasAttribute('disabled') && el.offsetParent !== null);
}

// Prende o foco dentro do container. Retorna uma função para liberar o trap.
export function trapFocus(container) {
    const onKey = (e) => {
        if (e.key !== 'Tab') return;
        const items = getFocusable(container);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !container.contains(active))) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && active === last) {
            e.preventDefault();
            first.focus();
        }
    };
    container.addEventListener('keydown', onKey);
    return () => container.removeEventListener('keydown', onKey);
}

/**
 * Abre um overlay com focus-trap e retorno de foco.
 * @param {HTMLElement} overlay elemento com a classe .hidden como estado fechado
 * @param {{ initialFocus?: HTMLElement }} [opts]
 * @returns {() => void} função close() idempotente
 */
export function openModal(overlay, opts = {}) {
    if (!overlay) return () => {};
    const previouslyFocused = document.activeElement;
    overlay.classList.remove('hidden');
    const release = trapFocus(overlay);

    const target = opts.initialFocus || getFocusable(overlay)[0];
    if (target && typeof target.focus === 'function') target.focus();

    let closed = false;
    return function close() {
        if (closed) return;
        closed = true;
        release();
        overlay.classList.add('hidden');
        if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
            previouslyFocused.focus();
        }
    };
}
