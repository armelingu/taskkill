import { defineConfig, devices } from '@playwright/test';

// Porta e credenciais dedicadas aos testes E2E (não colidem com o dev em 5091).
const PORT = 5099;
const BASE_URL = `http://127.0.0.1:${PORT}`;
export const ADMIN_USER = 'admin';
export const ADMIN_PASSWORD = 'e2e-admin-pass-123';

export default defineConfig({
    testDir: 'tests/e2e',
    timeout: 30_000,
    expect: { timeout: 5_000 },
    fullyParallel: false,     // compartilham o mesmo banco/servidor
    workers: 1,
    forbidOnly: !!process.env.CI,
    reporter: process.env.CI ? 'line' : [['list']],
    use: {
        baseURL: BASE_URL,
        headless: true,
        // Falha o teste se o console do navegador cuspir erro não tratado.
        // (útil para pegar regressões do refactor de módulos)
        trace: 'retain-on-failure',
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ],
    webServer: {
        // Sobe o app real (waitress) num banco temporário e limpo a cada corrida.
        // Local usa o venv; no CI (sem venv) defina TASKKILL_PY=python.
        command: `rm -f /tmp/taskkill-e2e.db && ${process.env.TASKKILL_PY || '.venv/bin/python'} serve.py`,
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
        env: {
            TASKKILL_PORT: String(PORT),
            TASKKILL_HOST: '127.0.0.1',
            TASKKILL_DB_PATH: '/tmp/taskkill-e2e.db',
            TASKKILL_SECRET_KEY: 'e2e-secret-key',
            TASKKILL_ADMIN_USER: ADMIN_USER,
            TASKKILL_ADMIN_PASSWORD: ADMIN_PASSWORD,
            TASKKILL_DEBUG: '1',   // evita subir o scheduler durante os testes
        },
    },
});
