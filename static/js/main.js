/**
 * Ponto de entrada do app (ES module). A orquestração de DOM/estado vive aqui;
 * a lógica reutilizável e pura foi extraída para ./modules/* (testável).
 */

import { normText, downloadBlob } from './modules/util.js';
import { apiFetch } from './modules/api.js';
import { showToast } from './modules/ui.js';
import { openModal } from './modules/focus.js';
import { state } from './modules/state.js';
import { renderDashboard } from './modules/dashboard.js';
import { renderInsights } from './modules/insights.js';
import { graphStart, graphStop } from './modules/graph.js';
import { renderTasks } from './modules/tasks.js';
import { renderSidebarProjects } from './modules/projects.js';
import { loadSharedWithMe } from './modules/shares.js';
import { openIntegrations, hideIntegrationsView } from './modules/integrations.js';
import { showRemindersSummary } from './modules/reminders.js';
import { initDrawer } from './modules/drawer.js';
import './modules/profile.js';  // auto-inicializa o perfil inline
import './modules/theme.js';    // controle de tema (claro/escuro/sistema)
import './modules/week.js';     // faixa da semana (datas reais) + navegação
import './modules/shortcuts.js'; // sistema central de atalhos + cheatsheet ('?')
import './modules/palette.js';   // command palette (Cmd/Ctrl-K)
import {
    skeletonItems, emptyState, projectView, projectTitle, taskList, taskInput,
    graphView, graphCanvas, perfilView, dashboardView,
} from './modules/dom.js';

document.addEventListener('DOMContentLoaded', () => {
    // Elementos da interface vivem em ./modules/dom.js (refs estáticas do index.html).

    // Drawer off-canvas da sidebar (mobile).
    initDrawer();




    // Modal de confirmação de logout
    const logoutTrigger  = document.getElementById('sidebar-logout-trigger');
    const logoutOverlay  = document.getElementById('logout-confirm-overlay');
    const logoutCancel   = document.getElementById('logout-confirm-cancel');
    const logoutConfirm  = document.getElementById('logout-confirm-ok');
    const logoutForm     = document.getElementById('logout-form');

    if (logoutTrigger && logoutOverlay) {
        let closeLogout = null;

        const openLogout = () => {
            closeLogout = openModal(logoutOverlay, { initialFocus: logoutConfirm });
        };

        logoutTrigger.addEventListener('click', openLogout);
        logoutCancel.addEventListener('click', () => { if (closeLogout) closeLogout(); });
        logoutConfirm.addEventListener('click', () => logoutForm.submit());

        logoutOverlay.addEventListener('click', e => {
            if (e.target === logoutOverlay && closeLogout) closeLogout();
        });

        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && !logoutOverlay.classList.contains('hidden') && closeLogout) {
                closeLogout();
            }
        });
    }

    // Ações de sistema (backup/restore)
    const btnBackup = document.getElementById('btn-backup');
    const btnRestore = document.getElementById('btn-restore');
    const restoreFile = document.getElementById('restore-file');

    if (btnBackup) {
        btnBackup.addEventListener('click', async () => {
            try {
                const res = await apiFetch('/api/backup');
                if (!res.ok) {
                    showToast('Falha ao exportar backup');
                    return;
                }
                const blob = await res.blob();
                const cd = res.headers.get('Content-Disposition') || '';
                const match = cd.match(/filename="?([^"]+)"?/i);
                const filename = match ? match[1] : 'taskkill-backup.db';
                downloadBlob(blob, filename);
                showToast('Backup exportado');
            } catch (e) {
                console.error('Erro ao exportar backup:', e);
                showToast('Erro ao exportar backup');
            }
        });
    }

    if (btnRestore && restoreFile) {
        btnRestore.addEventListener('click', () => {
            restoreFile.value = '';
            restoreFile.click();
        });

        restoreFile.addEventListener('change', async () => {
            const file = restoreFile.files && restoreFile.files[0];
            if (!file) return;

            try {
                const form = new FormData();
                form.append('file', file);

                const res = await apiFetch('/api/restore', {
                    method: 'POST',
                    body: form
                });

                if (!res.ok) {
                    showToast('Backup inválido ou corrompido');
                    return;
                }

                showToast('Backup restaurado');
                await fetchInitialData();
                renderTasks();
            } catch (e) {
                console.error('Erro ao restaurar backup:', e);
                showToast('Erro ao restaurar backup');
            }
        });
    }

    // Estado compartilhado vive em ./modules/state.js (objeto `state`).


    // ── Dados iniciais ─────────────────────────────────────────────────

    // Conecta com o Backend logo ao abrir
    async function fetchInitialData(isFirstLoad = false) {
        try {
            const [projRes, tasksRes] = await Promise.all([
                apiFetch('/api/projects'),
                apiFetch('/api/tasks'),
            ]);

            if (projRes.ok) {
                const projectNames = await projRes.json();
                renderSidebarProjects(projectNames);
            }

            // Projetos compartilhados comigo (seção própria na sidebar).
            loadSharedWithMe();

            if (tasksRes.ok) {
                state.tasksData = await tasksRes.json();
                // Se o usuário já estiver em alguma visão, re-renderiza com os dados carregados
                if (state.currentCategory || state.currentWeekDate || state.currentTag) {
                    renderTasks();
                } else if (dashboardView && !dashboardView.classList.contains('hidden')) {
                    renderActiveDashboardTab();
                } else if (graphView && !graphView.classList.contains('hidden')) {
                    graphStart();
                }

                // Lembretes: resumo discreto de hoje/atrasadas (uma vez por abertura).
                if (isFirstLoad) showRemindersSummary();
            }
        } catch (e) {
            console.error("Erro ao carregar banco de dados:", e);
        }
    }
    fetchInitialData(true);

    // Integrações (outro módulo) avisa que tarefas mudaram após import/execução.
    document.addEventListener('taskkill:tasks-changed', () => fetchInitialData());

    const navDashboard = document.getElementById('nav-dashboard');
    const navGraph = document.getElementById('nav-graph');

    // Abas do Dashboard (Projetos | Insights). A aba ativa é lembrada e
    // re-renderizada sempre que o Dashboard é aberto.
    const dashTabProjects = document.getElementById('dash-tab-projects');
    const dashTabInsights = document.getElementById('dash-tab-insights');
    const dashPanelProjects = document.getElementById('dashboard-projects-panel');
    const dashPanelInsights = document.getElementById('dashboard-insights-panel');

    function renderActiveDashboardTab() {
        if (dashTabInsights && dashTabInsights.classList.contains('active')) {
            renderInsights();
        } else {
            renderDashboard();
        }
    }

    function selectDashboardTab(which) {
        const insights = which === 'insights';
        if (dashTabProjects) {
            dashTabProjects.classList.toggle('active', !insights);
            dashTabProjects.setAttribute('aria-selected', String(!insights));
        }
        if (dashTabInsights) {
            dashTabInsights.classList.toggle('active', insights);
            dashTabInsights.setAttribute('aria-selected', String(insights));
        }
        if (dashPanelProjects) dashPanelProjects.classList.toggle('hidden', insights);
        if (dashPanelInsights) dashPanelInsights.classList.toggle('hidden', !insights);
        renderActiveDashboardTab();
    }

    if (dashTabProjects) dashTabProjects.addEventListener('click', () => selectDashboardTab('projects'));
    if (dashTabInsights) dashTabInsights.addEventListener('click', () => selectDashboardTab('insights'));

    // 2. Animação estilo "Load In" (Cascata Premium)
    skeletonItems.forEach((item, index) => {
        item.style.opacity = '0';
        item.style.transform = 'translateY(15px)';
        item.style.transition = 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
        
        setTimeout(() => {
            item.style.opacity = '1';
            item.style.transform = 'translateY(0)';
            
            setTimeout(() => {
                item.style.transition = '';
                item.style.transform = '';
            }, 400);

        }, 80 + (index * 60));

        // 3. Efeito Interativo de Seleção (Clicável e Ativo)
        item.addEventListener('click', () => {
            document.querySelectorAll('.skeleton-item').forEach(sib => sib.classList.remove('active'));
            item.classList.add('active');

            if (item.id !== 'nav-integrations') hideIntegrationsView();
            if (perfilView) perfilView.classList.add('hidden');

            // Se for o Dashboard
            if (item.id === 'nav-dashboard') {
                document.body.classList.remove('graph-mode');
                state.currentCategory = null; 
                state.currentWeekDate = null;
                state.currentTag = null;
                if (emptyState) emptyState.classList.add('hidden');
                if (projectView) projectView.classList.add('hidden');
                if (graphView) graphView.classList.add('hidden');
                graphStop();
                
                if (dashboardView) {
                    dashboardView.classList.remove('hidden');
                    // Reinicia animação
                    dashboardView.style.animation = 'none';
                    dashboardView.offsetHeight; 
                    dashboardView.style.animation = null;
                }
                
                renderActiveDashboardTab();
                return; // Para a execução base de projeto
            }

            // Se for o Gráfico
            if (item.id === 'nav-graph') {
                document.body.classList.add('graph-mode');
                state.currentCategory = null;
                state.currentWeekDate = null;
                state.currentTag = null;
                if (emptyState) emptyState.classList.add('hidden');
                if (projectView) projectView.classList.add('hidden');
                if (dashboardView) dashboardView.classList.add('hidden');
                if (graphView) {
                    graphView.classList.remove('hidden');
                    graphView.style.animation = 'none';
                    graphView.offsetHeight;
                    graphView.style.animation = null;
                }
                graphStart();
                return;
            }

            // Se for as Integrações (admin)
            if (item.id === 'nav-integrations') {
                document.body.classList.remove('graph-mode');
                state.currentCategory = null;
                state.currentWeekDate = null;
                state.currentTag = null;
                if (emptyState)    emptyState.classList.add('hidden');
                if (projectView)   projectView.classList.add('hidden');
                if (dashboardView) dashboardView.classList.add('hidden');
                if (graphView)     graphView.classList.add('hidden');
                if (perfilView)    perfilView.classList.add('hidden');
                graphStop();
                openIntegrations();
                return;
            }

            // A visão da Semana (chips de dia com data real) é gerenciada por
            // modules/week.js — os chips não fazem parte deste laço de skeletons.

            // Se for um Projeto Genérico
            document.body.classList.remove('graph-mode');
            state.currentCategory = normText(item.textContent);
            state.currentWeekDate = null;
            state.currentTag = null;
            
            // Inicializa a lista dessa categoria se ainda não existir
            if (!state.tasksData[state.currentCategory]) {
                state.tasksData[state.currentCategory] = [];
            }

            // Mostra o painel do Projeto
            if (emptyState) emptyState.classList.add('hidden');
            if (dashboardView) dashboardView.classList.add('hidden');
            if (graphView) graphView.classList.add('hidden');
            graphStop();
            if (projectView) {
                projectView.classList.remove('hidden');
                projectView.style.animation = 'none';
                projectView.offsetHeight; /* trigger reflow */
                projectView.style.animation = null; 
            }
            
            // Re-exibe o input de criar no projeto
            document.querySelector('.task-input-container').style.display = 'flex';

            // Atualiza o Título e Renderiza a Lista
            if (projectTitle) projectTitle.textContent = state.currentCategory;
            renderTasks();
        });

        // ----------------------------------------------------
        // LOGICA DE DRAG AND DROP (Soltar tarefas no menu lateral)
        // ----------------------------------------------------
        item.addEventListener('dragover', e => {
            if (item.id === 'nav-dashboard' || item.id === 'nav-integrations') return; // Não permite soltar aqui
            e.preventDefault(); // Permitir o Drop
            item.classList.add('drag-over');
        });

        item.addEventListener('dragleave', e => {
            item.classList.remove('drag-over');
        });

        item.addEventListener('drop', e => {
            e.preventDefault();
            item.classList.remove('drag-over');
            if (item.id === 'nav-dashboard' || item.id === 'nav-integrations') return;

            const droppedTaskId = e.dataTransfer.getData('text/plain');
            if (!droppedTaskId) return;

            let sourceProject = null;
            let targetTask = null;

            // Encontra a tarefa no estado e de onde ela veio
            Object.keys(state.tasksData).forEach(proj => {
                const found = state.tasksData[proj].find(t => t.id.toString() === droppedTaskId);
                if (found) {
                    targetTask = found;
                    sourceProject = proj;
                }
            });

            if(!targetTask) return;

            // O agendamento por data (soltar tarefa num dia da semana) é tratado
            // em modules/week.js. Aqui resta apenas mover entre projetos.
            // Se soltou no menu de PROJETO -> Muda de Projeto (Move to Project)
            if (item.classList.contains('project-nav')) {
                const newProject = normText(item.textContent);
                if (sourceProject === newProject) return; // Mesmo lugar

                // Tira de um array local e bota no outro
                const taskIndex = state.tasksData[sourceProject].findIndex(t => t.id === targetTask.id);
                state.tasksData[sourceProject].splice(taskIndex, 1);

                if (!state.tasksData[newProject]) state.tasksData[newProject] = [];
                targetTask.project = newProject;
                state.tasksData[newProject].push(targetTask);

                apiFetch(`/api/tasks/${targetTask.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ project: newProject })
                });

                showToast(`Movido para ${newProject}`);
            }

            renderTasks(); // Reflete a mudança tirando da tela se necessário
        });
    });





});
