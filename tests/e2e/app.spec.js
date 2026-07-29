// @ts-check
import { test, expect } from '@playwright/test';
import { ADMIN_USER, ADMIN_PASSWORD } from '../../playwright.config.js';

// Coletor de exceções de runtime da página. Se o refactor de módulos quebrar
// algo (import faltando, ReferenceError), aparece aqui e falha o teste.
function attachErrorGuard(page) {
    const errors = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    return errors;
}

async function login(page) {
    await page.goto('/login');
    await page.fill('#username', ADMIN_USER);
    await page.fill('#password', ADMIN_PASSWORD);
    await Promise.all([
        page.waitForURL('**/'),
        page.click('#login-submit'),
    ]);
}

// NB: os testes compartilham o mesmo servidor/banco (workers=1, DB temporário
// zerado no start). A ordem importa: o teste de onboarding roda primeiro, com o
// banco vazio; os chips/criação semeiam projetos para os testes seguintes.
test.describe('Fluxos principais do app', () => {
    let errors;

    test.beforeEach(async ({ page }) => {
        errors = attachErrorGuard(page);
        await login(page);
        await expect(page.locator('.brand-name')).toHaveText('Taskkill');
    });

    test.afterEach(async () => {
        expect(errors, `erros de runtime: ${errors.join(' | ')}`).toEqual([]);
    });

    test('primeiro uso: onboarding aparece sem projetos', async ({ page }) => {
        // Banco novo => sem seeds => onboarding visível, dica oculta, sidebar vazia.
        await expect(page.locator('#onboarding')).toBeVisible();
        await expect(page.locator('#empty-hint')).toBeHidden();
        await expect(page.locator('.project-nav')).toHaveCount(0);
        await expect(page.locator('#onboarding-create')).toBeVisible();
    });

    test('onboarding: chip de exemplo cria e abre o projeto', async ({ page }) => {
        await page.click('.tpl-chip[data-tpl="Trabalho"]');
        const projNav = page.locator('.project-nav', { hasText: 'Trabalho' });
        await expect(projNav).toBeVisible();
        await expect(page.locator('#project-title')).toHaveText('Trabalho');
        // Com projeto criado, o onboarding some quando voltamos ao estado vazio.
        await expect(page.locator('#onboarding')).toBeHidden();
    });

    test('cria projeto, cria tarefa e marca como concluída', async ({ page }) => {
        const proj = `E2E-${Date.now()}`;
        await page.click('#btn-add-project');
        const input = page.locator('.project-new-input');
        await input.fill(proj);
        await input.press('Enter');

        // O novo projeto aparece e é aberto automaticamente.
        const projNav = page.locator('.project-nav', { hasText: proj });
        await expect(projNav).toBeVisible();
        await expect(page.locator('#project-title')).toHaveText(proj);

        // Cria uma tarefa.
        const taskText = `Tarefa de teste ${Date.now()}`;
        await page.fill('#new-task-input', taskText);
        await page.press('#new-task-input', 'Enter');

        const item = page.locator('.task-item', { hasText: taskText });
        await expect(item).toBeVisible();

        // Marca como concluída (UI otimista adiciona a classe 'completed').
        await item.locator('.task-checkbox').click();
        await expect(item).toHaveClass(/completed/);
    });

    test('dashboard renderiza cards por projeto', async ({ page }) => {
        await page.click('#nav-dashboard');
        await expect(page.locator('#dashboard-view')).toBeVisible();
        await expect(page.locator('#project-cards-grid .project-card').first()).toBeVisible();
    });

    test('visão em grafo abre o canvas', async ({ page }) => {
        await page.click('#nav-graph');
        await expect(page.locator('#graph-view')).toBeVisible();
        await expect(page.locator('#graph-canvas')).toBeVisible();
        // Deixa o layout do grafo rodar alguns frames.
        await page.waitForTimeout(400);
    });

    test('visão da semana filtra por dia', async ({ page }) => {
        await page.click('.week-nav[data-day="Segunda"]');
        await expect(page.locator('#project-view')).toBeVisible();
        await expect(page.locator('#project-title')).toHaveText('Segunda');
    });

    test('integrações: abre lista e o wizard', async ({ page }) => {
        await page.click('#nav-integrations');
        await expect(page.locator('#integrations-view')).toBeVisible();
        await expect(page.locator('#int-list-panel')).toBeVisible();
        await page.click('#int-new-btn');
        await expect(page.locator('#int-editor')).toBeVisible();
        await expect(page.locator('#int-stepper')).toBeVisible();
    });

    test('perfil: abre e alterna abas', async ({ page }) => {
        await page.click('#nav-perfil');
        await expect(page.locator('#perfil-view')).toBeVisible();
        await expect(page.locator('#perfil-tab-conta')).toBeVisible();
        await page.click('[data-perfil-tab="seguranca"]');
        await expect(page.locator('#perfil-tab-seguranca')).toBeVisible();
    });
});
