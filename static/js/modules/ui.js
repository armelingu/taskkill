/**
 * Componentes de UI genéricos e sem estado de aplicação: toasts e modal de
 * confirmação. Dependem apenas do DOM já presente em index.html.
 */

import { trapFocus } from './focus.js';

/**
 * Notificação efêmera. Compatível com `showToast('texto')` e com opções:
 *   showToast('Removida', { variant: 'success', action: { label: 'Desfazer', onClick } })
 * @param {string} message
 * @param {{ variant?: 'default'|'success'|'error', duration?: number,
 *           action?: { label: string, onClick: () => void } }} [opts]
 */
export function showToast(message, opts = {}) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const { variant = 'default', action = null } = opts;
    // Ações merecem mais tempo de leitura/decisão que um aviso simples.
    const duration = opts.duration || (action ? 6000 : 3000);

    const toast = document.createElement('div');
    toast.className = `toast toast--${variant}`;
    toast.setAttribute('role', 'status');

    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = message;
    toast.appendChild(text);

    let dismissed = false;
    let timer = null;
    const dismiss = () => {
        if (dismissed) return;
        dismissed = true;
        if (timer) clearTimeout(timer);
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300); // casa com a transição CSS
    };
    const arm = () => { timer = setTimeout(dismiss, duration); };

    if (action && typeof action.onClick === 'function') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'toast-action';
        btn.textContent = action.label || 'Desfazer';
        btn.addEventListener('click', () => { action.onClick(); dismiss(); });
        toast.appendChild(btn);
    }

    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));

    // Pausa a contagem ao passar o mouse (permite ler/clicar com calma).
    toast.addEventListener('mouseenter', () => { if (timer) clearTimeout(timer); });
    toast.addEventListener('mouseleave', () => { if (!dismissed) arm(); });

    arm();
    return { dismiss };
}

// Modal de confirmação (Promise<boolean>). Fallback para window.confirm.
export function confirmModal(title, body) {
    return new Promise(resolve => {
        const overlay  = document.getElementById('project-confirm-overlay');
        const titleEl  = document.getElementById('project-confirm-title');
        const bodyEl   = document.getElementById('project-confirm-body');
        const btnOk    = document.getElementById('project-confirm-ok');
        const btnCancel = document.getElementById('project-confirm-cancel');
        if (!overlay) { resolve(window.confirm(title)); return; }

        titleEl.textContent = title;
        bodyEl.textContent  = body;

        const previouslyFocused = document.activeElement;
        overlay.classList.remove('hidden');
        const releaseTrap = trapFocus(overlay);
        btnOk.focus();

        const cleanup = (result) => {
            releaseTrap();
            overlay.classList.add('hidden');
            btnOk.removeEventListener('click', onOk);
            btnCancel.removeEventListener('click', onCancel);
            overlay.removeEventListener('click', onOverlay);
            document.removeEventListener('keydown', onKey);
            if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
                previouslyFocused.focus();
            }
            resolve(result);
        };
        const onOk      = () => cleanup(true);
        const onCancel  = () => cleanup(false);
        const onOverlay = (e) => { if (e.target === overlay) cleanup(false); };
        const onKey     = (e) => { if (e.key === 'Escape') cleanup(false); };

        btnOk.addEventListener('click', onOk);
        btnCancel.addEventListener('click', onCancel);
        overlay.addEventListener('click', onOverlay);
        document.addEventListener('keydown', onKey);
    });
}
