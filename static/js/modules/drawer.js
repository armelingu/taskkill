/**
 * Drawer off-canvas da sidebar (apenas mobile). No desktop a sidebar é fixa e
 * este módulo fica inerte — a classe `sidebar-open` só tem efeito visual dentro
 * do breakpoint mobile (ver style.css).
 *
 * Acessibilidade: focus-trap enquanto aberto, retorno de foco ao botão que
 * abriu, ESC e clique no backdrop fecham. Ao navegar (clicar num item do menu,
 * projeto, dia da semana ou perfil), o drawer fecha sozinho.
 */

import { trapFocus, getFocusable } from './focus.js';

const MOBILE_QUERY = '(max-width: 860px)';

export function initDrawer() {
    const toggle = document.getElementById('sidebar-toggle');
    const sidebar = document.getElementById('app-sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (!toggle || !sidebar || !backdrop) return;

    const mq = window.matchMedia(MOBILE_QUERY);
    const isMobile = () => mq.matches;

    let open = false;
    let releaseTrap = null;
    let previouslyFocused = null;

    function openDrawer() {
        if (open || !isMobile()) return;
        open = true;
        previouslyFocused = document.activeElement;
        document.body.classList.add('sidebar-open');
        backdrop.hidden = false;
        toggle.setAttribute('aria-expanded', 'true');
        releaseTrap = trapFocus(sidebar);
        const first = getFocusable(sidebar)[0];
        if (first && typeof first.focus === 'function') first.focus();
    }

    function closeDrawer(restoreFocus = true) {
        if (!open) return;
        open = false;
        document.body.classList.remove('sidebar-open');
        backdrop.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
        if (releaseTrap) { releaseTrap(); releaseTrap = null; }
        if (restoreFocus && previouslyFocused && typeof previouslyFocused.focus === 'function') {
            previouslyFocused.focus();
        }
        previouslyFocused = null;
    }

    toggle.addEventListener('click', () => (open ? closeDrawer() : openDrawer()));
    backdrop.addEventListener('click', () => closeDrawer());

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && open) closeDrawer();
    });

    // Fecha ao acionar algo que troca de visão (mas não os controles de semana
    // nem o botão de adicionar projeto, que permanecem dentro do drawer).
    sidebar.addEventListener('click', (e) => {
        if (!open) return;
        const nav = e.target.closest(
            '.skeleton-item, .project-nav, .week-day, #nav-perfil, #sidebar-logout-trigger'
        );
        if (nav) closeDrawer(false);
    });

    // Se a viewport sair do modo mobile com o drawer aberto, limpa o estado.
    const onChange = () => { if (!isMobile()) closeDrawer(false); };
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
    else if (typeof mq.addListener === 'function') mq.addListener(onChange);
}
