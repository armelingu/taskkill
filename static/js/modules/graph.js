/**
 * Grafo (estilo Obsidian): força-dirigido ligando Dias <-> Projetos, Projetos
 * <-> Tags e Projetos <-> Projetos. Todo o render/interação (pan/zoom/hover/
 * arrastar) vive aqui. O modelo puro (nós+arestas) vem de graph-model.js.
 *
 * Auto-liga os eventos no import (attachGraphEvents). Exporta start/stop, usados
 * pelo main (navegação) e por openTagView (tasks.js).
 */

import { state } from './state.js';
import { buildGraphModel } from './graph-model.js';
import { escapeHTML, normText, weekdayShort } from './util.js';
import { graphView, graphCanvas } from './dom.js';
import { openTagView } from './tasks.js';

// ----------------------------------------------------
// GRAFO (Obsidian-like): Dias <-> Projetos + Projetos <-> Projetos
// ----------------------------------------------------
const graph = {
    raf: 0,
    running: false,
    model: null,
    hoverId: null,
    dragId: null,
    isPanning: false,
    moved: false,
    pan: { x: 0, y: 0 },
    scale: 1,
    last: { x: 0, y: 0 },
    dimProgress: 0,   // 0 = sem dim; 1 = dim total — animado suavemente
    dimRaf: 0,        // RAF exclusivo para animação de fade
    // Toque (Pointer Events): ponteiros ativos + estado de pinça. Enquanto um
    // gesto de toque acontece, ignoramos os eventos de mouse "sintéticos".
    pointers: new Map(),
    pinch: null,
    ignoreMouse: false,
    ignoreTimer: 0,
};

function graphResize() {
    if (!graphCanvas) return;
    const dpr = Math.max(1, (window.devicePixelRatio || 1));
    const rect = graphCanvas.getBoundingClientRect();
    graphCanvas.width = Math.max(1, Math.floor(rect.width * dpr));
    graphCanvas.height = Math.max(1, Math.floor(rect.height * dpr));
    const ctx = graphCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function worldToScreen(x, y) {
    return { x: x * graph.scale + graph.pan.x, y: y * graph.scale + graph.pan.y };
}

function screenToWorld(x, y) {
    return { x: (x - graph.pan.x) / graph.scale, y: (y - graph.pan.y) / graph.scale };
}

function graphHit(mx, my) {
    if (!graph.model) return null;
    const p = screenToWorld(mx, my);
    let best = null;
    let bestD = Infinity;
    for (const n of graph.model.nodes) {
        const dx = p.x - n.x;
        const dy = p.y - n.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        const rr = (n.r + 6) / graph.scale;
        if (d < rr && d < bestD) {
            best = n;
            bestD = d;
        }
    }
    return best;
}

// Navegação ao "clicar"/tocar num nó (compartilhada por mouse e toque).
function navigateFromNode(id) {
    if (!graph.model) return;
    const node = graph.model.nodes.find(n => n.id === id);
    if (!node) return;
    if (node.type === 'day') {
        // node.key é o dia da semana (Seg…Dom); abre o chip correspondente na
        // semana visível da faixa lateral.
        const chip = Array.from(document.querySelectorAll('.week-day'))
            .find(el => weekdayShort(el.getAttribute('data-date')) === node.key);
        if (chip) chip.click();
    } else if (node.type === 'project') {
        const items = Array.from(document.querySelectorAll('.project-nav'));
        const target = items.find(it => normText(it.textContent) === node.key);
        if (target) target.click();
    } else if (node.type === 'task') {
        // Abre o projeto da tarefa (a lista mostra a tarefa e seus vínculos).
        const items = Array.from(document.querySelectorAll('.project-nav'));
        const target = items.find(it => normText(it.textContent) === node.projectKey);
        if (target) target.click();
    } else if (node.type === 'tag') {
        openTagView(node.key);
    }
}

// Lerp linear entre dois valores
function _lerp(a, b, t) { return a + (b - a) * t; }

// ---- Paleta ciente do tema -------------------------------------------------
// O canvas 2D não lê CSS vars diretamente; extraímos os tokens --graph-* como
// "r,g,b" (para combinar com o alpha dinâmico) e recacheamos ao trocar o tema.
let _palette = null;

function _hexToRgb(hex) {
    hex = (hex || '').trim().replace(/^#/, '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    if (hex.length !== 6) return null;
    const n = parseInt(hex, 16);
    if (Number.isNaN(n)) return null;
    return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

function refreshGraphPalette() {
    const cs = getComputedStyle(document.documentElement);
    const g = (name, fb) => _hexToRgb(cs.getPropertyValue(name)) || fb;
    _palette = {
        edgeSchedule: g('--graph-edge-schedule', '100,116,139'),
        edgeTaglink:  g('--graph-edge-taglink', '59,130,246'),
        edgeDependency: g('--graph-edge-dependency', '217,119,6'),
        dayFill:      g('--graph-node-day-fill', '226,232,240'),
        tagFill:      g('--graph-node-tag-fill', '239,246,255'),
        projFill:     g('--graph-node-project-fill', '255,255,255'),
        taskFill:     g('--graph-node-task-fill', '254,243,199'),
        dayStroke:    g('--graph-node-day-stroke', '100,116,139'),
        tagStroke:    g('--graph-node-tag-stroke', '59,130,246'),
        projStroke:   g('--graph-node-project-stroke', '59,130,246'),
        taskStroke:   g('--graph-node-task-stroke', '217,119,6'),
        label:        g('--graph-label', '15,23,42'),
    };
    return _palette;
}

function _pal() { return _palette || refreshGraphPalette(); }

function graphDraw() {
    if (!graphCanvas || !graph.model) return;
    const ctx = graphCanvas.getContext('2d');
    const rect = graphCanvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0, 0, w, h);

    const hov = graph.hoverId;
    const dp  = graph.dimProgress; // 0..1, animado suavemente
    const pal = _pal();

    // Pré-computa conjuntos conectados (só se houver hover)
    let connectedNodeIds = null;
    let connectedEdgeSet = null;
    if (hov && dp > 0.01) {
        connectedNodeIds = new Set([hov]);
        connectedEdgeSet = new Set();
        for (const e of graph.model.edges) {
            if (!e.na || !e.nb) continue;
            if (e.na.id === hov || e.nb.id === hov) {
                connectedNodeIds.add(e.na.id);
                connectedNodeIds.add(e.nb.id);
                connectedEdgeSet.add(e);
            }
        }
    }

    // ---- Arestas ------------------------------------------------
    for (const e of graph.model.edges) {
        if (!e.na || !e.nb) continue;
        const a = worldToScreen(e.na.x, e.na.y);
        const b = worldToScreen(e.nb.x, e.nb.y);
        const base =
            e.kind === 'schedule'   ? pal.edgeSchedule :
            e.kind === 'dependency' ? pal.edgeDependency :
            e.kind === 'taskproject' ? pal.taskStroke : pal.edgeTaglink;

        // alpha "normal" da aresta
        const alphaNormal = (
            e.kind === 'schedule'    ? 0.22 :
            e.kind === 'dependency'  ? 0.34 :
            e.kind === 'taskproject' ? 0.10 :
            e.kind === 'taglink'     ? 0.14 : 0.16
        ) + Math.min(0.12, e.weight * 0.015);

        const isConn = connectedEdgeSet && connectedEdgeSet.has(e);
        let edgeAlpha = alphaNormal;
        if (connectedEdgeSet) {
            edgeAlpha = isConn ? _lerp(alphaNormal, 0.70, dp) : _lerp(alphaNormal, 0.08, dp);
        }

        const lw = (e.kind === 'dependency' ? 1.6 : 1) + Math.min(2.0, e.weight * 0.22);
        ctx.strokeStyle = `rgba(${base},${edgeAlpha})`;
        ctx.lineWidth = isConn ? _lerp(lw, Math.max(lw, 2.2), dp) : lw;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();

        // Seta direcionada (pré-requisito -> dependente), recuada do nó destino.
        if (e.directed) {
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            const ux = dx / len, uy = dy / len;
            const gap = (e.nb.r + 4) * graph.scale;   // encosta na borda do nó destino
            const tipX = b.x - ux * gap;
            const tipY = b.y - uy * gap;
            const size = 7 * Math.min(1.4, Math.max(0.7, graph.scale));
            const ang = Math.atan2(uy, ux);
            ctx.fillStyle = `rgba(${base},${Math.min(1, edgeAlpha + 0.25)})`;
            ctx.beginPath();
            ctx.moveTo(tipX, tipY);
            ctx.lineTo(tipX - size * Math.cos(ang - 0.5), tipY - size * Math.sin(ang - 0.5));
            ctx.lineTo(tipX - size * Math.cos(ang + 0.5), tipY - size * Math.sin(ang + 0.5));
            ctx.closePath();
            ctx.fill();
        }
    }

    // ---- Nós + labels -------------------------------------------
    for (const n of graph.model.nodes) {
        const p = worldToScreen(n.x, n.y);
        const isHover  = hov === n.id;
        const isLinked = connectedNodeIds && connectedNodeIds.has(n.id);
        const isDimmed = connectedNodeIds && !isLinked;

        // Opacidade do nó: fade suave até 18% para os não-conectados
        const nodeOp = isDimmed ? _lerp(1, 0.18, dp) : 1;

        const fillBase  =
            n.type === 'day'  ? pal.dayFill :
            n.type === 'tag'  ? pal.tagFill :
            n.type === 'task' ? pal.taskFill : pal.projFill;
        const strokeBase =
            n.type === 'day'  ? pal.dayStroke :
            n.type === 'tag'  ? pal.tagStroke :
            n.type === 'task' ? pal.taskStroke : pal.projStroke;

        // Tarefa concluída: um pouco mais apagada (mantém contexto sem pesar).
        const doneFade = (n.type === 'task' && n.completed) ? 0.55 : 1;
        const fillA   = (isDimmed ? _lerp(0.95, 0.25, dp) : 0.97) * doneFade;
        const strokeA = isDimmed
            ? _lerp(isHover ? 0.65 : (n.type === 'day' ? 0.55 : 0.60), 0.12, dp)
            : (isHover ? 0.80 : (n.type === 'day' ? 0.55 : 0.60));

        // Raio: o nó hover cresce suavemente
        const r = isHover ? _lerp(n.r, n.r * 1.22, dp) : n.r;

        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle   = `rgba(${fillBase},${fillA})`;
        ctx.fill();
        ctx.lineWidth   = isHover ? _lerp(1.5, 2.6, dp) : 1.5;
        ctx.strokeStyle = `rgba(${strokeBase},${strokeA})`;
        ctx.stroke();

        // Label: dimmed some suavemente, hover fica em destaque
        const labelOp = isDimmed
            ? _lerp(0.78, 0.0, Math.min(1, dp * 1.4))  // some antes de chegar em dp=1
            : (isHover ? 1.0 : 0.78);

        if (labelOp > 0.02) {
            ctx.font = `600 ${n.type === 'day' ? 12 : 12.5}px Inter, system-ui, -apple-system, Segoe UI, sans-serif`;
            ctx.fillStyle   = `rgba(${pal.label},${labelOp})`;
            ctx.textBaseline = 'middle';
            ctx.fillText(n.label, p.x + r + 10, p.y);
        }
    }
}

// Anima graph.dimProgress suavemente (lerp a cada frame)
function _graphDimAnimate() {
    const target = graph.hoverId ? 1 : 0;
    const diff   = target - graph.dimProgress;
    if (Math.abs(diff) < 0.008) {
        graph.dimProgress = target;
        if (!graph.running) graphDraw();
        return;
    }
    graph.dimProgress += diff * 0.15; // velocidade do fade (~120ms)
    if (!graph.running) graphDraw();
    graph.dimRaf = requestAnimationFrame(_graphDimAnimate);
}

function graphStep() {
    if (!graph.model) return;
    const nodes = graph.model.nodes;
    const edges = graph.model.edges;

    const repulsion = 22000;
    const spring = 0.02;
    const center = 0.0025;
    const damping = 0.88;

    // Repulsão (N pequeno: ok)
    for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i];
            const b = nodes[j];
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            const dist2 = dx * dx + dy * dy + 0.01;
            const f = repulsion / dist2;
            const inv = 1 / Math.sqrt(dist2);
            const fx = dx * inv * f;
            const fy = dy * inv * f;
            a.vx += fx;
            a.vy += fy;
            b.vx -= fx;
            b.vy -= fy;
        }
    }

    // Molas nas arestas
    for (const e of edges) {
        if (!e.na || !e.nb) continue;
        const a = e.na;
        const b = e.nb;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) + 0.001;
        const target = 170 / Math.sqrt(Math.max(1, e.weight));
        const diff = (dist - target);
        const k = spring * (0.6 + e.weight * 0.05);
        const fx = (dx / dist) * diff * k;
        const fy = (dy / dist) * diff * k;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
    }

    let energy = 0;
    for (const n of nodes) {
        if (graph.dragId === n.id) {
            n.vx *= 0.2;
            n.vy *= 0.2;
            continue;
        }
        n.vx += (-n.x) * center;
        n.vy += (-n.y) * center;
        n.vx *= damping;
        n.vy *= damping;
        n.x += n.vx * 0.016;
        n.y += n.vy * 0.016;
        energy += Math.abs(n.vx) + Math.abs(n.vy);
    }

    graphDraw();

    if (!graph.running) return;
    if (energy < 0.25) {
        graph.running = false;
        return;
    }
    graph.raf = requestAnimationFrame(graphStep);
}

export function graphStart() {
    if (!graphCanvas || !graphView || graphView.classList.contains('hidden')) return;
    refreshGraphPalette();
    graphResize();
    const rect = graphCanvas.getBoundingClientRect();
    graph.pan.x = rect.width * 0.5;
    graph.pan.y = rect.height * 0.52;
    graph.scale = 1;
    // Os nós de "dia" são derivados do dia da semana das datas das tarefas
    // dentro do próprio modelo; não precisamos mais lê-los do DOM.
    const projects = Array.from(document.querySelectorAll('.project-nav'))
        .map(el => normText(el.textContent)).filter(Boolean);
    graph.model = buildGraphModel([], projects, state.tasksData);
    graph.running = true;
    cancelAnimationFrame(graph.raf);
    graph.raf = requestAnimationFrame(graphStep);
}

export function graphStop() {
    graph.running = false;
    cancelAnimationFrame(graph.raf);
    graph.raf = 0;
}

function attachGraphEvents() {
    if (!graphCanvas) return;
    const tooltip = document.getElementById('graph-tooltip');

    function showTooltip(node, mx, my) {
        if (!tooltip || !node) return;
        const typeLabel =
            node.type === 'day'     ? 'Dia' :
            node.type === 'project' ? 'Projeto' :
            node.type === 'task'    ? 'Tarefa' : 'Tag';
        let detail = '';
        if (node.type === 'task') {
            const edges = graph.model.edges || [];
            const dependsOn = edges.filter(e => e.kind === 'dependency' && e.b === node.id).length;
            const blocks = edges.filter(e => e.kind === 'dependency' && e.a === node.id).length;
            const parts = [];
            if (dependsOn) parts.push(`depende de ${dependsOn}`);
            if (blocks) parts.push(`desbloqueia ${blocks}`);
            const meta = parts.length ? parts.join(' · ') : 'sem dependências';
            detail = `<br><span class="gt-meta">${meta}</span>`;
        } else if (node.type === 'project') {
            const tc = (state.tasksData[node.key] || []).filter(t => !t.deleted).length;
            detail = `<br><span class="gt-meta">${tc} task${tc !== 1 ? 's' : ''}</span>`;
        } else if (node.type === 'day') {
            let cnt = 0;
            for (const tasks of Object.values(state.tasksData))
                cnt += tasks.filter(t => !t.deleted && String(t.due_date || '').trim() === node.key).length;
            detail = `<br><span class="gt-meta">${cnt} task${cnt !== 1 ? 's' : ''} agendada${cnt !== 1 ? 's' : ''}</span>`;
        } else {
            const deg = (graph.model.edges || []).filter(e => e.a === node.id || e.b === node.id).length;
            detail = `<br><span class="gt-meta">${deg} conexã${deg !== 1 ? 'ões' : 'o'}</span>`;
        }
        tooltip.innerHTML = `<span class="gt-type">${typeLabel}</span><strong>${escapeHTML(node.label)}</strong>${detail}`;
        tooltip.style.display = 'block';
        const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
        const cRect = graphCanvas.getBoundingClientRect();
        let tx = mx + 16, ty = my - 8;
        if (tx + tw > cRect.width  - 8) tx = mx - tw - 12;
        if (ty + th > cRect.height - 8) ty = my - th - 4;
        tooltip.style.left = tx + 'px';
        tooltip.style.top  = ty + 'px';
    }

    function hideTooltip() {
        if (tooltip) tooltip.style.display = 'none';
    }

    graphCanvas.addEventListener('mousemove', (e) => {
        if (graph.ignoreMouse) return;
        const rect = graphCanvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const hit = graphHit(mx, my);
        const prevHover = graph.hoverId;
        graph.hoverId = hit ? hit.id : null;
        graphCanvas.style.cursor = hit ? 'pointer' : (graph.isPanning ? 'grabbing' : 'grab');
        if (hit) showTooltip(hit, mx, my); else hideTooltip();
        // Dispara animação de fade apenas quando o hover muda
        if (prevHover !== graph.hoverId) {
            cancelAnimationFrame(graph.dimRaf);
            graph.dimRaf = requestAnimationFrame(_graphDimAnimate);
        }
        if (!graph.running) graphDraw();
    });

    graphCanvas.addEventListener('mouseleave', () => {
        hideTooltip();
        if (graph.hoverId) {
            graph.hoverId = null;
            cancelAnimationFrame(graph.dimRaf);
            graph.dimRaf = requestAnimationFrame(_graphDimAnimate);
        }
    });

    graphCanvas.addEventListener('mousedown', (e) => {
        if (graph.ignoreMouse) return;
        const rect = graphCanvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        graph.last.x = mx;
        graph.last.y = my;
        graph.moved = false;

        const hit = graphHit(mx, my);
        if (hit) {
            graph.dragId = hit.id;
        } else {
            graph.isPanning = true;
        }
        graphCanvas.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (e) => {
        if (!graphCanvas || graph.ignoreMouse) return;
        if (!graph.dragId && !graph.isPanning) return;
        const rect = graphCanvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const dx = mx - graph.last.x;
        const dy = my - graph.last.y;
        graph.last.x = mx;
        graph.last.y = my;
        if (Math.abs(dx) + Math.abs(dy) > 1) graph.moved = true;

        if (graph.isPanning) {
            graph.pan.x += dx;
            graph.pan.y += dy;
        } else if (graph.dragId && graph.model) {
            const node = graph.model.nodes.find(n => n.id === graph.dragId);
            if (node) {
                const w = screenToWorld(mx, my);
                node.x = w.x;
                node.y = w.y;
                node.vx = 0;
                node.vy = 0;
            }
        }
        if (!graph.running) graphDraw();
    });

    window.addEventListener('mouseup', () => {
        if (!graphCanvas || graph.ignoreMouse) return;
        if (!graph.dragId && !graph.isPanning) return;

        if (graph.dragId && !graph.moved) navigateFromNode(graph.dragId);

        graph.dragId = null;
        graph.isPanning = false;
        graphCanvas.style.cursor = 'grab';
    });

    graphCanvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = graphCanvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const before = screenToWorld(mx, my);
        const delta = -Math.sign(e.deltaY);
        const factor = delta > 0 ? 1.08 : 0.92;
        graph.scale = Math.max(0.55, Math.min(1.9, graph.scale * factor));
        const after = worldToScreen(before.x, before.y);
        graph.pan.x += (mx - after.x);
        graph.pan.y += (my - after.y);
        if (!graph.running) graphDraw();
    }, { passive: false });

    // ---- Toque (Pointer Events): 1 dedo = pan/arrastar nó · 2 dedos = pinça --
    // Só tratamos pointerType 'touch' aqui (mouse/caneta seguem nos handlers de
    // mouse). Enquanto houver toque, graph.ignoreMouse suprime eventos de mouse
    // sintéticos que o navegador dispara depois do gesto.
    function touchXY(e) {
        const rect = graphCanvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    graphCanvas.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'touch') return;
        e.preventDefault();
        if (graphCanvas.setPointerCapture) {
            try { graphCanvas.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
        }
        graph.ignoreMouse = true;
        clearTimeout(graph.ignoreTimer);
        const p = touchXY(e);
        graph.pointers.set(e.pointerId, p);

        if (graph.pointers.size === 1) {
            graph.last.x = p.x;
            graph.last.y = p.y;
            graph.moved = false;
            const hit = graphHit(p.x, p.y);
            if (hit) graph.dragId = hit.id; else graph.isPanning = true;
        } else if (graph.pointers.size === 2) {
            // Entra em pinça: cancela drag/pan de 1 dedo.
            graph.dragId = null;
            graph.isPanning = false;
            const pts = Array.from(graph.pointers.values());
            graph.pinch = {
                dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
            };
        }
    });

    graphCanvas.addEventListener('pointermove', (e) => {
        if (e.pointerType !== 'touch' || !graph.pointers.has(e.pointerId)) return;
        e.preventDefault();
        const p = touchXY(e);
        graph.pointers.set(e.pointerId, p);

        if (graph.pointers.size >= 2 && graph.pinch) {
            const pts = Array.from(graph.pointers.values());
            const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
            const newDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
            const before = screenToWorld(mid.x, mid.y);
            const factor = newDist / graph.pinch.dist;
            graph.scale = Math.max(0.55, Math.min(1.9, graph.scale * factor));
            const after = worldToScreen(before.x, before.y);
            graph.pan.x += (mid.x - after.x);
            graph.pan.y += (mid.y - after.y);
            graph.pinch.dist = newDist;
            if (!graph.running) graphDraw();
            return;
        }

        // 1 dedo: pan (fundo) ou arrastar o nó pego.
        const dx = p.x - graph.last.x;
        const dy = p.y - graph.last.y;
        graph.last.x = p.x;
        graph.last.y = p.y;
        if (Math.abs(dx) + Math.abs(dy) > 1) graph.moved = true;
        if (graph.isPanning) {
            graph.pan.x += dx;
            graph.pan.y += dy;
        } else if (graph.dragId && graph.model) {
            const node = graph.model.nodes.find(n => n.id === graph.dragId);
            if (node) {
                const w = screenToWorld(p.x, p.y);
                node.x = w.x;
                node.y = w.y;
                node.vx = 0;
                node.vy = 0;
            }
        }
        if (!graph.running) graphDraw();
    });

    function endTouch(e) {
        if (e.pointerType !== 'touch' || !graph.pointers.has(e.pointerId)) return;
        graph.pointers.delete(e.pointerId);
        if (graph.pointers.size < 2) graph.pinch = null;

        if (graph.pointers.size === 0) {
            // Toque sem arrasto = "tap": navega como o clique do mouse.
            if (graph.dragId && !graph.moved) navigateFromNode(graph.dragId);
            graph.dragId = null;
            graph.isPanning = false;
            // Libera o mouse depois de um tempo (ignora os eventos sintéticos).
            clearTimeout(graph.ignoreTimer);
            graph.ignoreTimer = setTimeout(() => { graph.ignoreMouse = false; }, 400);
        } else if (graph.pointers.size === 1) {
            // Sobrou 1 dedo após a pinça: retoma o pan a partir dele.
            const [pt] = Array.from(graph.pointers.values());
            graph.last.x = pt.x;
            graph.last.y = pt.y;
            graph.isPanning = true;
            graph.dragId = null;
            graph.moved = true;
        }
    }
    graphCanvas.addEventListener('pointerup', endTouch);
    graphCanvas.addEventListener('pointercancel', endTouch);

    window.addEventListener('resize', () => {
        if (graphView && !graphView.classList.contains('hidden')) {
            graphResize();
            if (!graph.running) graphDraw();
        }
    });
}

attachGraphEvents();

// Recacheia a paleta ao trocar de tema e repinta se o grafo estiver visível.
document.addEventListener('taskkill:theme-changed', () => {
    refreshGraphPalette();
    if (graphView && !graphView.classList.contains('hidden') && !graph.running) {
        graphDraw();
    }
});
