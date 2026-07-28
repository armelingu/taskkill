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

    // Estado de carregando no botão ao enviar
    const form = document.querySelector('.auth-form');
    const submit = document.getElementById('login-submit');
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
        const COUNT = 16;
        const CHECK = '<svg class="auth-task-check" viewBox="0 0 24 24" fill="none" aria-hidden="true">'
            + '<path d="M5 12.5l4 4 10-10" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        const rand = (min, max) => min + Math.random() * (max - min);
        for (let i = 0; i < COUNT; i++) {
            const t = document.createElement('div');
            t.className = 'auth-task';
            t.style.top = rand(2, 92).toFixed(1) + '%';
            t.style.left = rand(1, 82).toFixed(1) + '%';
            t.style.setProperty('--dur', rand(6, 10).toFixed(2) + 's');
            t.style.setProperty('--d', (-rand(0, 10)).toFixed(2) + 's'); // delay negativo desincroniza já no load
            t.innerHTML =
                '<span class="auth-task-box">' + CHECK + '</span>' +
                '<span class="auth-task-line" style="width:' + rand(40, 130).toFixed(0) + 'px"></span>';
            bg.appendChild(t);
        }
    }
})();
