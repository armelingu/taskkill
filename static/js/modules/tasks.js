/**
 * Tarefas: render da lista (projeto/semana/#tag), criação via input, edição
 * inline, subtarefas ([ ]/[x]), toggle/delete, drag-drop de reordenação e a
 * visão por #tag (openTagView, aberta a partir do grafo). Extraído de main.js.
 *
 * Auto-liga o input de nova tarefa e o DnD da lista no import.
 */

import { state } from './state.js';
import { escapeHTML } from './util.js';
import { apiFetch } from './api.js';
import { showToast } from './ui.js';
import { graphStop } from './graph.js';
import { hideIntegrationsView } from './integrations.js';
import {
    taskList, taskInput, emptyState, projectView, projectTitle,
    graphView, dashboardView, perfilView, skeletonItems,
} from './dom.js';

// ── Visão por #tag (aberta a partir do grafo) ─────────────────────
export function openTagView(tagKey) {
    const tag = String(tagKey || '').toLowerCase();
    if (!tag) return;

    // Sem item no sidebar para tag: remove o estado ativo para evitar “desalinhamento”
    skeletonItems.forEach(sib => sib.classList.remove('active'));

    document.body.classList.remove('graph-mode');
    state.currentTag = tag;
    state.currentCategory = null;
    state.currentWeekDay = null;

    if (emptyState) emptyState.classList.add('hidden');
    if (dashboardView) dashboardView.classList.add('hidden');
    if (graphView) graphView.classList.add('hidden');
    hideIntegrationsView();
    if (perfilView) perfilView.classList.add('hidden');
    graphStop();

    if (projectView) {
        projectView.classList.remove('hidden');
        projectView.style.animation = 'none';
        projectView.offsetHeight;
        projectView.style.animation = null;
    }

    if (projectTitle) projectTitle.textContent = `#${tag}`;
    document.querySelector('.task-input-container').style.display = 'none';
    renderTasks();
}

// ── Criação rápida (Enter no input) ───────────────────────────────
// 4. Lógica de Tarefas: Adicionar ao apertar Enter
if (taskInput) {
    taskInput.addEventListener('keypress', async (e) => {
        if (e.key === 'Enter') {
            const text = taskInput.value.trim();
            if (text && state.currentCategory !== null) {
                
                try {
                    // Manda para o Backend (API)
                    const response = await apiFetch('/api/tasks', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ project: state.currentCategory, text: text })
                    });
                    
                    if (response.ok) {
                        const newTask = await response.json(); // Vem com o ID do banco
                        state.tasksData[state.currentCategory].push(newTask);
                        taskInput.value = '';
                        renderTasks();
                        showToast("Tarefa salva");
                    }
                } catch (err) {
                    console.error("Erro ao criar task:", err);
                }
            }
        }
    });
}

// ── Reordenação por drag-and-drop dentro da lista ─────────────────
// ----------------------------------------------------
// REORDENAÇÃO MANUAL (DRAG AND DROP DENTRO DA LISTA)
// ----------------------------------------------------
if (taskList) {
    taskList.addEventListener('dragover', e => {
        // Não permite reordenar na visão de semana (mistura projetos e quebra consistência de ranking)
        if (state.currentWeekDay) return;
        e.preventDefault(); // Necessário para permitir soltar na lista
        const afterElement = getDragAfterElement(taskList, e.clientY);
        const draggable = document.querySelector('.dragging');
        if (!draggable) return;

        if (afterElement == null) {
            taskList.appendChild(draggable);
        } else {
            taskList.insertBefore(draggable, afterElement);
        }
    });

    taskList.addEventListener('dragend', () => {
         // Não reordena na visão da semana e só faz sentido reordenar dentro de um projeto
         if (state.currentWeekDay || !state.currentCategory) return;
         // Quando soltar após misturar as visões, captura todas as LIs e a nova ordem
         const sortedLiIds = Array.from(taskList.querySelectorAll('.task-item')).map(li => li.getAttribute('data-id'));
         
         // Cria payload para atualizar no servidor as posições 
         // (usando o index real de onde parou)
         const payload = sortedLiIds.map((id, idx) => ({ id: id, position: idx }));
         
         // Atualiza memória RAM (arrays) para se alinhar com a tela se estiver num projeto
         // Ordena o array atual baseado na nova ordem de IDs visualizadas
         state.tasksData[state.currentCategory].sort((a, b) => {
             return sortedLiIds.indexOf(a.id.toString()) - sortedLiIds.indexOf(b.id.toString());
         });

         if (payload.length > 0) {
             apiFetch('/api/tasks/reorder', {
                 method: 'PUT',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify(payload)
             });
         }
    });
}

function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.task-item:not(.dragging)')];
    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        // Calcula o centro do elemento abaixo
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// ── Render principal da lista ─────────────────────────────────────
export function renderTasks() {
    if (!taskList) return;
    
    taskList.innerHTML = ''; // Limpa a lista
    let tasks = [];
    let isWeekView = false;
    let isTagView = false;
    
    if (state.currentWeekDay) {
        isWeekView = true;
        Object.keys(state.tasksData).forEach(proj => {
            state.tasksData[proj].forEach(t => {
                if (t.due_date === state.currentWeekDay && !t.deleted) {
                    t.originalProject = proj; // Grava o nome pra exibição
                    tasks.push(t);
                }
            });
        });
    } else if (state.currentTag) {
        isTagView = true;
        const wanted = String(state.currentTag || '').toLowerCase();
        const tagRe = /(^|\s)#([\w\u00C0-\u00FF]+)/g;

        const hasWanted = (text) => {
            const s = String(text || '');
            let m;
            while ((m = tagRe.exec(s)) !== null) {
                const t = String(m[2] || '').toLowerCase();
                if (t === wanted) return true;
            }
            return false;
        };

        Object.keys(state.tasksData).forEach(proj => {
            state.tasksData[proj].forEach(t => {
                if (t.deleted) return;
                if (!hasWanted(t.text)) return;
                t.originalProject = proj;
                tasks.push(t);
            });
        });
    } else if (state.currentCategory) {
        tasks = (state.tasksData[state.currentCategory] || []).filter(t => !t.deleted);
    } else {
        return;
    }

    tasks.forEach((task, index) => {
        const li = document.createElement('li');
        li.className = `task-item ${task.completed ? 'completed' : ''}`;
        li.setAttribute('draggable', 'true'); // Ativa a API nativa de Drag
        li.setAttribute('data-id', task.id); // Guardamos a chave pra reordenação

        // Dispara ao Começar a Arrastar (CSS e Dados)
        li.addEventListener('dragstart', (e) => {
            li.classList.add('dragging');
            e.dataTransfer.setData('text/plain', task.id.toString());
            e.dataTransfer.effectAllowed = 'move';
        });

        // Dispara ao Terminar de Arrastar (Limpa CSS visual)
        li.addEventListener('dragend', () => {
            li.classList.remove('dragging');
            // O disparo de reordenação real da lista ocorrerá no dragend superior (taskList)
        });
        
        // Layout de cada item
        // APLICAÇÃO DE SEGURANÇA MÁXIMA (escapeHTML) NO RENDER:
        const dateBadge = task.created_date ? `<span class="task-date">${escapeHTML(task.created_date)}</span>` : '';
        const dueBadge = task.due_date && !isWeekView ? `<span class="task-date" style="color: #8b5cf6; font-weight: 700;">${escapeHTML(task.due_date)}</span>` : '';
        const isCrossView = isWeekView || isTagView;
        const projectBadge = isCrossView ? `<span style="font-size: 0.65rem; color: #fff; background: #64748b; padding: 2px 6px; border-radius: 4px; margin-right: 8px; text-transform: uppercase;">${escapeHTML(task.originalProject)}</span>` : '';
        
        // Processa as tags (#) no texto para renderizar badges visuais
        let escapedText = escapeHTML(task.text);
        
        // Renderiza [ ] e [x] como checkboxes reais injetados no HTML
        let formattedText = escapedText.replace(/\[\s?\]/g, '<input type="checkbox" class="subtask-box">');
        formattedText = formattedText.replace(/\[[xX]\]/g, '<input type="checkbox" class="subtask-box" checked>');
        
        formattedText = formattedText.replace(/(^|\s)#([\w\u00C0-\u00FF]+)/g, '$1<span class="task-tag">#$2</span>');
        
        let actionButtonsHTML = `
            <button class="action-btn edit-btn">Editar</button>
            <button class="action-btn delete-btn">Apagar</button>
        `;

        li.innerHTML = `
            <button class="task-checkbox" aria-label="Marcar como concluído"></button>
            ${projectBadge}
            <span class="task-text">${formattedText}</span>
            ${dueBadge}
            ${dateBadge}
            <div class="task-actions">
                ${actionButtonsHTML}
            </div>
        `;

        // Ações:
        const checkbox = li.querySelector('.task-checkbox');
        const deleteBtn = li.querySelector('.delete-btn');
        const editBtn = li.querySelector('.edit-btn');
        const textSpan = li.querySelector('.task-text');

        // Marcar / Desmarcar (atualização cirúrgica — sem re-renderizar toda a lista)
        checkbox.addEventListener('click', () => {
            const novoStatus = !task.completed;
            task.completed = novoStatus;

            // Atualiza só o li clicado, sem tocar nos demais
            li.classList.toggle('completed', novoStatus);
            checkbox.classList.toggle('checked', novoStatus);

            apiFetch(`/api/tasks/${task.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ completed: novoStatus })
            });
        });

        // Sub-tarefas (Micro-passos dinâmicos baseados no texto)
        const subboxes = li.querySelectorAll('.subtask-box');
        subboxes.forEach((box, i) => {
            box.addEventListener('click', (e) => {
                e.stopPropagation(); // Evita que clique na linha inteira ative outras coisas
                const isClosed = box.checked;
                let matchIndex = 0;
                
                // Varre o texto original para substituir APENAS a checkbox que ele clicou pelo index
                task.text = task.text.replace(/\[\s?\]|\[[xX]\]/g, (match) => {
                    if (matchIndex === i) {
                        matchIndex++;
                        return isClosed ? '[X]' : '[ ]';
                    }
                    matchIndex++;
                    return match;
                });
                
                // Salva no banco "silenciosamente" o novo texto com o [X] alterado
                apiFetch(`/api/tasks/${task.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: task.text })
                });
            });
        });

        // Apagar
        deleteBtn.addEventListener('click', () => {
            const proj = task.originalProject || state.currentCategory;
            const projTasks = state.tasksData[proj];
            const realIndex = projTasks.findIndex(t => t.id === task.id);
            if (realIndex > -1) projTasks.splice(realIndex, 1);
            
            renderTasks();
            apiFetch(`/api/tasks/${task.id}`, { method: 'DELETE' });
            showToast("Tarefa removida");
        });

        // Editar (Transformar span em input momentâneo)
        if (editBtn) {
            editBtn.addEventListener('click', () => {
            // Esconde as ações e troca contexto
            li.querySelector('.task-actions').classList.add('hidden');
            
            const editInput = document.createElement('input');
            editInput.type = 'text';
            editInput.className = 'edit-task-input';
            editInput.value = task.text;
            editInput.style.flex = '1';
            editInput.style.border = '1px solid #cbd5e1';
            editInput.style.padding = '4px 8px';
            editInput.style.borderRadius = '6px';
            
            const editDue = document.createElement('select');
            editDue.className = 'edit-task-due';
            editDue.style.marginLeft = '8px';
            editDue.style.padding = '4px';
            editDue.style.borderRadius = '6px';
            editDue.style.border = '1px solid #cbd5e1';
            editDue.style.color = '#475569';
            
            const days = ['', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta'];
            days.forEach(d => {
                const opt = document.createElement('option');
                opt.value = d;
                opt.textContent = d || 'Sem prazo';
                if (task.due_date === d) opt.selected = true;
                editDue.appendChild(opt);
            });
            
            // Substitui visualmente textSpan pelos inputs
            li.insertBefore(editInput, textSpan);
            li.insertBefore(editDue, textSpan);
            textSpan.style.display = 'none';
            
            if (li.querySelector('.task-date')) li.querySelector('.task-date').style.display = 'none'; // esconde badges
            
            editInput.focus();

            // Lógica ao salvar a edição (perder foco ou apertar enter)
            const saveEdit = () => {
                const newText = editInput.value.trim();
                const newDue = editDue.value;
                let payload = {};
                let changed = false;

                if (newText && newText !== task.text) {
                    task.text = newText;
                    payload.text = newText;
                    changed = true;
                }
                if (newDue !== (task.due_date || '')) {
                    task.due_date = newDue;
                    payload.due_date = newDue;
                    changed = true;
                }
                
                if (changed) {
                    renderTasks(); // Altera suave sem piscar
                    
                    // Atualiza no banco no modo silencioso
                    apiFetch(`/api/tasks/${task.id}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                } else {
                    renderTasks();
                }
            };

            let blurTimeout;
            const handleBlur = () => {
                clearTimeout(blurTimeout);
                blurTimeout = setTimeout(() => {
                    if (document.activeElement !== editInput && document.activeElement !== editDue) {
                        saveEdit();
                    }
                }, 100);
            };

            editInput.addEventListener('blur', handleBlur);
            editDue.addEventListener('blur', handleBlur);
            
            editInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    saveEdit();
                } else if (e.key === 'Escape') {
                    // Cancela edição voltando o texto original
                    renderTasks(); 
                }
            });
        });
        }

        // Efeito visual extra no JS: linha acaba de ser renderizada (fade in suave)
        li.style.opacity = '0';
        li.style.transform = 'translateY(8px)';
        requestAnimationFrame(() => {
            li.style.transition = 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)';
            li.style.opacity = '1';
            li.style.transform = 'translateY(0)';
        });

        taskList.appendChild(li);
    });
}
