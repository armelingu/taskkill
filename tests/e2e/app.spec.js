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

    test('quick add: linguagem natural define prazo e limpa o texto', async ({ page }) => {
        // Abre um projeto já existente (criado nos testes anteriores).
        await page.locator('.project-nav', { hasText: 'Trabalho' }).click();
        await expect(page.locator('#project-title')).toHaveText('Trabalho');

        const input = page.locator('#new-task-input');
        await input.fill('amanhã revisar PR #infra');
        // Preview do prazo detectado aparece enquanto digita.
        await expect(page.locator('#quick-add-hint')).toBeVisible();

        await input.press('Enter');

        // A tarefa é criada com o texto limpo (sem "amanhã") e com badge de data.
        const item = page.locator('.task-item', { hasText: 'revisar PR #infra' });
        await expect(item).toBeVisible();
        await expect(item.locator('.task-due-badge')).toHaveText(/^\d{2}\/\d{2}$/);
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

    test('visão da semana: datas reais, fim de semana e navegação', async ({ page }) => {
        // Faixa com 7 dias (Seg–Dom) com datas reais; 2 são de fim de semana.
        await expect(page.locator('.week-day')).toHaveCount(7);
        await expect(page.locator('.week-day.is-weekend')).toHaveCount(2);

        // Segunda-feira da semana atual (primeira coluna) como âncora.
        const firstDate = await page.locator('.week-day').first().getAttribute('data-date');

        // Abrir um dia -> project-view com título "<Dia da semana>, dd/mm".
        await page.locator('.week-day').first().click();
        await expect(page.locator('#project-view')).toBeVisible();
        await expect(page.locator('#project-title')).toHaveText(/,\s\d{2}\/\d{2}$/);

        // Próxima semana: as datas dos chips mudam.
        await page.click('#week-next');
        const firstDateNext = await page.locator('.week-day').first().getAttribute('data-date');
        expect(firstDateNext).not.toBe(firstDate);

        // "Hoje" retorna à semana atual (mesma segunda de âncora).
        await page.click('#week-today');
        await expect(page.locator('.week-day').first()).toHaveAttribute('data-date', firstDate || '');
    });

    test('atalhos: chord "g d" navega e "?" abre a cheatsheet', async ({ page }) => {
        // Chord estilo Linear: g depois d -> dashboard.
        await page.keyboard.press('g');
        await page.keyboard.press('d');
        await expect(page.locator('#dashboard-view')).toBeVisible();

        // g depois g -> grafo.
        await page.keyboard.press('g');
        await page.keyboard.press('g');
        await expect(page.locator('#graph-view')).toBeVisible();

        // "?" abre a cheatsheet; Esc fecha e devolve o foco.
        await page.keyboard.press('?');
        await expect(page.locator('#shortcuts-overlay')).toBeVisible();
        await expect(page.locator('#shortcuts-overlay .shortcut-row').first()).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.locator('#shortcuts-overlay')).toBeHidden();
    });

    test('command palette: Ctrl-K abre, filtra e executa comando', async ({ page }) => {
        // Ctrl-K (portável: o handler aceita meta OU ctrl).
        await page.keyboard.press('Control+k');
        await expect(page.locator('#command-palette')).toBeVisible();
        await expect(page.locator('.palette-input')).toBeFocused();

        // Filtra e executa: "grafo" -> Enter navega ao grafo.
        await page.locator('.palette-input').fill('grafo');
        await expect(page.locator('.palette-item.is-selected').first()).toBeVisible();
        await page.keyboard.press('Enter');
        await expect(page.locator('#command-palette')).toBeHidden();
        await expect(page.locator('#graph-view')).toBeVisible();

        // Reabre, busca inexistente mostra estado vazio; Esc fecha.
        await page.keyboard.press('Control+k');
        await page.locator('.palette-input').fill('zzzxyq');
        await expect(page.locator('.palette-empty')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.locator('#command-palette')).toBeHidden();
    });

    test('lista: navegação por teclado (j/k), concluir (x) e anel de foco', async ({ page }) => {
        const proj = `Nav-${Date.now()}`;
        await page.click('#btn-add-project');
        const pin = page.locator('.project-new-input');
        await pin.fill(proj);
        await pin.press('Enter');
        await expect(page.locator('#project-title')).toHaveText(proj);

        for (const t of ['Primeira tarefa', 'Segunda tarefa']) {
            await page.fill('#new-task-input', t);
            await page.press('#new-task-input', 'Enter');
        }
        await expect(page.locator('.task-item')).toHaveCount(2);

        // Sai do input para os atalhos de lista valerem (evita digitar 'j').
        await page.locator('#new-task-input').blur();
        await expect(page.locator('#new-task-input')).not.toBeFocused();

        // j engaja e seleciona a 1ª; j de novo vai para a 2ª (anel visível).
        await page.keyboard.press('j');
        await expect(page.locator('.task-item').first()).toHaveClass(/task-nav-active/);
        await page.keyboard.press('j');
        await expect(page.locator('.task-item').nth(1)).toHaveClass(/task-nav-active/);

        // x conclui a linha ativa.
        await page.keyboard.press('x');
        await expect(page.locator('.task-item').nth(1)).toHaveClass(/completed/);

        // k volta para a 1ª.
        await page.keyboard.press('k');
        await expect(page.locator('.task-item').first()).toHaveClass(/task-nav-active/);
    });

    test('undo: excluir tarefa mostra "Desfazer" e restaura', async ({ page }) => {
        const proj = `Undo-${Date.now()}`;
        await page.click('#btn-add-project');
        const pin = page.locator('.project-new-input');
        await pin.fill(proj);
        await pin.press('Enter');
        await expect(page.locator('#project-title')).toHaveText(proj);

        await page.fill('#new-task-input', 'Tarefa para desfazer');
        await page.press('#new-task-input', 'Enter');
        const item = page.locator('.task-item', { hasText: 'Tarefa para desfazer' });
        await expect(item).toBeVisible();

        // Exclui e confirma que sumiu; o toast oferece "Desfazer".
        await item.hover();
        await item.locator('.delete-btn').click();
        await expect(page.locator('.task-item', { hasText: 'Tarefa para desfazer' })).toHaveCount(0);

        const toast = page.locator('.toast', { hasText: 'Tarefa removida' });
        await expect(toast).toBeVisible();
        await toast.locator('.toast-action').click();

        // Restaura na lista e confirma o feedback de sucesso.
        await expect(page.locator('.task-item', { hasText: 'Tarefa para desfazer' })).toBeVisible();
        await expect(page.locator('.toast', { hasText: 'Tarefa restaurada' })).toBeVisible();
    });

    test('estado vazio: projeto novo mostra mensagem e dica contextual', async ({ page }) => {
        const proj = `V-${Date.now()}`;
        await page.click('#btn-add-project');
        const pin = page.locator('.project-new-input');
        await pin.fill(proj);
        await pin.press('Enter');
        await expect(page.locator('#project-title')).toHaveText(proj);

        const empty = page.locator('.task-empty');
        await expect(empty).toBeVisible();
        await expect(empty.locator('.task-empty-title')).toHaveText('Sem tarefas por aqui ainda.');
        await expect(empty.locator('.task-empty-hint')).toContainText('Pressione N');
    });

    test('recorrência: quick add cria com badge e concluir reagenda', async ({ page }) => {
        const proj = `Rec-${Date.now()}`;
        await page.click('#btn-add-project');
        const pin = page.locator('.project-new-input');
        await pin.fill(proj);
        await pin.press('Enter');
        await expect(page.locator('#project-title')).toHaveText(proj);

        // "todo dia" -> recorrência diária; "amanhã" -> prazo. Hint mostra ambos.
        await page.fill('#new-task-input', 'todo dia amanhã beber agua');
        await expect(page.locator('#quick-add-hint')).toContainText('Repete');
        await page.press('#new-task-input', 'Enter');

        const item = page.locator('.task-item', { hasText: 'beber agua' });
        await expect(item).toBeVisible();
        await expect(item.locator('.task-recur-badge')).toBeVisible();

        // Concluir uma recorrente reagenda (não conclui) e avisa por toast.
        await item.locator('.task-checkbox').click();
        await expect(page.locator('.toast', { hasText: 'reagendada' })).toBeVisible();
        await expect(page.locator('.task-item', { hasText: 'beber agua' })).not.toHaveClass(/completed/);
        await expect(page.locator('.task-item', { hasText: 'beber agua' }).locator('.task-recur-badge')).toBeVisible();
    });

    test('lembretes: badge "Hoje" e resumo discreto ao abrir', async ({ page }) => {
        const proj = `Lem-${Date.now()}`;
        await page.click('#btn-add-project');
        const pin = page.locator('.project-new-input');
        await pin.fill(proj);
        await pin.press('Enter');
        await expect(page.locator('#project-title')).toHaveText(proj);

        await page.fill('#new-task-input', 'hoje pagar conta');
        await page.press('#new-task-input', 'Enter');

        const item = page.locator('.task-item', { hasText: 'pagar conta' });
        await expect(item.locator('.task-due-today')).toHaveText('Hoje');

        // Ao recarregar, o resumo de lembretes aparece como toast discreto.
        await page.reload();
        await expect(page.locator('.toast', { hasText: 'para hoje' })).toBeVisible();
    });

    test('dependências: adicionar cria badge "bloqueada por" e remover limpa', async ({ page }) => {
        const proj = `Dep-${Date.now()}`;
        await page.click('#btn-add-project');
        const pin = page.locator('.project-new-input');
        await pin.fill(proj);
        await pin.press('Enter');
        await expect(page.locator('#project-title')).toHaveText(proj);

        for (const t of ['Fundacao', 'Parede']) {
            await page.fill('#new-task-input', t);
            await page.press('#new-task-input', 'Enter');
        }
        const parede = page.locator('.task-item', { hasText: 'Parede' });
        await expect(parede).toBeVisible();

        // Abre o editor da "Parede" e adiciona dependência de "Fundacao".
        await parede.hover();
        await parede.locator('.edit-btn').click();
        await parede.locator('.edit-task-dep-select').selectOption({ label: 'Fundacao' });

        // Pré-requisito ainda em aberto => badge de bloqueio (soft) aparece.
        await expect(page.locator('.task-item', { hasText: 'Parede' }).locator('.task-blocked-badge'))
            .toHaveText('bloqueada por 1');

        // O grafo renderiza sem erro (nós de tarefa + setas no canvas).
        await page.click('#nav-graph');
        await expect(page.locator('#graph-canvas')).toBeVisible();
        await page.waitForTimeout(300);

        // Volta ao projeto e remove a dependência pelo chip; o badge some.
        await page.locator('.project-nav', { hasText: proj }).click();
        const parede2 = page.locator('.task-item', { hasText: 'Parede' });
        await parede2.hover();
        await parede2.locator('.edit-btn').click();
        await parede2.locator('.edit-dep-remove').click();
        await expect(page.locator('.task-item', { hasText: 'Parede' }).locator('.task-blocked-badge'))
            .toHaveCount(0);
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

    test('tema: alterna para escuro, persiste após reload e volta ao claro', async ({ page }) => {
        const html = page.locator('html');

        // Default = sistema (headless resolve claro).
        await expect(html).not.toHaveAttribute('data-theme', 'dark');

        // Ativa o tema escuro pelo controle segmentado do perfil.
        await page.click('#nav-perfil');
        await page.click('.theme-seg-btn[data-theme-mode="dark"]');
        await expect(html).toHaveAttribute('data-theme', 'dark');
        await expect(page.locator('.theme-seg-btn[data-theme-mode="dark"]')).toHaveClass(/is-active/);
        expect(await page.evaluate(() => localStorage.getItem('taskkill-theme'))).toBe('dark');

        // Persiste após reload (boot aplica antes da primeira pintura).
        await page.reload();
        await expect(html).toHaveAttribute('data-theme', 'dark');

        // Sincronização entre dispositivos: mesmo sem cache local (localStorage
        // limpo, simulando outro dispositivo), o servidor injeta a preferência.
        await page.evaluate(() => localStorage.removeItem('taskkill-theme'));
        await page.reload();
        await expect(html).toHaveAttribute('data-theme-mode', 'dark');
        await expect(html).toHaveAttribute('data-theme', 'dark');

        // Grafo repinta sem erro de runtime no tema escuro.
        await page.click('#nav-graph');
        await expect(page.locator('#graph-canvas')).toBeVisible();
        await page.waitForTimeout(300);

        // Botão-ícone do sidebar cicla os modos (escuro -> sistema).
        await page.click('#sidebar-theme-toggle');
        expect(await page.evaluate(() => localStorage.getItem('taskkill-theme'))).toBe('system');

        // Volta ao claro pelo controle segmentado.
        await page.click('#nav-perfil');
        await page.click('.theme-seg-btn[data-theme-mode="light"]');
        await expect(html).toHaveAttribute('data-theme', 'light');
    });

    test('mobile: drawer abre pelo menu, backdrop e navegação fecham', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 780 });

        const toggle = page.locator('#sidebar-toggle');
        const sidebar = page.locator('#app-sidebar');
        const body = page.locator('body');

        // Topbar/hamburguer aparece no mobile; drawer começa fora da tela.
        // (poll: o transform anima ao trocar de breakpoint, então aguarda assentar)
        await expect(toggle).toBeVisible();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect.poll(async () => {
            const b = await sidebar.boundingBox();
            return b ? b.x : 0;
        }).toBeLessThan(0);

        // Abre pelo hamburguer: entra na tela e marca aria-expanded.
        await toggle.click();
        await expect(body).toHaveClass(/sidebar-open/);
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect.poll(async () => {
            const b = await sidebar.boundingBox();
            return b ? b.x : -1;
        }).toBeGreaterThanOrEqual(0);

        // Clique no backdrop fecha.
        await page.locator('#sidebar-backdrop').click({ position: { x: 360, y: 400 } });
        await expect(body).not.toHaveClass(/sidebar-open/);

        // Reabre e navega (Dashboard) -> fecha sozinho e troca a visão.
        await toggle.click();
        await expect(body).toHaveClass(/sidebar-open/);
        await page.locator('#nav-dashboard').click();
        await expect(body).not.toHaveClass(/sidebar-open/);
        await expect(page.locator('#dashboard-view')).toBeVisible();
    });
});
