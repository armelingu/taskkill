/**
 * Referências de DOM compartilhadas entre os módulos de feature e o main.
 * São os elementos "âncora" estáticos do index.html (uma única instância cada),
 * resolvidos no import (módulos são deferidos, então o HTML já foi parseado).
 *
 * Elementos criados dinamicamente (itens de projeto, cards, etc.) NÃO vivem aqui.
 */

export const skeletonItems = document.querySelectorAll('.skeleton-item');
export const emptyState    = document.getElementById('empty-state');
export const projectView   = document.getElementById('project-view');
export const projectTitle  = document.getElementById('project-title');
export const taskList       = document.getElementById('task-list');
export const taskInput      = document.getElementById('new-task-input');
export const graphView      = document.getElementById('graph-view');
export const graphCanvas    = document.getElementById('graph-canvas');
export const perfilView     = document.getElementById('perfil-view');
export const dashboardView  = document.getElementById('dashboard-view');
export const projectList    = document.getElementById('project-list');
