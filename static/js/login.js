(function () {
    // Mostrar/ocultar senha
    const btn = document.getElementById('toggle-pw');
    const inp = document.getElementById('password');
    const eyeShow = document.getElementById('eye-show');
    const eyeHide = document.getElementById('eye-hide');
    if (btn && inp) {
        btn.addEventListener('click', () => {
            const shown = inp.type === 'text';
            inp.type = shown ? 'password' : 'text';
            if (eyeShow) eyeShow.style.display = shown ? '' : 'none';
            if (eyeHide) eyeHide.style.display = shown ? 'none' : '';
            btn.setAttribute('aria-label', shown ? 'Mostrar senha' : 'Ocultar senha');
        });
    }

    // Estado de carregando no botão ao enviar (login e cadastro compartilham)
    const form = document.querySelector('.auth-form');
    const submit = form ? form.querySelector('.auth-btn') : null;
    if (form && submit) {
        form.addEventListener('submit', () => {
            submit.classList.add('is-loading');
            submit.setAttribute('aria-busy', 'true');
            // desabilita após o envio ser disparado (não bloqueia o POST)
            setTimeout(() => { submit.disabled = true; }, 0);
        });
    }

    // Animação de fundo: tarefas sendo concluídas
    const bg = document.getElementById('auth-bg');
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (bg && !reduce) {
        const COUNT = 18;
        const CHECK = '<svg class="auth-task-check" viewBox="0 0 24 24" fill="none" aria-hidden="true">'
            + '<path d="M5 12.5l4 4 10-10" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        const rand = (min, max) => min + Math.random() * (max - min);
        for (let i = 0; i < COUNT; i++) {
            const t = document.createElement('div');
            t.className = 'auth-task';
            // Profundidade: tarefas maiores/mais opacas parecem "próximas",
            // menores/mais transparentes ficam ao fundo.
            const sz = rand(10, 18);
            const depth = (sz - 10) / 8; // 0 (fundo) .. 1 (frente)
            t.style.top = rand(2, 92).toFixed(1) + '%';
            t.style.left = rand(1, 80).toFixed(1) + '%';
            t.style.setProperty('--sz', sz.toFixed(1) + 'px');
            t.style.setProperty('--op', (0.35 + depth * 0.6).toFixed(2));
            t.style.setProperty('--dur', rand(6, 10).toFixed(2) + 's');
            t.style.setProperty('--d', (-rand(0, 10)).toFixed(2) + 's'); // delay negativo desincroniza já no load

            let body = '<span class="auth-task-line" style="width:' + rand(3.5, 9).toFixed(1) + 'em"></span>';
            // ~45% das tarefas ganham uma segunda linha (tipo subtítulo)
            if (Math.random() < 0.45) {
                body += '<span class="auth-task-line auth-task-line--sub" style="width:' + rand(2, 5).toFixed(1) + 'em"></span>';
            }
            t.innerHTML =
                '<span class="auth-task-box">' + CHECK + '</span>' +
                '<span class="auth-task-body">' + body + '</span>';
            bg.appendChild(t);
        }
    }
})();
