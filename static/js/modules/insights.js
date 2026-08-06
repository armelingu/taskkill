/**
 * Insights: aba do Dashboard com métricas pessoais (throughput semanal, streak
 * e tarefas que pedem atenção). Lê GET /api/insights e desenha tudo em vanilla
 * (barras em CSS, sem lib de chart). Cada abertura da aba refaz o fetch, já que
 * concluir uma tarefa muda os números.
 */

import { apiFetch } from './api.js';
import { escapeHTML } from './util.js';

const PANEL_ID = 'dashboard-insights-panel';

function fmtPct(rate) {
    return `${Math.round((rate || 0) * 100)}%`;
}

// 'YYYY-MM-DD' -> 'DD/MM' (rótulo curto de semana).
function weekLabel(iso) {
    const [, m, d] = (iso || '').split('-');
    return d && m ? `${d}/${m}` : (iso || '');
}

function statCard(value, label, sub) {
    return `
        <div class="ins-stat">
            <span class="ins-stat-value">${escapeHTML(String(value))}</span>
            <span class="ins-stat-label">${escapeHTML(label)}</span>
            ${sub ? `<span class="ins-stat-sub">${escapeHTML(sub)}</span>` : ''}
        </div>`;
}

function throughputChart(throughput) {
    const total = throughput.reduce((acc, w) => acc + w.count, 0);
    if (total === 0) {
        return `<p class="ins-empty">Conclua tarefas para começar a ver seu ritmo semanal aqui.</p>`;
    }
    const max = Math.max(1, ...throughput.map((w) => w.count));
    const cols = throughput.map((w) => {
        const pct = w.count === 0 ? 0 : Math.max(6, Math.round((w.count / max) * 100));
        const on = w.count > 0 ? ' is-on' : '';
        return `
            <div class="tp-col" title="Semana de ${escapeHTML(weekLabel(w.week))}: ${w.count} concluída(s)">
                <div class="tp-bar-wrap">
                    <span class="tp-count">${w.count || ''}</span>
                    <div class="tp-bar${on}" style="height:${pct}%"></div>
                </div>
                <span class="tp-xlabel">${escapeHTML(weekLabel(w.week))}</span>
            </div>`;
    }).join('');
    return `<div class="tp-chart" role="img" aria-label="Tarefas concluídas por semana">${cols}</div>`;
}

function agingList(aging) {
    if (!aging.length) {
        return `<p class="ins-empty">Nada parado. Sua fila está em dia.</p>`;
    }
    const items = aging.map((t) => {
        const badges = [];
        if (t.overdue) badges.push(`<span class="aging-badge overdue">Atrasada</span>`);
        if (t.blocked_by > 0) badges.push(`<span class="aging-badge blocked">Bloqueada por ${t.blocked_by}</span>`);
        if (t.age_days != null) badges.push(`<span class="aging-badge age">${t.age_days} ${t.age_days === 1 ? 'dia' : 'dias'}</span>`);
        return `
            <li class="aging-item" data-project="${escapeHTML(t.project || '')}">
                <div class="aging-main">
                    <span class="aging-text">${escapeHTML(t.text || '')}</span>
                    <span class="aging-project">${escapeHTML(t.project || '')}</span>
                </div>
                <div class="aging-meta">${badges.join('')}</div>
            </li>`;
    }).join('');
    return `<ul class="aging-list">${items}</ul>`;
}

function template(data) {
    const s = data.summary || {};
    const streak = data.streak || { current: 0, best: 0 };
    return `
        <div class="insights">
            <div class="ins-stats">
                ${statCard(s.done_7d ?? 0, 'Concluídas · 7 dias')}
                ${statCard(fmtPct(s.completion_rate), 'Taxa de conclusão')}
                ${statCard(streak.current ?? 0, 'Sequência (dias)', `melhor: ${streak.best ?? 0}`)}
                ${statCard(s.oldest_open_days ?? 0, 'Aberta mais antiga (dias)', `${s.open_count ?? 0} em aberto`)}
            </div>
            <div class="ins-grid">
                <section class="ins-card ins-throughput">
                    <header class="ins-card-head">
                        <h3>Ritmo semanal</h3>
                        <span class="ins-hint">concluídas por semana · últimas 12</span>
                    </header>
                    ${throughputChart(data.throughput || [])}
                </section>
                <section class="ins-card ins-aging">
                    <header class="ins-card-head">
                        <h3>Precisam de atenção</h3>
                        <span class="ins-hint">mais antigas e atrasadas</span>
                    </header>
                    ${agingList(data.aging || [])}
                </section>
            </div>
        </div>`;
}

// Clicar numa tarefa em atenção leva ao projeto dela (mesmo atalho dos cards).
function wireAgingNav(panel) {
    panel.querySelectorAll('.aging-item').forEach((li) => {
        li.addEventListener('click', () => {
            const project = li.getAttribute('data-project');
            if (!project) return;
            const nav = Array.from(document.querySelectorAll('.project-nav'))
                .find((el) => el.textContent.trim() === project);
            if (nav) nav.click();
        });
    });
}

export async function renderInsights() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.innerHTML = `<p class="ins-loading">Carregando insights…</p>`;
    try {
        const resp = await apiFetch('/api/insights');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        panel.innerHTML = template(data);
        wireAgingNav(panel);
    } catch (err) {
        panel.innerHTML = `<p class="ins-empty">Não foi possível carregar os insights agora.</p>`;
    }
}
