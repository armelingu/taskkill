/**
 * Tarefas: render da lista (projeto/semana/#tag), criação via input, edição
 * inline, subtarefas ([ ]/[x]), toggle/delete, drag-drop de reordenação e a
 * visão por #tag (openTagView, aberta a partir do grafo). Extraído de main.js.
 *
 * Auto-liga o input de nova tarefa e o DnD da lista no import.
 */

import { state } from './state.js';
import { escapeHTML, formatBR, weekdayLong } from './util.js';
import { parseQuickAdd } from './nlp.js';
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
    state.currentWeekDate = null;

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
// Preview ao vivo do prazo detectado pela linguagem natural (Quick Add).
function updateQuickAddHint() {
    const hint = document.getElementById('quick-add-hint');
    if (!hint || !taskInput) return;
    const { due_date } = parseQuickAdd(taskInput.value);
    if (due_date) {
        hint.textContent = `Prazo: ${weekdayLong(due_date)}, ${formatBR(due_date)}`;
        hint.classList.remove('hidden');
    } else {
        hint.textContent = '';
        hint.classList.add('hidden');
    }
}

if (taskInput) {
    taskInput.addEventListener('input', updateQuickAddHint);

    taskInput.addEventListener('keypress', async (e) => {
        if (e.key === 'Enter') {
            // Quick Add: extrai a data em linguagem natural e limpa o texto.
            const { text, due_date } = parseQuickAdd(taskInput.value);
            if (text && state.currentCategory !== null) {
                const payload = { project: state.currentCategory, text };
                if (due_date) payload.due_date = due_date;

                try {
                    // Manda para o Backend (API)
                    const response = await apiFetch('/api/tasks', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                    
                    if (response.ok) {
                        const newTask = await response.json(); // Vem com o ID do banco
                        state.tasksData[state.currentCategory].push(newTask);
                        taskInput.value = '';
                        updateQuickAddHint();
                        renderTasks();
                        showToast(due_date ? `Tarefa salva para ${formatBR(due_date)}` : 'Tarefa salva', { variant: 'success' });
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
        if (state.currentWeekDate) return;
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
         if (state.currentWeekDate || !state.currentCategory) return;
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

    // Ao trocar de visão (projeto/tag/dia), zera a navegação por teclado para
    // o anel de foco não "vazar" entre listas diferentes.
    const viewKey = state.currentWeekDate ? `w:${state.currentWeekDate}`
        : state.currentTag ? `t:${state.currentTag}`
        : state.currentCategory ? `p:${state.currentCategory}` : null;
    if (viewKey !== _lastViewKey) {
        _navIndex = -1;
        _navEngaged = false;
        _lastViewKey = viewKey;
    }

    taskList.innerHTML = ''; // Limpa a lista
    let tasks = [];
    let isWeekView = false;
    let isTagView = false;
    
    if (state.currentWeekDate) {
        isWeekView = true;
        Object.keys(state.tasksData).forEach(proj => {
            state.tasksData[proj].forEach(t => {
                if (t.due_date === state.currentWeekDate && !t.deleted) {
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

    // Estado vazio sob medida por visão (dia/semana, #tag ou projeto).
    if (tasks.length === 0) {
        taskList.appendChild(_makeEmptyState({ isWeekView, isTagView }));
        _syncNavAfterRender();
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
        const dueBadge = task.due_date && !isWeekView ? `<span class="task-date task-due-badge">${escapeHTML(formatBR(task.due_date) || task.due_date)}</span>` : '';
        const isCrossView = isWeekView || isTagView;
        const projectBadge = isCrossView ? `<span class="task-project-badge">${escapeHTML(task.originalProject)}</span>` : '';
        
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

        // Apagar (soft-delete no back) — oferece "Desfazer" no toast.
        deleteBtn.addEventListener('click', () => {
            const proj = task.originalProject || state.currentCategory;
            const projTasks = state.tasksData[proj] || [];
            const realIndex = projTasks.findIndex(t => t.id === task.id);
            const removed = realIndex > -1 ? projTasks.splice(realIndex, 1)[0] : task;

            renderTasks();
            apiFetch(`/api/tasks/${task.id}`, { method: 'DELETE' });

            showToast('Tarefa removida', {
                action: {
                    label: 'Desfazer',
                    onClick: () => {
                        const arr = state.tasksData[proj] || (state.tasksData[proj] = []);
                        const at = Math.min(realIndex < 0 ? arr.length : realIndex, arr.length);
                        arr.splice(at, 0, removed);
                        removed.deleted = false;
                        apiFetch(`/api/tasks/${task.id}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ deleted: 0 }),
                        });
                        renderTasks();
                        showToast('Tarefa restaurada', { variant: 'success' });
                    },
                },
            });
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

            const editDue = document.createElement('input');
            editDue.type = 'date';
            editDue.className = 'edit-task-due';
            editDue.title = 'Prazo (data)';
            editDue.setAttribute('aria-label', 'Prazo da tarefa');
            // Aceita apenas ISO YYYY-MM-DD; vazio = sem prazo.
            editDue.value = /^\d{4}-\d{2}-\d{2}$/.test(task.due_date || '') ? task.due_date : '';
            
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

    _syncNavAfterRender();
}

// Monta o estado vazio contextual (mensagem + dica) para a lista.
function _makeEmptyState({ isWeekView, isTagView }) {
    let title;
    let hint;
    if (isWeekView) {
        title = `Nada agendado para ${weekdayLong(state.currentWeekDate)}.`;
        hint = 'Arraste uma tarefa para este dia na faixa da semana ao lado.';
    } else if (isTagView) {
        title = `Nenhuma tarefa com #${state.currentTag}.`;
        hint = 'As #tags aparecem aqui quando você as usa no texto de uma tarefa.';
    } else {
        title = 'Sem tarefas por aqui ainda.';
        hint = 'Pressione N ou comece a digitar acima para criar a primeira.';
    }

    const li = document.createElement('li');
    li.className = 'task-empty';
    li.setAttribute('role', 'note');

    const icon = document.createElement('div');
    icon.className = 'task-empty-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="3.5" y="4.5" width="17" height="15" rx="3" stroke="currentColor" stroke-width="1.6"/>
        <path d="M8 10h8M8 14h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    </svg>`;

    const t = document.createElement('p');
    t.className = 'task-empty-title';
    t.textContent = title;

    const h = document.createElement('p');
    h.className = 'task-empty-hint';
    h.textContent = hint;

    li.appendChild(icon);
    li.appendChild(t);
    li.appendChild(h);
    return li;
}

// ── Navegação por teclado na lista (estilo Linear) ────────────────
// j/k ou setas movem a seleção; x conclui, e edita, d edita e foca a data,
// Backspace/Delete remove. O anel só aparece após a 1ª tecla de navegação.
let _navIndex = -1;
let _navEngaged = false;
let _lastViewKey = null;

function _taskLis() {
    return taskList ? Array.from(taskList.querySelectorAll('.task-item')) : [];
}

function _applyNavHighlight() {
    const lis = _taskLis();
    lis.forEach((li, i) => li.classList.toggle('task-nav-active', _navEngaged && i === _navIndex));
    if (_navEngaged && _navIndex >= 0 && lis[_navIndex]) {
        lis[_navIndex].scrollIntoView({ block: 'nearest' });
    }
}

function _syncNavAfterRender() {
    const lis = _taskLis();
    if (!lis.length) { _navIndex = -1; _navEngaged = false; return; }
    if (_navIndex >= lis.length) _navIndex = lis.length - 1;
    if (_navEngaged && _navIndex < 0) _navIndex = 0;
    _applyNavHighlight();
}

function _moveNav(delta) {
    const lis = _taskLis();
    if (!lis.length) { _navIndex = -1; _navEngaged = false; return; }
    if (!_navEngaged) {
        _navEngaged = true;
        if (_navIndex < 0 || _navIndex >= lis.length) _navIndex = 0;
        _applyNavHighlight();
        return;
    }
    _navIndex = (_navIndex + delta + lis.length) % lis.length;
    _applyNavHighlight();
}

function _navTyping() {
    const el = document.activeElement;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

function _overlayOpen() {
    return !!document.querySelector(
        '.palette-overlay:not(.hidden), .shortcuts-overlay:not(.hidden), .project-confirm-overlay:not(.hidden)'
    );
}

function _listActive() {
    if (!projectView || projectView.classList.contains('hidden')) return false;
    if (!(state.currentCategory || state.currentTag || state.currentWeekDate)) return false;
    return _taskLis().length > 0;
}

document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (_navTyping() || _overlayOpen() || !_listActive()) return;

    const lis = _taskLis();
    const engaged = () => _navEngaged && _navIndex >= 0 && lis[_navIndex];

    switch (e.key) {
        case 'j': case 'ArrowDown': e.preventDefault(); _moveNav(1); break;
        case 'k': case 'ArrowUp': e.preventDefault(); _moveNav(-1); break;
        case 'x':
            if (engaged()) { e.preventDefault(); lis[_navIndex].querySelector('.task-checkbox')?.click(); }
            break;
        case 'e': case 'Enter':
            if (engaged()) { e.preventDefault(); lis[_navIndex].querySelector('.edit-btn')?.click(); }
            break;
        case 'd':
            if (engaged()) {
                e.preventDefault();
                lis[_navIndex].querySelector('.edit-btn')?.click();
                const due = lis[_navIndex].querySelector('.edit-task-due');
                if (due) due.focus();
            }
            break;
        case 'Backspace': case 'Delete':
            if (engaged()) { e.preventDefault(); lis[_navIndex].querySelector('.delete-btn')?.click(); }
            break;
        default:
            break;
    }
});
