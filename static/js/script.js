/**
 * O JavaScript puro aqui adiciona interatividade e lógica de estado simples
 * focando na funcionalidade e em manutenabilidade com manipulação direta do DOM.
 */

document.addEventListener('DOMContentLoaded', () => {
    // 1. Elementos da Interface
    const skeletonItems = document.querySelectorAll('.skeleton-item');
    const emptyState = document.getElementById('empty-state');
    const projectView = document.getElementById('project-view');
    const projectTitle = document.getElementById('project-title');
    const taskList = document.getElementById('task-list');
    const taskInput = document.getElementById('new-task-input');
    const graphView = document.getElementById('graph-view');
    const graphCanvas = document.getElementById('graph-canvas');

    // Função Universal de Sanitização (Antivírus do DOM contra XSS)
    // Neutraliza qualquer tentativa de um usuário digitar um script perigoso.
    function escapeHTML(str) {
        if (!str) return '';
        return str.replace(/[&<>'"]/g, 
            tag => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                "'": '&#39;',
                '"': '&quot;'
            }[tag] || tag)
        );
    }

    // CSRF token por sessão (obrigatório no backend em /api para POST/PUT/DELETE)
    function getCsrfToken() {
        const meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? (meta.getAttribute('content') || '') : '';
    }

    async function apiFetch(path, opts = {}) {
        const headers = Object.assign({}, opts.headers || {}, {
            'X-CSRF-Token': getCsrfToken(),
        });
        return fetch(path, Object.assign({}, opts, { headers, credentials: 'same-origin' }));
    }

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
    };

    function normText(s) {
        return String(s || '').replace(/\s+/g, ' ').trim();
    }

    function buildGraphModel() {
        const dayEls = Array.from(document.querySelectorAll('.week-nav'));
        const days = dayEls.map(el => el.getAttribute('data-day')).filter(Boolean);

        const projectEls = Array.from(document.querySelectorAll('.project-nav'));
        const projects = projectEls.map(el => normText(el.textContent)).filter(Boolean);

        const nodes = [];
        const nodeById = new Map();

        function addNode(type, key, label) {
            const id = `${type}:${key}`;
            if (nodeById.has(id)) return nodeById.get(id);
            const n = {
                id,
                type,
                key,
                label,
                x: (Math.random() - 0.5) * 520,
                y: (Math.random() - 0.5) * 340,
                vx: 0,
                vy: 0,
                r: type === 'day' ? 12 : (type === 'tag' ? 11 : 14)
            };
            nodeById.set(id, n);
            nodes.push(n);
            return n;
        }

        days.forEach(d => addNode('day', d, d));
        projects.forEach(p => addNode('project', p, p));

        const edges = [];

        // Dia <-> Projeto (tarefas com due_date)
        const counts = new Map(); // day||project -> count
        for (const p of projects) {
            const list = (tasksData[p] || []).filter(t => !t.deleted);
            for (const t of list) {
                const d = normText(t.due_date || '');
                if (!d) continue;
                const k = `${d}||${p}`;
                counts.set(k, (counts.get(k) || 0) + 1);
            }
        }
        for (const [k, c] of counts.entries()) {
            const [day, proj] = k.split('||');
            const a = addNode('day', day, day);
            const b = addNode('project', proj, proj);
            edges.push({ a: a.id, b: b.id, weight: Math.min(8, c), kind: 'schedule' });
        }

        // Tags (para relações Projeto <-> Tag e Projeto <-> Projeto)
        const tagRe = /(^|\s)#([\w\u00C0-\u00FF]+)/g;
        const tagsByProject = new Map(); // proj -> Set(tag)
        const tagCountsByProject = new Map(); // proj -> Map(tag -> count)
        const tagCountsGlobal = new Map(); // tag -> count
        for (const p of projects) {
            const set = new Set();
            const counts = new Map();
            const list = (tasksData[p] || []).filter(t => !t.deleted);
            for (const t of list) {
                const text = String(t.text || '');
                let m;
                while ((m = tagRe.exec(text)) !== null) {
                    const tag = String(m[2] || '').toLowerCase();
                    if (!tag) continue;
                    set.add(tag);
                    counts.set(tag, (counts.get(tag) || 0) + 1);
                    tagCountsGlobal.set(tag, (tagCountsGlobal.get(tag) || 0) + 1);
                }
            }
            tagsByProject.set(p, set);
            tagCountsByProject.set(p, counts);
        }

        // Mantém o grafo minimalista: limita o número de tags na visão global
        const topTags = Array.from(tagCountsGlobal.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 14)
            .map(([t]) => t);
        const topTagSet = new Set(topTags);

        topTags.forEach(t => addNode('tag', t, `#${t}`));

        for (const p of projects) {
            const counts = tagCountsByProject.get(p);
            if (!counts) continue;
            for (const [t, c] of counts.entries()) {
                if (!topTagSet.has(t)) continue;
                edges.push({
                    a: `project:${p}`,
                    b: `tag:${t}`,
                    weight: Math.min(8, c),
                    kind: 'taglink'
                });
            }
        }

        // Projeto <-> Projeto (tags compartilhadas)
        for (let i = 0; i < projects.length; i++) {
            for (let j = i + 1; j < projects.length; j++) {
                const p1 = projects[i];
                const p2 = projects[j];
                const s1 = tagsByProject.get(p1);
                const s2 = tagsByProject.get(p2);
                if (!s1 || !s2 || s1.size === 0 || s2.size === 0) continue;
                let inter = 0;
                for (const t of s1) if (s2.has(t)) inter++;
                if (inter <= 0) continue;
                edges.push({
                    a: `project:${p1}`,
                    b: `project:${p2}`,
                    weight: Math.min(8, inter),
                    kind: 'tags'
                });
            }
        }

        // Link nodes in edges
        for (const e of edges) {
            e.na = nodeById.get(e.a);
            e.nb = nodeById.get(e.b);
        }

        return { nodes, edges };
    }

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

    // Lerp linear entre dois valores
    function _lerp(a, b, t) { return a + (b - a) * t; }

    function graphDraw() {
        if (!graphCanvas || !graph.model) return;
        const ctx = graphCanvas.getContext('2d');
        const rect = graphCanvas.getBoundingClientRect();
        const w = rect.width;
        const h = rect.height;
        ctx.clearRect(0, 0, w, h);

        const hov = graph.hoverId;
        const dp  = graph.dimProgress; // 0..1, animado suavemente

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
                e.kind === 'schedule' ? '100,116,139' :
                e.kind === 'taglink'  ? '59,130,246'  :
                '59,130,246';

            // alpha "normal" da aresta
            const alphaNormal = (
                e.kind === 'schedule' ? 0.22 :
                e.kind === 'taglink'  ? 0.14 : 0.16
            ) + Math.min(0.12, e.weight * 0.015);

            let edgeAlpha = alphaNormal;
            if (connectedEdgeSet) {
                if (connectedEdgeSet.has(e)) {
                    // Aresta conectada: destaque suave
                    edgeAlpha = _lerp(alphaNormal, 0.60, dp);
                } else {
                    // Aresta não conectada: fade elegante até 8%
                    edgeAlpha = _lerp(alphaNormal, 0.08, dp);
                }
            }

            ctx.strokeStyle = `rgba(${base},${edgeAlpha})`;
            ctx.lineWidth = (connectedEdgeSet && connectedEdgeSet.has(e))
                ? _lerp(1 + Math.min(2.0, e.weight * 0.22), 2.0, dp)
                : 1 + Math.min(2.0, e.weight * 0.22);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
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
                n.type === 'day' ? [226,232,240] :
                n.type === 'tag' ? [239,246,255] : [255,255,255];
            const strokeBase =
                n.type === 'day' ? [100,116,139] :
                n.type === 'tag' ? [ 59,130,246] :
                                   [ 59,130,246];

            const fillA   = isDimmed ? _lerp(0.95, 0.25, dp) : 0.97;
            const strokeA = isDimmed
                ? _lerp(isHover ? 0.65 : (n.type === 'day' ? 0.55 : 0.60), 0.12, dp)
                : (isHover ? 0.80 : (n.type === 'day' ? 0.55 : 0.60));

            // Raio: o nó hover cresce suavemente
            const r = isHover ? _lerp(n.r, n.r * 1.22, dp) : n.r;

            ctx.beginPath();
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
            ctx.fillStyle   = `rgba(${fillBase.join(',')},${fillA})`;
            ctx.fill();
            ctx.lineWidth   = isHover ? _lerp(1.5, 2.6, dp) : 1.5;
            ctx.strokeStyle = `rgba(${strokeBase.join(',')},${strokeA})`;
            ctx.stroke();

            // Label: dimmed some suavemente, hover fica em destaque
            const labelOp = isDimmed
                ? _lerp(0.78, 0.0, Math.min(1, dp * 1.4))  // some antes de chegar em dp=1
                : (isHover ? 1.0 : 0.78);

            if (labelOp > 0.02) {
                ctx.font = `600 ${n.type === 'day' ? 12 : 12.5}px Inter, system-ui, -apple-system, Segoe UI, sans-serif`;
                ctx.fillStyle   = `rgba(15,23,42,${labelOp})`;
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

    function graphStart() {
        if (!graphCanvas || !graphView || graphView.classList.contains('hidden')) return;
        graphResize();
        const rect = graphCanvas.getBoundingClientRect();
        graph.pan.x = rect.width * 0.5;
        graph.pan.y = rect.height * 0.52;
        graph.scale = 1;
        graph.model = buildGraphModel();
        graph.running = true;
        cancelAnimationFrame(graph.raf);
        graph.raf = requestAnimationFrame(graphStep);
    }

    function graphStop() {
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
                node.type === 'project' ? 'Projeto' : 'Tag';
            let detail = '';
            if (node.type === 'project') {
                const tc = (tasksData[node.key] || []).filter(t => !t.deleted).length;
                detail = `<br><span class="gt-meta">${tc} task${tc !== 1 ? 's' : ''}</span>`;
            } else if (node.type === 'day') {
                let cnt = 0;
                for (const tasks of Object.values(tasksData))
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
            if (!graphCanvas) return;
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
            if (!graphCanvas) return;
            if (!graph.dragId && !graph.isPanning) return;

            if (graph.dragId && !graph.moved && graph.model) {
                const node = graph.model.nodes.find(n => n.id === graph.dragId);
                if (node) {
                    if (node.type === 'day') {
                        const el = document.querySelector(`.week-nav[data-day="${CSS.escape(node.key)}"]`);
                        if (el) el.click();
                    } else if (node.type === 'project') {
                        const items = Array.from(document.querySelectorAll('.project-nav'));
                        const target = items.find(it => normText(it.textContent) === node.key);
                        if (target) target.click();
                    } else if (node.type === 'tag') {
                        openTagView(node.key);
                    }
                }
            }

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

        window.addEventListener('resize', () => {
            if (graphView && !graphView.classList.contains('hidden')) {
                graphResize();
                if (!graph.running) graphDraw();
            }
        });
    }

    attachGraphEvents();

    function openTagView(tagKey) {
        const tag = String(tagKey || '').toLowerCase();
        if (!tag) return;

        // Sem item no sidebar para tag: remove o estado ativo para evitar “desalinhamento”
        skeletonItems.forEach(sib => sib.classList.remove('active'));

        document.body.classList.remove('graph-mode');
        currentTag = tag;
        currentCategory = null;
        currentWeekDay = null;

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

    // ── Perfil inline ──────────────────────────────────────────
    const navPerfilBtn   = document.getElementById('nav-perfil');
    const perfilView     = document.getElementById('perfil-view');
    const perfilAlert    = document.getElementById('perfil-inline-alert');
    const perfilNavBtns  = document.querySelectorAll('[data-perfil-tab]');
    const perfilPanels   = document.querySelectorAll('[id^="perfil-tab-"]');

    function showPerfilAlert(msg, isError) {
        if (!perfilAlert) return;
        perfilAlert.textContent = msg;
        perfilAlert.className = 'perfil-alert auth-alert ' + (isError ? 'auth-alert-error' : 'auth-alert-ok');
        perfilAlert.classList.remove('hidden');
        setTimeout(() => perfilAlert.classList.add('hidden'), 5000);
    }

    function activatePerfilTab(tabId) {
        perfilPanels.forEach(p => p.classList.toggle('hidden', p.id !== 'perfil-tab-' + tabId));
        perfilNavBtns.forEach(b => b.classList.toggle('perfil-nav-item--active', b.dataset.perfilTab === tabId));
    }

    if (navPerfilBtn && perfilView) {
        navPerfilBtn.addEventListener('click', () => {
            // Esconde outras views e ativa o perfil
            [emptyState, projectView, graphView, document.getElementById('dashboard-view')]
                .forEach(v => v && v.classList.add('hidden'));
            hideIntegrationsView();
            perfilView.classList.remove('hidden');
            // Remove active dos itens do sidebar
            document.querySelectorAll('.skeleton-item').forEach(s => s.classList.remove('active'));
            activatePerfilTab('conta');
        });

        perfilNavBtns.forEach(btn => {
            btn.addEventListener('click', () => activatePerfilTab(btn.dataset.perfilTab));
        });

        // Submissão AJAX do formulário de usuário
        const formUsuario = document.getElementById('form-usuario');
        if (formUsuario) {
            formUsuario.addEventListener('submit', async e => {
                e.preventDefault();
                const data = new URLSearchParams(new FormData(formUsuario));
                data.set('action', 'usuario');
                data.set('csrf_token', getCsrfToken());
                try {
                    const res = await fetch('/perfil', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'X-Requested-With': 'XMLHttpRequest',
                            'X-CSRF-Token': getCsrfToken()
                        },
                        body: data.toString()
                    });
                    const json = await res.json();
                    if (!res.ok) {
                        showPerfilAlert(json.error || 'Erro ao salvar.', true);
                    } else {
                        showPerfilAlert(json.message || 'Salvo com sucesso.', false);
                        // Atualiza nome no sidebar e no painel
                        const newName = formUsuario.querySelector('[name="new_username"]').value.trim();
                        if (newName && json.user) {
                            const lbl = document.getElementById('sidebar-username-label');
                            const disp = document.getElementById('perfil-username-display');
                            const init = document.getElementById('perfil-avatar-xl');
                            const sideInit = document.querySelector('.sidebar-avatar-initials');
                            if (lbl) lbl.textContent = json.user.username;
                            if (disp) disp.textContent = json.user.username;
                            if (init) init.textContent = json.user.username[0].toUpperCase();
                            if (sideInit) sideInit.textContent = json.user.username[0].toUpperCase();
                        }
                        formUsuario.querySelector('[name="confirm_password_u"]').value = '';
                    }
                } catch {
                    showPerfilAlert('Erro de rede. Tente novamente.', true);
                }
            });
        }

        // Submissão AJAX do formulário de senha
        const formSenha = document.getElementById('form-senha');
        if (formSenha) {
            formSenha.addEventListener('submit', async e => {
                e.preventDefault();
                const data = new URLSearchParams(new FormData(formSenha));
                data.set('action', 'senha');
                data.set('csrf_token', getCsrfToken());
                try {
                    const res = await fetch('/perfil', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'X-Requested-With': 'XMLHttpRequest',
                            'X-CSRF-Token': getCsrfToken()
                        },
                        body: data.toString()
                    });
                    const json = await res.json();
                    if (!res.ok) {
                        showPerfilAlert(json.error || 'Erro ao salvar.', true);
                    } else {
                        showPerfilAlert(json.message || 'Senha atualizada.', false);
                        formSenha.reset();
                    }
                } catch {
                    showPerfilAlert('Erro de rede. Tente novamente.', true);
                }
            });
        }
    }

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

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename || 'taskkill-backup.db';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

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

    // Função Exclusiva para Notificações (Toast) Silenciosas
    function showToast(message) {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = message;

        container.appendChild(toast);

        // Dispara reflow pra ativar o CSS transition e depois adiciona 'show'
        requestAnimationFrame(() => {
            toast.classList.add('show');
        });

        // Some e apaga o DOM depois de 3 segundos
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => {
                toast.remove();
            }, 300); // Tempo da transição CSS
        }, 3000);
    }

    // Estado das demandas (será cacheado pela API)
    let tasksData = {};
    let currentCategory = null;
    let currentWeekDay = null; // Se estiver vendo os dias da semana
    let currentTag = null; // Se estiver vendo tarefas por #tag (vindo do grafo)

    // ── Projetos dinâmicos ─────────────────────────────────────────────

    // SVGs reutilizáveis
    const _SVG_TRASH = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <polyline points="3 6 5 6 21 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M10 11v6M14 11v6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
        <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;

    // Modal customizado de confirmação
    function _confirmModal(title, body) {
        return new Promise(resolve => {
            const overlay  = document.getElementById('project-confirm-overlay');
            const titleEl  = document.getElementById('project-confirm-title');
            const bodyEl   = document.getElementById('project-confirm-body');
            const btnOk    = document.getElementById('project-confirm-ok');
            const btnCancel= document.getElementById('project-confirm-cancel');
            if (!overlay) { resolve(window.confirm(title)); return; }

            titleEl.textContent = title;
            bodyEl.textContent  = body;
            overlay.classList.remove('hidden');
            btnOk.focus();

            const cleanup = (result) => {
                overlay.classList.add('hidden');
                btnOk.removeEventListener('click', onOk);
                btnCancel.removeEventListener('click', onCancel);
                overlay.removeEventListener('click', onOverlay);
                document.removeEventListener('keydown', onKey);
                resolve(result);
            };
            const onOk      = () => cleanup(true);
            const onCancel  = () => cleanup(false);
            const onOverlay = (e) => { if (e.target === overlay) cleanup(false); };
            const onKey     = (e) => { if (e.key === 'Escape') cleanup(false); };

            btnOk.addEventListener('click', onOk);
            btnCancel.addEventListener('click', onCancel);
            overlay.addEventListener('click', onOverlay);
            document.addEventListener('keydown', onKey);
        });
    }

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
            currentCategory = normText(item.textContent);
            currentWeekDay = null;
            currentTag = null;

            if (!tasksData[currentCategory]) tasksData[currentCategory] = [];

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
            if (projectTitle) projectTitle.textContent = currentCategory;
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
            for (const proj in tasksData) {
                const idx = tasksData[proj].findIndex(t => t.id === numId);
                if (idx !== -1) {
                    [movedTask] = tasksData[proj].splice(idx, 1);
                    break;
                }
            }
            if (!movedTask) return;

            movedTask.project = newProject;
            movedTask.originalProject = newProject;
            if (!tasksData[newProject]) tasksData[newProject] = [];
            tasksData[newProject].push(movedTask);

            apiFetch(`/api/tasks/${numId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ project: newProject }),
            }).then(r => { if (!r.ok) console.error('Falha ao mover tarefa'); });

            if (currentCategory) renderTasks();
        });

        // Botão lixeira — excluir projeto
        if (btnDel) {
            btnDel.addEventListener('click', async e => {
                e.stopPropagation();
                const name = normText(item.textContent);
                const ok = await _confirmModal(
                    `Excluir "${name}"?`,
                    'Todas as tarefas do projeto serão arquivadas e não aparecerão mais na lista.'
                );
                if (!ok) return;

                const res = await apiFetch(`/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' });
                if (res.ok) {
                    delete tasksData[name];
                    wrapper.remove();
                    if (currentCategory === name) {
                        currentCategory = null;
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
                    if (!tasksData[name]) tasksData[name] = [];

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
                tasksData = await tasksRes.json();
                // Se o usuário já estiver em alguma visão, re-renderiza com os dados carregados
                if (currentCategory || currentWeekDay || currentTag) {
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

    const dashboardView = document.getElementById('dashboard-view');
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
                currentCategory = null; 
                currentWeekDay = null;
                currentTag = null;
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
                currentCategory = null;
                currentWeekDay = null;
                currentTag = null;
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
                openIntegrations();
                return;
            }
            
            // Se for a visão da Semana
            if (item.classList.contains('week-nav')) {
                document.body.classList.remove('graph-mode');
                currentCategory = null;
                currentWeekDay = item.getAttribute('data-day');
                currentTag = null;
                
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
                
                if (projectTitle) projectTitle.textContent = currentWeekDay;
                
                // Na visão da semana não criamos tarefas novas diretamente (pois falta o projeto), 
                // então escondemos o input
                document.querySelector('.task-input-container').style.display = 'none';
                
                renderTasks();
                return;
            }

            // Se for um Projeto Genérico
            document.body.classList.remove('graph-mode');
            currentCategory = normText(item.textContent);
            currentWeekDay = null;
            currentTag = null;
            
            // Inicializa a lista dessa categoria se ainda não existir
            if (!tasksData[currentCategory]) {
                tasksData[currentCategory] = [];
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
            if (projectTitle) projectTitle.textContent = currentCategory;
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
            Object.keys(tasksData).forEach(proj => {
                const found = tasksData[proj].find(t => t.id.toString() === droppedTaskId);
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
                const taskIndex = tasksData[sourceProject].findIndex(t => t.id === targetTask.id);
                tasksData[sourceProject].splice(taskIndex, 1);

                if (!tasksData[newProject]) tasksData[newProject] = [];
                targetTask.project = newProject;
                tasksData[newProject].push(targetTask);

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

    // ----------------------------------------------------
    // REORDENAÇÃO MANUAL (DRAG AND DROP DENTRO DA LISTA)
    // ----------------------------------------------------
    if (taskList) {
        taskList.addEventListener('dragover', e => {
            // Não permite reordenar na visão de semana (mistura projetos e quebra consistência de ranking)
            if (currentWeekDay) return;
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
             if (currentWeekDay || !currentCategory) return;
             // Quando soltar após misturar as visões, captura todas as LIs e a nova ordem
             const sortedLiIds = Array.from(taskList.querySelectorAll('.task-item')).map(li => li.getAttribute('data-id'));
             
             // Cria payload para atualizar no servidor as posições 
             // (usando o index real de onde parou)
             const payload = sortedLiIds.map((id, idx) => ({ id: id, position: idx }));
             
             // Atualiza memória RAM (arrays) para se alinhar com a tela se estiver num projeto
             // Ordena o array atual baseado na nova ordem de IDs visualizadas
             tasksData[currentCategory].sort((a, b) => {
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

    // Função de Cáculo e Render do Dashboard Central
    // Função de Render do Dashboard Central (Cards por Projeto)
    function renderDashboard() {
        const grid = document.getElementById('project-cards-grid');
        if (!grid) return;
        grid.innerHTML = ''; // Limpar antes de popular

        // Captura todos os nomes dos projetos pelo menu pra garantir que apareçam mesmo vazios
        const projectItems = document.querySelectorAll('.project-nav');
        
        projectItems.forEach(item => {
            const projectName = normText(item.textContent);
            const tasks = (tasksData[projectName] || []).filter(t => !t.deleted); 
            
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

    // 4. Lógica de Tarefas: Adicionar ao apertar Enter
    if (taskInput) {
        taskInput.addEventListener('keypress', async (e) => {
            if (e.key === 'Enter') {
                const text = taskInput.value.trim();
                if (text && currentCategory !== null) {
                    
                    try {
                        // Manda para o Backend (API)
                        const response = await apiFetch('/api/tasks', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ project: currentCategory, text: text })
                        });
                        
                        if (response.ok) {
                            const newTask = await response.json(); // Vem com o ID do banco
                            tasksData[currentCategory].push(newTask);
                            taskInput.value = '';
                            renderTasks();
                            showToast("Tarefa enviada para a nuvem");
                        }
                    } catch (err) {
                        console.error("Erro ao criar task:", err);
                    }
                }
            }
        });
    }

    // Função Principal para renderizar as tarefas na tela
    function renderTasks() {
        if (!taskList) return;
        
        taskList.innerHTML = ''; // Limpa a lista
        let tasks = [];
        let isWeekView = false;
        let isTagView = false;
        
        if (currentWeekDay) {
            isWeekView = true;
            Object.keys(tasksData).forEach(proj => {
                tasksData[proj].forEach(t => {
                    if (t.due_date === currentWeekDay && !t.deleted) {
                        t.originalProject = proj; // Grava o nome pra exibição
                        tasks.push(t);
                    }
                });
            });
        } else if (currentTag) {
            isTagView = true;
            const wanted = String(currentTag || '').toLowerCase();
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

            Object.keys(tasksData).forEach(proj => {
                tasksData[proj].forEach(t => {
                    if (t.deleted) return;
                    if (!hasWanted(t.text)) return;
                    t.originalProject = proj;
                    tasks.push(t);
                });
            });
        } else if (currentCategory) {
            tasks = (tasksData[currentCategory] || []).filter(t => !t.deleted);
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
                const proj = task.originalProject || currentCategory;
                const projTasks = tasksData[proj];
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

    // 5. UX Premium: Atalho Globais (Linear style)
    document.addEventListener('keydown', (e) => {
        // Se já estiver focando em qualquer elemento de input, não aciona para evitar escrever a letra "n" dentro de um lugar errado
        if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') {
            return;
        }

        // Aperta "N" para focar e criar nova tarefa
        if (e.key.toLowerCase() === 'n' && currentCategory) {
            e.preventDefault(); // Evita escrever de fato algo
            if (taskInput) {
                taskInput.focus();
            }
        }
    });

    // ================================================================
    // INTEGRAÇÕES EXTERNAS (admin) — wizard + CRUD
    // ================================================================
    const integrationsView = document.getElementById('integrations-view');
    const intListPanel   = document.getElementById('int-list-panel');
    const intListEl      = document.getElementById('int-list');
    const intEmptyEl     = document.getElementById('int-empty');
    const intEditor      = document.getElementById('int-editor');
    const intEditorTitle = document.getElementById('int-editor-title');
    const intAlert       = document.getElementById('int-alert');
    const intFormMode    = document.getElementById('int-form-mode');
    const intJsonMode    = document.getElementById('int-json-mode');
    const intJson        = document.getElementById('int-json');
    const intId          = document.getElementById('int-id');
    const intName        = document.getElementById('int-name');
    const intBaseUrl     = document.getElementById('int-base-url');
    const intPath        = document.getElementById('int-path');
    const intMethod      = document.getElementById('int-method');
    const intAuthType    = document.getElementById('int-auth-type');
    const intAuthFields  = document.getElementById('int-auth-fields');
    const intHeaders     = document.getElementById('int-headers');
    const intQuery       = document.getElementById('int-query');
    const intAllowPrivate= document.getElementById('int-allow-private');
    const intItemsPath   = document.getElementById('int-items-path');
    const intExternalId  = document.getElementById('int-external-id');
    const intProjectMode = document.getElementById('int-project-mode');
    const intProjectValue= document.getElementById('int-project-value');
    const intProjectField= document.getElementById('int-project-field');
    const intTextTemplate= document.getElementById('int-text-template');
    const intFieldChips  = document.getElementById('int-field-chips');
    const intOnUpdate    = document.getElementById('int-on-update');
    const intTestResult  = document.getElementById('int-test-result');
    const intPreviewResult = document.getElementById('int-preview-result');
    const intNewBtn      = document.getElementById('int-new-btn');
    const intBackBtn     = document.getElementById('int-back-btn');
    const intAddHeader   = document.getElementById('int-add-header');
    const intAddQuery    = document.getElementById('int-add-query');
    const intTestBtn     = document.getElementById('int-test-btn');
    const intPreviewBtn  = document.getElementById('int-preview-btn');
    const intSaveBtn     = document.getElementById('int-save-btn');
    const intRunBtn      = document.getElementById('int-run-btn');
    const intDeleteBtn   = document.getElementById('int-delete-btn');

    let intJsonModeOn = false;

    function hideIntegrationsView() {
        if (integrationsView) integrationsView.classList.add('hidden');
    }

    function openIntegrations() {
        if (!integrationsView) return;
        document.body.classList.remove('graph-mode');
        currentCategory = null;
        currentWeekDay = null;
        currentTag = null;
        if (emptyState)    emptyState.classList.add('hidden');
        if (projectView)   projectView.classList.add('hidden');
        if (dashboardView) dashboardView.classList.add('hidden');
        if (graphView)     graphView.classList.add('hidden');
        if (perfilView)    perfilView.classList.add('hidden');
        graphStop();
        integrationsView.classList.remove('hidden');
        intShowList();
        loadIntegrations();
    }

    function intShowList() {
        if (intListPanel) intListPanel.classList.remove('hidden');
        if (intEditor)    intEditor.classList.add('hidden');
    }

    function intShowEditor() {
        if (intListPanel) intListPanel.classList.add('hidden');
        if (intEditor)    intEditor.classList.remove('hidden');
    }

    function intAlertShow(msg, isError, hide) {
        if (!intAlert) return;
        if (hide || !msg) {
            intAlert.classList.add('hidden');
            intAlert.textContent = '';
            return;
        }
        intAlert.textContent = msg;
        intAlert.className = 'auth-alert ' + (isError ? 'auth-alert-error' : 'auth-alert-ok');
        intAlert.classList.remove('hidden');
    }

    function intValOf(id) {
        const el = document.getElementById(id);
        return el ? el.value : '';
    }

    function intAuthFieldRow(label, id, value, type) {
        const wrap = document.createElement('div');
        const lbl = document.createElement('label');
        lbl.className = 'auth-label';
        lbl.setAttribute('for', id);
        lbl.textContent = label;
        const inp = document.createElement('input');
        inp.className = 'auth-input';
        inp.id = id;
        inp.type = type || 'text';
        inp.value = value || '';
        inp.autocomplete = 'off';
        wrap.appendChild(lbl);
        wrap.appendChild(inp);
        return wrap;
    }

    function renderAuthFields(type, vals) {
        vals = vals || {};
        if (!intAuthFields) return;
        intAuthFields.innerHTML = '';
        if (type === 'api_key') {
            intAuthFields.appendChild(intAuthFieldRow('Header', 'int-auth-header', vals.header || 'X-API-Key', 'text'));
            intAuthFields.appendChild(intAuthFieldRow('Valor', 'int-auth-value', vals.value || '', 'text'));
        } else if (type === 'bearer') {
            intAuthFields.appendChild(intAuthFieldRow('Token', 'int-auth-token', vals.token || '', 'text'));
        } else if (type === 'basic') {
            intAuthFields.appendChild(intAuthFieldRow('Usuário', 'int-auth-username', vals.username || '', 'text'));
            intAuthFields.appendChild(intAuthFieldRow('Senha', 'int-auth-password', vals.password || '', 'password'));
        }
    }

    function readAuth() {
        const type = intAuthType.value;
        const auth = { type };
        if (type === 'api_key') {
            auth.header = intValOf('int-auth-header');
            auth.value = intValOf('int-auth-value');
        } else if (type === 'bearer') {
            auth.token = intValOf('int-auth-token');
        } else if (type === 'basic') {
            auth.username = intValOf('int-auth-username');
            auth.password = intValOf('int-auth-password');
        }
        return auth;
    }

    function kvAddRow(container, key, value) {
        if (!container) return;
        const row = document.createElement('div');
        row.className = 'int-kv-row';
        const kEl = document.createElement('input');
        kEl.className = 'auth-input int-kv-key';
        kEl.type = 'text';
        kEl.placeholder = 'chave';
        kEl.value = key || '';
        const vEl = document.createElement('input');
        vEl.className = 'auth-input int-kv-val';
        vEl.type = 'text';
        vEl.placeholder = 'valor';
        vEl.value = value || '';
        const del = document.createElement('button');
        del.className = 'int-kv-del';
        del.type = 'button';
        del.setAttribute('aria-label', 'Remover');
        del.textContent = '×';
        del.addEventListener('click', () => row.remove());
        row.appendChild(kEl);
        row.appendChild(vEl);
        row.appendChild(del);
        container.appendChild(row);
    }

    function collectKv(container) {
        const obj = {};
        if (!container) return obj;
        container.querySelectorAll('.int-kv-row').forEach(row => {
            const k = row.querySelector('.int-kv-key').value.trim();
            const v = row.querySelector('.int-kv-val').value;
            if (k) obj[k] = v;
        });
        return obj;
    }

    function updateProjectModeUI() {
        const isField = intProjectMode.value === 'field';
        intProjectValue.classList.toggle('hidden', isField);
        intProjectField.classList.toggle('hidden', !isField);
    }

    function syncProjectDropdown(selected) {
        const names = Array.from(document.querySelectorAll('.project-nav'))
            .map(el => normText(el.textContent)).filter(Boolean);
        intProjectValue.innerHTML = '';
        names.forEach(n => {
            const opt = document.createElement('option');
            opt.value = n;
            opt.textContent = n;
            if (n === selected) opt.selected = true;
            intProjectValue.appendChild(opt);
        });
        if (selected && !names.includes(selected)) {
            const opt = document.createElement('option');
            opt.value = selected;
            opt.textContent = selected;
            opt.selected = true;
            intProjectValue.appendChild(opt);
        }
    }

    function insertAtCursor(textarea, text) {
        const start = textarea.selectionStart != null ? textarea.selectionStart : textarea.value.length;
        const end = textarea.selectionEnd != null ? textarea.selectionEnd : textarea.value.length;
        textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
        textarea.focus();
        const pos = start + text.length;
        textarea.setSelectionRange(pos, pos);
    }

    function renderFieldChips(fields) {
        if (!intFieldChips) return;
        intFieldChips.innerHTML = '';
        (fields || []).forEach(f => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'int-chip';
            chip.textContent = f;
            chip.addEventListener('click', () => insertAtCursor(intTextTemplate, `{{ ${f} }}`));
            intFieldChips.appendChild(chip);
        });
    }

    function getFormConfig() {
        const projectMode = intProjectMode.value;
        const project = projectMode === 'field'
            ? { mode: 'field', field: intProjectField.value.trim() }
            : { mode: 'fixed', value: intProjectValue.value };
        return {
            connection: {
                base_url: intBaseUrl.value.trim(),
                path: intPath.value.trim(),
                method: intMethod.value,
                headers: collectKv(intHeaders),
                query: collectKv(intQuery),
                auth: readAuth(),
                allow_private: intAllowPrivate.checked,
            },
            items_path: intItemsPath.value.trim(),
            mapping: {
                external_id: intExternalId.value.trim() || 'id',
                project: project,
                text_template: intTextTemplate.value,
                due_date: { mode: 'none' },
            },
            on_update: intOnUpdate.value,
        };
    }

    function applyConfig(cfg) {
        cfg = cfg || {};
        const conn = cfg.connection || {};
        const map = cfg.mapping || {};
        intBaseUrl.value = conn.base_url || '';
        intPath.value = conn.path || '';
        intMethod.value = (conn.method || 'GET').toUpperCase();
        intAllowPrivate.checked = !!conn.allow_private;
        const auth = conn.auth || { type: 'none' };
        intAuthType.value = auth.type || 'none';
        renderAuthFields(intAuthType.value, auth);
        intHeaders.innerHTML = '';
        Object.entries(conn.headers || {}).forEach(([k, v]) => kvAddRow(intHeaders, k, v));
        intQuery.innerHTML = '';
        Object.entries(conn.query || {}).forEach(([k, v]) => kvAddRow(intQuery, k, v));
        intItemsPath.value = cfg.items_path || '';
        intExternalId.value = map.external_id || '';
        const proj = map.project || { mode: 'fixed' };
        intProjectMode.value = proj.mode === 'field' ? 'field' : 'fixed';
        syncProjectDropdown(proj.mode === 'field' ? '' : (proj.value || ''));
        intProjectField.value = proj.field || '';
        updateProjectModeUI();
        intTextTemplate.value = map.text_template || '';
        intOnUpdate.value = cfg.on_update || 'skip';
    }

    function fillForm(integ) {
        intId.value = integ && integ.id ? integ.id : '';
        intName.value = integ && integ.name ? integ.name : '';
        applyConfig((integ && integ.config) || {});
        renderFieldChips([]);
        if (intTestResult) intTestResult.innerHTML = '<p class="int-muted">Rode "Testar conexão" para carregar o payload.</p>';
        if (intPreviewResult) intPreviewResult.innerHTML = '';
    }

    function setJsonMode(on) {
        intJsonModeOn = on;
        document.querySelectorAll('[data-int-mode]').forEach(b => {
            b.classList.toggle('int-tab-btn--active', b.dataset.intMode === (on ? 'json' : 'form'));
        });
        intFormMode.classList.toggle('hidden', on);
        intJsonMode.classList.toggle('hidden', !on);
        if (on) {
            intJson.value = JSON.stringify(getFormConfig(), null, 2);
        } else {
            try {
                applyConfig(JSON.parse(intJson.value));
            } catch (e) {
                // mantém o formulário como estava se o JSON estiver inválido
            }
        }
    }

    async function loadIntegrations() {
        if (!intListEl) return;
        try {
            const res = await apiFetch('/api/integrations');
            if (!res.ok) return;
            renderIntList(await res.json());
        } catch (e) {
            console.error('Erro ao listar integrações:', e);
        }
    }

    function renderIntList(list) {
        intListEl.innerHTML = '';
        if (!list.length) {
            intEmptyEl.classList.remove('hidden');
            return;
        }
        intEmptyEl.classList.add('hidden');
        list.forEach(integ => {
            const status = integ.last_status || 'never';
            const statusText = status === 'ok' ? 'OK' : (status === 'error' ? 'Erro' : 'Nunca rodou');
            const baseUrl = (integ.config && integ.config.connection && integ.config.connection.base_url) || '';
            const card = document.createElement('div');
            card.className = 'int-card';
            card.innerHTML = `
                <div class="int-card-main">
                    <div class="int-card-title">${escapeHTML(integ.name)}</div>
                    <div class="int-card-sub">${escapeHTML(baseUrl)}</div>
                </div>
                <div class="int-card-status int-status-${escapeHTML(status)}">${statusText}</div>
                <div class="int-card-actions">
                    <button class="int-text-btn" data-act="edit">Editar</button>
                    <button class="int-text-btn int-btn-runcard" data-act="run">Executar</button>
                </div>`;
            card.querySelector('[data-act="edit"]').addEventListener('click', () => openEditorById(integ.id));
            card.querySelector('[data-act="run"]').addEventListener('click', () => runById(integ.id));
            intListEl.appendChild(card);
        });
    }

    async function openEditorById(id) {
        try {
            const res = await apiFetch(`/api/integrations/${id}`);
            if (!res.ok) { showToast('Falha ao carregar integração'); return; }
            const integ = await res.json();
            intAlertShow('', false, true);
            setJsonMode(false);
            fillForm(integ);
            intEditorTitle.textContent = integ.name;
            intRunBtn.classList.remove('hidden');
            intDeleteBtn.classList.remove('hidden');
            intShowEditor();
        } catch (e) {
            showToast('Erro ao carregar integração');
        }
    }

    function openNewIntegration() {
        intAlertShow('', false, true);
        setJsonMode(false);
        fillForm(null);
        intEditorTitle.textContent = 'Nova integração';
        intRunBtn.classList.add('hidden');
        intDeleteBtn.classList.add('hidden');
        intShowEditor();
    }

    async function onTest() {
        intTestResult.innerHTML = '<p class="int-muted">Testando…</p>';
        const cfg = getFormConfig();
        try {
            const res = await apiFetch('/api/integrations/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connection: cfg.connection, items_path: cfg.items_path }),
            });
            const data = await res.json();
            if (!res.ok) {
                intTestResult.innerHTML = `<div class="int-error">${escapeHTML(data.error || 'Falha no teste.')}</div>`;
                return;
            }
            renderTestResult(data);
        } catch (e) {
            intTestResult.innerHTML = '<div class="int-error">Erro de rede ao testar.</div>';
        }
    }

    function renderTestResult(data) {
        const arrays = data.arrays || [];
        const fields = data.fields || [];
        let html = '';
        if (arrays.length) {
            html += '<div class="int-muted">Arrays encontrados (clique para usar como caminho dos itens):</div><div class="int-chips">';
            arrays.forEach(a => {
                const label = (a.path || '(raiz)') + ` [${a.count}]`;
                html += `<button type="button" class="int-chip int-chip-array" data-path="${escapeHTML(a.path)}">${escapeHTML(label)}</button>`;
            });
            html += '</div>';
        }
        html += `<p class="int-muted">${data.item_count} item(ns) no caminho atual.</p>`;
        const sampleStr = JSON.stringify(data.sample_item, null, 2) || '';
        html += `<pre class="int-json-preview">${escapeHTML(sampleStr.slice(0, 4000))}</pre>`;
        intTestResult.innerHTML = html;
        intTestResult.querySelectorAll('.int-chip-array').forEach(btn => {
            btn.addEventListener('click', () => {
                intItemsPath.value = btn.getAttribute('data-path') || '';
                onTest();
            });
        });
        renderFieldChips(fields);
        if (!intExternalId.value && fields.indexOf('id') !== -1) intExternalId.value = 'id';
    }

    async function onPreview() {
        intPreviewResult.innerHTML = '<p class="int-muted">Gerando preview…</p>';
        const body = { config: getFormConfig() };
        if (intId.value) body.id = parseInt(intId.value, 10);
        try {
            const res = await apiFetch('/api/integrations/preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json();
            if (!res.ok) {
                intPreviewResult.innerHTML = `<div class="int-error">${escapeHTML(data.error || 'Falha no preview.')}</div>`;
                return;
            }
            renderPreview(data);
        } catch (e) {
            intPreviewResult.innerHTML = '<div class="int-error">Erro de rede no preview.</div>';
        }
    }

    function renderPreview(data) {
        const rows = data.preview || [];
        if (!rows.length) {
            intPreviewResult.innerHTML = '<p class="int-muted">Nenhum item para importar.</p>';
            return;
        }
        let html = `<p class="int-muted">${data.total_items} item(ns) no total; mostrando ${rows.length}.</p>`;
        html += '<table class="int-table"><thead><tr><th>ID</th><th>Projeto</th><th>Texto</th><th></th></tr></thead><tbody>';
        rows.forEach(r => {
            html += `<tr class="${r.valid ? '' : 'int-row-invalid'}">
                <td>${escapeHTML(r.external_id)}</td>
                <td>${escapeHTML(r.project)}</td>
                <td>${escapeHTML(r.text)}</td>
                <td>${r.valid ? '✓' : '⚠'}</td></tr>`;
        });
        html += '</tbody></table>';
        intPreviewResult.innerHTML = html;
    }

    async function onSave() {
        const name = intName.value.trim();
        if (!name) { intAlertShow('Dê um nome à integração.', true); return; }
        let config;
        if (intJsonModeOn) {
            try {
                config = JSON.parse(intJson.value);
            } catch (e) {
                intAlertShow('JSON inválido.', true);
                return;
            }
        } else {
            config = getFormConfig();
        }
        const editingId = intId.value ? parseInt(intId.value, 10) : null;
        try {
            const res = editingId
                ? await apiFetch(`/api/integrations/${editingId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, config }),
                })
                : await apiFetch('/api/integrations', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, config }),
                });
            const data = await res.json();
            if (!res.ok) { intAlertShow(data.error || 'Falha ao salvar.', true); return; }
            if (!editingId && data.id) intId.value = data.id;
            intEditorTitle.textContent = name;
            intRunBtn.classList.remove('hidden');
            intDeleteBtn.classList.remove('hidden');
            intAlertShow('Integração salva.', false);
            showToast('Integração salva');
            loadIntegrations();
        } catch (e) {
            intAlertShow('Erro de rede ao salvar.', true);
        }
    }

    async function onRun() {
        if (!intId.value) { intAlertShow('Salve a integração antes de executar.', true); return; }
        intAlertShow('Executando…', false);
        try {
            const res = await apiFetch(`/api/integrations/${parseInt(intId.value, 10)}/run`, { method: 'POST' });
            const data = await res.json();
            if (!res.ok) { intAlertShow(data.error || 'Falha ao executar.', true); return; }
            intAlertShow(`Importado: ${data.created} criada(s), ${data.updated} atualizada(s), ${data.skipped} ignorada(s).`, false);
            showToast('Integração executada');
            await fetchInitialData();
            loadIntegrations();
        } catch (e) {
            intAlertShow('Erro de rede ao executar.', true);
        }
    }

    async function runById(id) {
        showToast('Executando integração…');
        try {
            const res = await apiFetch(`/api/integrations/${id}/run`, { method: 'POST' });
            const data = await res.json();
            if (!res.ok) { showToast(data.error || 'Falha ao executar'); return; }
            showToast(`Criadas: ${data.created} • ignoradas: ${data.skipped}`);
            await fetchInitialData();
            loadIntegrations();
        } catch (e) {
            showToast('Erro ao executar');
        }
    }

    async function onDelete() {
        if (!intId.value) return;
        const ok = await _confirmModal(
            'Excluir integração?',
            'A configuração será removida. As tarefas já criadas permanecem.'
        );
        if (!ok) return;
        try {
            const res = await apiFetch(`/api/integrations/${parseInt(intId.value, 10)}`, { method: 'DELETE' });
            if (res.ok) {
                showToast('Integração excluída');
                intShowList();
                loadIntegrations();
            } else {
                intAlertShow('Falha ao excluir.', true);
            }
        } catch (e) {
            intAlertShow('Erro de rede ao excluir.', true);
        }
    }

    if (integrationsView) {
        intNewBtn.addEventListener('click', openNewIntegration);
        intBackBtn.addEventListener('click', () => { intShowList(); loadIntegrations(); });
        intAuthType.addEventListener('change', () => renderAuthFields(intAuthType.value, {}));
        intAddHeader.addEventListener('click', () => kvAddRow(intHeaders, '', ''));
        intAddQuery.addEventListener('click', () => kvAddRow(intQuery, '', ''));
        intProjectMode.addEventListener('change', updateProjectModeUI);
        intTestBtn.addEventListener('click', onTest);
        intPreviewBtn.addEventListener('click', onPreview);
        intSaveBtn.addEventListener('click', onSave);
        intRunBtn.addEventListener('click', onRun);
        intDeleteBtn.addEventListener('click', onDelete);
        document.querySelectorAll('[data-int-mode]').forEach(b => {
            b.addEventListener('click', () => setJsonMode(b.dataset.intMode === 'json'));
        });
    }

});
