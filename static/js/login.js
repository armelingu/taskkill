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
})();
