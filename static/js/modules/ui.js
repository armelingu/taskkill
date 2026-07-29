/**
 * Componentes de UI genéricos e sem estado de aplicação: toasts e modal de
 * confirmação. Dependem apenas do DOM já presente em index.html.
 */

// Notificação efêmera (some sozinha em ~3s).
export function showToast(message) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;

    container.appendChild(toast);

    // Reflow para ativar a transição CSS, depois adiciona 'show'.
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });

    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
            toast.remove();
        }, 300); // duração da transição CSS
    }, 3000);
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
        overlay.classList.remove('hidden');
        btnOk.focus();

        const cleanup = (result) => {
            overlay.classList.add('hidden');
            btnOk.removeEventListener('click', onOk);
            btnCancel.removeEventListener('click', onCancel);
            overlay.removeEventListener('click', onOverlay);
            document.removeEventListener('keydown', onKey);
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
