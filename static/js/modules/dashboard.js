/**
 * Dashboard: um card por projeto com contadores (aberto/feito/soma).
 * Leaf de leitura — lê state.tasksData e o menu lateral (.project-nav);
 * clicar num card delega ao item correspondente do sidebar. Extraído de main.js.
 */

import { escapeHTML, normText } from './util.js';
import { state } from './state.js';

export function renderDashboard() {
    const grid = document.getElementById('project-cards-grid');
    if (!grid) return;
    grid.innerHTML = ''; // Limpar antes de popular

    // Captura todos os nomes dos projetos pelo menu pra garantir que apareçam mesmo vazios
    const projectItems = document.querySelectorAll('.project-nav');
    
    projectItems.forEach(item => {
        const projectName = normText(item.textContent);
        const tasks = (state.tasksData[projectName] || []).filter(t => !t.deleted); 
        
        const total = tasks.length;
        const completed = tasks.filter(t => t.completed).length;
        const open = total - completed;

        // Define sutilmente a cor do "LED" de estado do projeto
        let statusClass = 'empty'; 
        if (total > 0 && open === 0) statusClass = 'done'; 
        else if (open > 0) statusClass = 'active'; 

        const card = document.createElement('div');
        card.className = 'project-card';
        
        card.innerHTML = `
            <div class="project-card-header">
                <h3 class="project-card-title">${escapeHTML(projectName)}</h3>
                <div class="project-status-dot ${statusClass}"></div>
            </div>
            <div class="project-card-metrics">
                <div class="card-stat">
                    <span class="card-stat-label">Em Aberto</span>
                    <span class="card-stat-value blue">${open}</span>
                </div>
                <div class="card-stat">
                    <span class="card-stat-label">Feitas</span>
                    <span class="card-stat-value green">${completed}</span>
                </div>
                <div class="card-stat" style="margin-left: auto; text-align: right; opacity: 0.5;">
                    <span class="card-stat-label">Soma</span>
                    <span class="card-stat-value" style="font-size: 1.1rem;">${total}</span>
                </div>
            </div>
        `;

        // Micro-Interação: Clicar num card atua como atalho rápido
        card.addEventListener('click', () => {
            item.click(); // Trigger simula que o usuario clicou no menu lateral
        });

        grid.appendChild(card);
    });
}
