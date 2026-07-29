/**
 * Ponto de entrada do app (ES module). A orquestração de DOM/estado vive aqui;
 * a lógica reutilizável e pura foi extraída para ./modules/* (testável).
 */

import { escapeHTML, normText, pfFmtDate, downloadBlob } from './modules/util.js';
import { apiFetch } from './modules/api.js';
import { showToast, confirmModal } from './modules/ui.js';
import { intRenderTemplate } from './modules/templates.js';
import { buildGraphModel } from './modules/graph-model.js';
import { state } from './modules/state.js';
import { renderDashboard } from './modules/dashboard.js';
import { graphStart, graphStop } from './modules/graph.js';
import { renderTasks } from './modules/tasks.js';
import { openIntegrations, hideIntegrationsView } from './modules/integrations.js';
import './modules/profile.js';  // auto-inicializa o perfil inline
import {
    skeletonItems, emptyState, projectView, projectTitle, taskList, taskInput,
    graphView, graphCanvas, perfilView, dashboardView,
} from './modules/dom.js';

document.addEventListener('DOMContentLoaded', () => {
    // Elementos da interface vivem em ./modules/dom.js (refs estáticas do index.html).




    // Modal de confirmação de logout
    const logoutTrigger  = document.getElementById('sidebar-logout-trigger');
    const logoutOverlay  = document.getElementById('logout-confirm-overlay');
    const logoutCancel   = document.getElementById('logout-confirm-cancel');
    const logoutConfirm  = document.getElementById('logout-confirm-ok');
    const logoutForm     = document.getElementById('logout-form');

    if (logoutTrigger && logoutOverlay) {
        logoutTrigger.addEventListener('click', () => {
            logoutOverlay.classList.remove('hidden');
            logoutConfirm.focus();
        });

        logoutCancel.addEventListener('click', () => {
            logoutOverlay.classList.add('hidden');
        });

        logoutConfirm.addEventListener('click', () => {
            logoutForm.submit();
        });

        logoutOverlay.addEventListener('click', e => {
            if (e.target === logoutOverlay) logoutOverlay.classList.add('hidden');
        });

        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && !logoutOverlay.classList.contains('hidden')) {
                logoutOverlay.classList.add('hidden');
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

    // ── Projetos dinâmicos ─────────────────────────────────────────────

    // SVGs reutilizáveis
    const _SVG_TRASH = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <polyline points="3 6 5 6 21 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M10 11v6M14 11v6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
        <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;

    function _attachProjectItemEvents(wrapper) {
        const item     = wrapper.querySelector('.project-nav');
        const btnDel   = wrapper.querySelector('.btn-delete-project');

        // Clique no item → navegar para o projeto
        item.addEventListener('click', () => {
            document.querySelectorAll('.skeleton-item').forEach(s => s.classList.remove('active'));
            item.classList.add('active');

            hideIntegrationsView();
            if (perfilView) perfilView.classList.add('hidden');

            document.body.classList.remove('graph-mode');
            state.currentCategory = normText(item.textContent);
            state.currentWeekDay = null;
            state.currentTag = null;

            if (!state.tasksData[state.currentCategory]) state.tasksData[state.currentCategory] = [];

            if (emptyState)    emptyState.classList.add('hidden');
            if (dashboardView) dashboardView.classList.add('hidden');
            if (graphView)     graphView.classList.add('hidden');
            graphStop();
            if (projectView) {
                projectView.classList.remove('hidden');
                projectView.style.animation = 'none';
                projectView.offsetHeight;
                projectView.style.animation = null;
            }

            document.querySelector('.task-input-container').style.display = 'flex';
            if (projectTitle) projectTitle.textContent = state.currentCategory;
            renderTasks();
        });

        // Drag-and-drop para mover tarefas entre projetos
        item.addEventListener('dragover', e => { e.preventDefault(); item.classList.add('drag-over'); });
        item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
        item.addEventListener('drop', e => {
            e.preventDefault();
            item.classList.remove('drag-over');
            const taskId = e.dataTransfer.getData('text/plain');
            const newProject = normText(item.textContent);
            if (!taskId || !newProject) return;

            const numId = parseInt(taskId, 10);
            let movedTask = null;
            for (const proj in state.tasksData) {
                const idx = state.tasksData[proj].findIndex(t => t.id === numId);
                if (idx !== -1) {
                    [movedTask] = state.tasksData[proj].splice(idx, 1);
                    break;
                }
            }
            if (!movedTask) return;

            movedTask.project = newProject;
            movedTask.originalProject = newProject;
            if (!state.tasksData[newProject]) state.tasksData[newProject] = [];
            state.tasksData[newProject].push(movedTask);

            apiFetch(`/api/tasks/${numId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ project: newProject }),
            }).then(r => { if (!r.ok) console.error('Falha ao mover tarefa'); });

            if (state.currentCategory) renderTasks();
        });

        // Botão lixeira — excluir projeto
        if (btnDel) {
            btnDel.addEventListener('click', async e => {
                e.stopPropagation();
                const name = normText(item.textContent);
                const ok = await confirmModal(
                    `Excluir "${name}"?`,
                    'Todas as tarefas do projeto serão arquivadas e não aparecerão mais na lista.'
                );
                if (!ok) return;

                const res = await apiFetch(`/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' });
                if (res.ok) {
                    delete state.tasksData[name];
                    wrapper.remove();
                    if (state.currentCategory === name) {
                        state.currentCategory = null;
                        if (projectView) projectView.classList.add('hidden');
                        if (emptyState)  emptyState.classList.remove('hidden');
                    }
                } else {
                    alert('Erro ao excluir o projeto.');
                }
            });
        }
    }

    function _makeProjectWrapper(name) {
        const wrapper = document.createElement('div');
        wrapper.className = 'project-nav-item';

        const item = document.createElement('div');
        item.className = 'skeleton-item project-nav';
        item.setAttribute('aria-label', `Projeto ${name}`);
        item.textContent = name;

        const btnDel = document.createElement('button');
        btnDel.className = 'btn-delete-project';
        btnDel.title = `Excluir ${name}`;
        btnDel.setAttribute('aria-label', `Excluir projeto ${name}`);
        btnDel.innerHTML = _SVG_TRASH;

        wrapper.appendChild(item);
        wrapper.appendChild(btnDel);
        return wrapper;
    }

    function renderSidebarProjects(names) {
        const list = document.getElementById('project-list');
        if (!list) return;
        list.innerHTML = '';
        names.forEach(name => {
            const wrapper = _makeProjectWrapper(name);
            list.appendChild(wrapper);
            _attachProjectItemEvents(wrapper);
        });
    }

    // Botão + para criar novo projeto inline
    const btnAddProject = document.getElementById('btn-add-project');
    if (btnAddProject) {
        btnAddProject.addEventListener('click', () => {
            const list = document.getElementById('project-list');
            if (!list) return;

            // Evita abrir dois inputs ao mesmo tempo
            if (list.querySelector('.project-new-input')) return;

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'project-new-input skeleton-item';
            input.placeholder = 'Nome do projeto…';
            input.maxLength = 18;
            list.appendChild(input);
            input.focus();

            const confirmCreate = async () => {
                const name = input.value.trim();
                if (!name) { input.remove(); return; }

                const res = await apiFetch('/api/projects', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name }),
                });

                if (res.ok) {
                    input.remove();
                    if (!state.tasksData[name]) state.tasksData[name] = [];

                    const wrapper = _makeProjectWrapper(name);
                    list.appendChild(wrapper);
                    _attachProjectItemEvents(wrapper);

                    // Aciona o clique para ir direto ao projeto novo
                    wrapper.querySelector('.project-nav').click();
                } else {
                    const err = await res.json().catch(() => ({}));
                    alert(err.error || 'Erro ao criar projeto.');
                    input.remove();
                }
            };

            input.addEventListener('keydown', e => {
                if (e.key === 'Enter') confirmCreate();
                if (e.key === 'Escape') input.remove();
            });
            input.addEventListener('blur', () => setTimeout(() => input.remove(), 150));
        });
    }

    // ── Dados iniciais ─────────────────────────────────────────────────

    // Conecta com o Backend logo ao abrir
    async function fetchInitialData() {
        try {
            const [projRes, tasksRes] = await Promise.all([
                apiFetch('/api/projects'),
                apiFetch('/api/tasks'),
            ]);

            if (projRes.ok) {
                const projectNames = await projRes.json();
                renderSidebarProjects(projectNames);
            }

            if (tasksRes.ok) {
                state.tasksData = await tasksRes.json();
                // Se o usuário já estiver em alguma visão, re-renderiza com os dados carregados
                if (state.currentCategory || state.currentWeekDay || state.currentTag) {
                    renderTasks();
                } else if (dashboardView && !dashboardView.classList.contains('hidden')) {
                    renderDashboard();
                } else if (graphView && !graphView.classList.contains('hidden')) {
                    graphStart();
                }
            }
        } catch (e) {
            console.error("Erro ao carregar banco de dados:", e);
        }
    }
    fetchInitialData();

    // Integrações (outro módulo) avisa que tarefas mudaram após import/execução.
    document.addEventListener('taskkill:tasks-changed', () => fetchInitialData());

    const navDashboard = document.getElementById('nav-dashboard');
    const navGraph = document.getElementById('nav-graph');

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
                state.currentWeekDay = null;
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
                
                renderDashboard();
                return; // Para a execução base de projeto
            }

            // Se for o Gráfico
            if (item.id === 'nav-graph') {
                document.body.classList.add('graph-mode');
                state.currentCategory = null;
                state.currentWeekDay = null;
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
                state.currentWeekDay = null;
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
            
            // Se for a visão da Semana
            if (item.classList.contains('week-nav')) {
                document.body.classList.remove('graph-mode');
                state.currentCategory = null;
                state.currentWeekDay = item.getAttribute('data-day');
                state.currentTag = null;
                
                if (emptyState) emptyState.classList.add('hidden');
                if (dashboardView) dashboardView.classList.add('hidden');
                if (graphView) graphView.classList.add('hidden');
                graphStop();
                if (projectView) {
                    projectView.classList.remove('hidden');
                    projectView.style.animation = 'none';
                    projectView.offsetHeight;
                    projectView.style.animation = null;
                }
                
                if (projectTitle) projectTitle.textContent = state.currentWeekDay;
                
                // Na visão da semana não criamos tarefas novas diretamente (pois falta o projeto), 
                // então escondemos o input
                document.querySelector('.task-input-container').style.display = 'none';
                
                renderTasks();
                return;
            }

            // Se for um Projeto Genérico
            document.body.classList.remove('graph-mode');
            state.currentCategory = normText(item.textContent);
            state.currentWeekDay = null;
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

            // Se soltou no menu de SEMANA -> Altera o 'due_date'
            if (item.classList.contains('week-nav')) {
                const newDay = item.getAttribute('data-day');
                if (targetTask.due_date === newDay) return; // Nada a fazer

                targetTask.due_date = newDay;
                
                apiFetch(`/api/tasks/${targetTask.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ due_date: newDay })
                });

                showToast(`Agendado para ${newDay}`);
            } 
            // Se soltou no menu de PROJETO -> Muda de Projeto (Move to Project)
            else if (item.classList.contains('project-nav')) {
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





    // Função Principal para renderizar as tarefas na tela

    // 5. UX Premium: Atalho Globais (Linear style)
    document.addEventListener('keydown', (e) => {
        // Se já estiver focando em qualquer elemento de input, não aciona para evitar escrever a letra "n" dentro de um lugar errado
        if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') {
            return;
        }

        // Aperta "N" para focar e criar nova tarefa
        if (e.key.toLowerCase() === 'n' && state.currentCategory) {
            e.preventDefault(); // Evita escrever de fato algo
            if (taskInput) {
                taskInput.focus();
            }
        }
    });


});
