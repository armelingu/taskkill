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
    const intStepper     = document.getElementById('int-stepper');
    const intJson        = document.getElementById('int-json');
    const intJsonApply   = document.getElementById('int-json-apply');
    const intId          = document.getElementById('int-id');
    const intName        = document.getElementById('int-name');
    const intUrl         = document.getElementById('int-url');
    const intMethod      = document.getElementById('int-method');
    const intAuthType    = document.getElementById('int-auth-type');
    const intAuthFields  = document.getElementById('int-auth-fields');
    const intPagMode     = document.getElementById('int-pag-mode');
    const intPagFields   = document.getElementById('int-pag-fields');
    const intHeaders     = document.getElementById('int-headers');
    const intQuery       = document.getElementById('int-query');
    const intAllowPrivate= document.getElementById('int-allow-private');
    const intItemsPathSel= document.getElementById('int-items-path-sel');
    const intItemsChoice = document.getElementById('int-items-choice');
    const intItemsSummary= document.getElementById('int-items-summary');
    const intSample      = document.getElementById('int-sample');
    const intExternalId  = document.getElementById('int-external-id');
    const intProjectByField = document.getElementById('int-project-by-field');
    const intProjectMode = document.getElementById('int-project-mode');
    const intProjectValue= document.getElementById('int-project-value');
    const intProjectField= document.getElementById('int-project-field');
    const intTextTemplate= document.getElementById('int-text-template');
    const intTitlePreview= document.getElementById('int-title-preview');
    const intFieldChips  = document.getElementById('int-field-chips');
    const intOnUpdate    = document.getElementById('int-on-update');
    const intReimportDeleted = document.getElementById('int-reimport-deleted');
    const intSchedEnabled = document.getElementById('int-sched-enabled');
    const intSchedInterval = document.getElementById('int-sched-interval');
    const intPreviewResult = document.getElementById('int-preview-result');
    const intBulkBar     = document.getElementById('int-bulk-bar');
    const intBulkCount   = document.getElementById('int-bulk-count');
    const intBulkProject = document.getElementById('int-bulk-project');
    const intBulkProjectApply = document.getElementById('int-bulk-project-apply');
    const intBulkWeekday = document.getElementById('int-bulk-weekday');
    const intBulkWeekdayApply = document.getElementById('int-bulk-weekday-apply');
    const intNewBtn      = document.getElementById('int-new-btn');
    const intBackBtn     = document.getElementById('int-back-btn');
    const intAddHeader   = document.getElementById('int-add-header');
    const intAddQuery    = document.getElementById('int-add-query');
    const intFetchBtn    = document.getElementById('int-fetch-btn');
    const intFetchStatus = document.getElementById('int-fetch-status');
    const intTo3Btn      = document.getElementById('int-to-3-btn');
    const intTo4Btn      = document.getElementById('int-to-4-btn');
    const intSaveBtn     = document.getElementById('int-save-btn');
    const intRunBtn      = document.getElementById('int-run-btn');
    const intDeleteBtn   = document.getElementById('int-delete-btn');

    // Estado do wizard
    let intStep = 1;
    let intSampleItem = null;   // item de exemplo vindo do "Buscar dados"
    let intFieldsList = [];     // campos detectados do item
    let intPreviewRows = [];    // linhas editáveis da prévia (passo 4)
    let intPreviewTotal = 0;
    let intPreviewSig = '';     // assinatura da config quando a prévia foi gerada

    const WEEKDAYS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta'];

    const TITLE_HINT_FIELDS = ['title', 'subject', 'name', 'nome', 'titulo', 'assunto',
        'summary', 'resumo', 'text', 'texto', 'description', 'descricao'];

    // ── Helpers de template (espelham o backend p/ prévia ao vivo) ──
    function intResolvePath(obj, path) {
        if (path === null || path === undefined || path === '') return obj;
        let cur = obj;
        const parts = String(path).replace(/\[/g, '.').replace(/\]/g, '').split('.');
        for (let p of parts) {
            p = p.trim();
            if (p === '') continue;
            if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
                if (!(p in cur)) return null;
                cur = cur[p];
            } else if (Array.isArray(cur)) {
                const i = parseInt(p, 10);
                if (isNaN(i) || i < 0 || i >= cur.length) return null;
                cur = cur[i];
            } else {
                return null;
            }
        }
        return cur;
    }

    function intRenderTemplate(tpl, item) {
        if (!tpl) return '';
        return String(tpl).replace(/\{\{\s*([\w.\[\]]+)\s*\}\}/g, (m, g) => {
            const v = intResolvePath(item, g);
            if (v === null || v === undefined) return '';
            if (typeof v === 'boolean') return v ? 'true' : 'false';
            if (typeof v === 'object') return JSON.stringify(v);
            return String(v);
        });
    }

    function updateTitlePreview() {
        if (!intTitlePreview) return;
        const rendered = intRenderTemplate(intTextTemplate.value, intSampleItem || {}).trim();
        intTitlePreview.textContent = rendered || '—';
    }

    // ── Navegação ──────────────────────────────────────────────────
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

    function goToStep(n) {
        intStep = n;
        intEditor.querySelectorAll('.int-step-panel').forEach(p => {
            p.classList.toggle('hidden', parseInt(p.dataset.panel, 10) !== n);
        });
        intStepper.querySelectorAll('.int-step').forEach(s => {
            const sn = parseInt(s.dataset.step, 10);
            s.classList.toggle('is-active', sn === n);
            s.classList.toggle('is-done', sn < n);
        });
        if (n === 2 && !intSampleItem && intItemsSummary && !intItemsSummary.innerHTML.trim()) {
            intItemsSummary.innerHTML = '<div class="int-muted">Volte ao passo 1 e clique em "Buscar dados" para carregar os itens da API.</div>';
        }
        if (n === 3) { renderFieldChips(intFieldsList); updateTitlePreview(); }
        if (n === 4) {
            // Só regenera a prévia se a configuração mudou (senão preserva os ajustes por linha).
            if (intPreviewRows.length && getPreviewSig() === intPreviewSig) {
                renderPreviewTable();
            } else {
                onPreview();
            }
        }
    }

    function getPreviewSig() {
        const c = getFormConfig();
        return JSON.stringify([c.connection, c.items_path, c.mapping]);
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

    // ── Autenticação ───────────────────────────────────────────────
    function intAuthFieldRow(label, id, value, type, help) {
        const wrap = document.createElement('div');
        const lbl = document.createElement('label');
        lbl.className = 'auth-label';
        lbl.setAttribute('for', id);
        lbl.textContent = label;
        wrap.appendChild(lbl);
        const inp = document.createElement('input');
        inp.className = 'auth-input';
        inp.id = id;
        inp.type = type || 'text';
        inp.value = value || '';
        inp.autocomplete = 'off';
        wrap.appendChild(inp);
        if (help) {
            const h = document.createElement('p');
            h.className = 'int-step-help';
            h.textContent = help;
            wrap.appendChild(h);
        }
        return wrap;
    }

    function renderAuthFields(type, vals) {
        vals = vals || {};
        if (!intAuthFields) return;
        intAuthFields.innerHTML = '';
        if (type === 'api_key') {
            intAuthFields.appendChild(intAuthFieldRow('Nome do cabeçalho', 'int-auth-header', vals.header || 'X-API-Key', 'text', 'Geralmente algo como "X-API-Key" ou "apikey".'));
            intAuthFields.appendChild(intAuthFieldRow('Chave', 'int-auth-value', vals.value || '', 'text'));
        } else if (type === 'bearer') {
            intAuthFields.appendChild(intAuthFieldRow('Token de acesso', 'int-auth-token', vals.token || '', 'text', 'Cole o token; ele será enviado como "Authorization: Bearer ...".'));
        } else if (type === 'query_key') {
            intAuthFields.appendChild(intAuthFieldRow('Nome do parâmetro na URL', 'int-auth-param', vals.param || 'api_key', 'text', 'Ex: "api_key" ou "token" — vira ?api_key=...'));
            intAuthFields.appendChild(intAuthFieldRow('Valor da chave/token', 'int-auth-value', vals.value || '', 'text'));
        } else if (type === 'basic') {
            intAuthFields.appendChild(intAuthFieldRow('Usuário', 'int-auth-username', vals.username || '', 'text'));
            intAuthFields.appendChild(intAuthFieldRow('Senha', 'int-auth-password', vals.password || '', 'password'));
        } else if (type === 'oauth2') {
            intAuthFields.appendChild(intAuthFieldRow('URL do token', 'int-auth-token-url', vals.token_url || '', 'text', 'Endpoint que emite o token (grant_type=client_credentials).'));
            intAuthFields.appendChild(intAuthFieldRow('Client ID', 'int-auth-client-id', vals.client_id || '', 'text'));
            intAuthFields.appendChild(intAuthFieldRow('Client Secret', 'int-auth-client-secret', vals.client_secret || '', 'text'));
            intAuthFields.appendChild(intAuthFieldRow('Escopo (opcional)', 'int-auth-scope', vals.scope || '', 'text'));
        }
    }

    // ── Paginação ──────────────────────────────────────────────────
    function renderPagFields(mode, vals) {
        vals = vals || {};
        if (!intPagFields) return;
        intPagFields.innerHTML = '';
        if (mode === 'page' || mode === 'offset') {
            const paramLbl = mode === 'page' ? 'Nome do parâmetro de página' : 'Nome do parâmetro de offset';
            const paramPh = mode === 'page' ? 'page' : 'offset';
            intPagFields.appendChild(intAuthFieldRow(paramLbl, 'int-pag-param', vals.param || paramPh, 'text'));
            const startLbl = mode === 'page' ? 'Página inicial' : 'Offset inicial';
            const startDef = mode === 'page' ? 1 : 0;
            intPagFields.appendChild(intAuthFieldRow(startLbl, 'int-pag-start', (vals.start ?? startDef), 'number'));
            intPagFields.appendChild(intAuthFieldRow('Nome do parâmetro de tamanho (opcional)', 'int-pag-size-param', vals.size_param || (mode === 'offset' ? 'limit' : ''), 'text'));
            intPagFields.appendChild(intAuthFieldRow('Itens por página (tamanho)', 'int-pag-size', (vals.size ?? (mode === 'offset' ? 50 : '')), 'number'));
        } else if (mode === 'cursor') {
            intPagFields.appendChild(intAuthFieldRow('Onde está o próximo cursor/URL na resposta', 'int-pag-next-path', vals.next_path || '', 'text', 'Ex: meta.next ou links.next. Pode ser uma URL completa ou um token.'));
            intPagFields.appendChild(intAuthFieldRow('Nome do parâmetro do cursor (se for token)', 'int-pag-param', vals.param || 'cursor', 'text', 'Ignorado quando a resposta já traz uma URL completa.'));
        }
        if (mode !== 'none') {
            intPagFields.appendChild(intAuthFieldRow('Máximo de páginas a buscar', 'int-pag-max', (vals.max_pages ?? 10), 'number'));
        }
    }

    function readSchedule() {
        const enabled = !!(intSchedEnabled && intSchedEnabled.checked);
        let interval = parseInt(intSchedInterval ? intSchedInterval.value : '0', 10);
        if (isNaN(interval)) interval = 0;
        return { enabled, interval_minutes: interval };
    }

    function updateSchedUI() {
        const on = !!(intSchedEnabled && intSchedEnabled.checked);
        if (intSchedInterval) {
            intSchedInterval.disabled = !on;
            intSchedInterval.classList.toggle('is-disabled', !on);
        }
    }

    function applySchedule(integ) {
        if (intSchedEnabled) intSchedEnabled.checked = !!(integ && integ.schedule_enabled);
        if (intSchedInterval) {
            const iv = integ && integ.schedule_interval_minutes ? integ.schedule_interval_minutes : 60;
            intSchedInterval.value = iv;
        }
        updateSchedUI();
    }

    function readPagination() {
        const mode = intPagMode ? intPagMode.value : 'none';
        if (!mode || mode === 'none') return { mode: 'none' };
        const pag = { mode };
        const num = (id, def) => {
            const v = parseInt(intValOf(id), 10);
            return isNaN(v) ? def : v;
        };
        if (mode === 'page' || mode === 'offset') {
            pag.param = intValOf('int-pag-param').trim();
            pag.start = num('int-pag-start', mode === 'page' ? 1 : 0);
            const sp = intValOf('int-pag-size-param').trim();
            if (sp) pag.size_param = sp;
            const sz = num('int-pag-size', 0);
            if (sz) pag.size = sz;
        } else if (mode === 'cursor') {
            pag.next_path = intValOf('int-pag-next-path').trim();
            pag.param = intValOf('int-pag-param').trim();
        }
        pag.max_pages = num('int-pag-max', 10);
        return pag;
    }

    function readAuth() {
        const type = intAuthType.value;
        const auth = { type };
        if (type === 'api_key') {
            auth.header = intValOf('int-auth-header');
            auth.value = intValOf('int-auth-value');
        } else if (type === 'bearer') {
            auth.token = intValOf('int-auth-token');
        } else if (type === 'query_key') {
            auth.param = intValOf('int-auth-param');
            auth.value = intValOf('int-auth-value');
        } else if (type === 'basic') {
            auth.username = intValOf('int-auth-username');
            auth.password = intValOf('int-auth-password');
        } else if (type === 'oauth2') {
            auth.token_url = intValOf('int-auth-token-url');
            auth.client_id = intValOf('int-auth-client-id');
            auth.client_secret = intValOf('int-auth-client-secret');
            auth.scope = intValOf('int-auth-scope');
        }
        return auth;
    }

    // ── Chave/valor (headers e query) ──────────────────────────────
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

    // ── Projeto ────────────────────────────────────────────────────
    function updateProjectModeUI() {
        const isField = intProjectByField.checked;
        intProjectMode.value = isField ? 'field' : 'fixed';
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

    // ── Campos: dropdowns e chips ──────────────────────────────────
    function fillSelect(select, options, selected) {
        if (!select) return;
        select.innerHTML = '';
        const uniq = [];
        (options || []).forEach(o => { if (uniq.indexOf(o) === -1) uniq.push(o); });
        if (selected && uniq.indexOf(selected) === -1) uniq.unshift(selected);
        uniq.forEach(o => {
            const opt = document.createElement('option');
            opt.value = o;
            opt.textContent = o;
            if (o === selected) opt.selected = true;
            select.appendChild(opt);
        });
    }

    function guessExternalId(fields) {
        if (fields.indexOf('id') !== -1) return 'id';
        const idLike = fields.find(f => /(^|\.)id$|_id$|uuid|key|codigo|código/i.test(f));
        return idLike || fields[0] || 'id';
    }

    function guessTitleField(fields) {
        for (const hint of TITLE_HINT_FIELDS) {
            const found = fields.find(f => f.toLowerCase() === hint || f.toLowerCase().endsWith('.' + hint));
            if (found) return found;
        }
        return fields.find(f => f !== 'id') || fields[0] || '';
    }

    function insertAtCursor(textarea, text) {
        const start = textarea.selectionStart != null ? textarea.selectionStart : textarea.value.length;
        const end = textarea.selectionEnd != null ? textarea.selectionEnd : textarea.value.length;
        const before = textarea.value.slice(0, start);
        const sep = (before && !/\s$/.test(before)) ? ' ' : '';
        const insert = sep + text;
        textarea.value = before + insert + textarea.value.slice(end);
        textarea.focus();
        const pos = start + insert.length;
        textarea.setSelectionRange(pos, pos);
        updateTitlePreview();
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
        if (!fields || !fields.length) {
            const span = document.createElement('span');
            span.className = 'int-muted';
            span.textContent = 'Nenhum campo detectado. Volte ao passo 1 e clique em "Buscar dados".';
            intFieldChips.appendChild(span);
        }
    }

    // ── Serialização form <-> config ───────────────────────────────
    function getFormConfig() {
        const isField = intProjectByField.checked;
        const project = isField
            ? { mode: 'field', field: intProjectField.value.trim() }
            : { mode: 'fixed', value: intProjectValue.value };
        return {
            connection: {
                base_url: intUrl.value.trim(),
                path: '',
                method: intMethod.value,
                headers: collectKv(intHeaders),
                query: collectKv(intQuery),
                auth: readAuth(),
                allow_private: intAllowPrivate.checked,
            },
            items_path: intItemsPathSel.value || '',
            mapping: {
                external_id: (intExternalId.value || '').trim() || 'id',
                project: project,
                text_template: intTextTemplate.value,
                // O dia da semana é definido por tarefa na revisão (passo 4).
                due_date: { mode: 'none' },
            },
            on_update: intOnUpdate.value,
            reimport_deleted: !!(intReimportDeleted && intReimportDeleted.checked),
            pagination: readPagination(),
        };
    }

    function applyConfig(cfg) {
        cfg = cfg || {};
        const conn = cfg.connection || {};
        const map = cfg.mapping || {};
        // Junta base_url + path numa URL única (compatível com configs antigas).
        let url = (conn.base_url || '').trim();
        const path = (conn.path || '').trim();
        if (path) {
            url = url.replace(/\/$/, '') + (path.startsWith('/') ? path : '/' + path);
        }
        intUrl.value = url;
        intMethod.value = (conn.method || 'GET').toUpperCase();
        intAllowPrivate.checked = !!conn.allow_private;
        const auth = conn.auth || { type: 'none' };
        intAuthType.value = auth.type || 'none';
        renderAuthFields(intAuthType.value, auth);
        intHeaders.innerHTML = '';
        Object.entries(conn.headers || {}).forEach(([k, v]) => kvAddRow(intHeaders, k, v));
        intQuery.innerHTML = '';
        Object.entries(conn.query || {}).forEach(([k, v]) => kvAddRow(intQuery, k, v));

        fillSelect(intItemsPathSel, cfg.items_path ? [cfg.items_path] : [], cfg.items_path || '');
        const proj = map.project || { mode: 'fixed' };
        const byField = proj.mode === 'field';
        intProjectByField.checked = byField;
        syncProjectDropdown(byField ? '' : (proj.value || ''));
        intProjectField.value = proj.field || '';
        updateProjectModeUI();

        const savedExt = map.external_id || 'id';
        fillSelect(intExternalId, [savedExt], savedExt);
        intTextTemplate.value = map.text_template || '';
        intOnUpdate.value = cfg.on_update || 'skip';
        if (intReimportDeleted) intReimportDeleted.checked = !!cfg.reimport_deleted;

        const pag = cfg.pagination || { mode: 'none' };
        if (intPagMode) {
            intPagMode.value = pag.mode || 'none';
            renderPagFields(intPagMode.value, pag);
        }
    }

    function fillForm(integ) {
        intId.value = integ && integ.id ? integ.id : '';
        intName.value = integ && integ.name ? integ.name : '';
        intSampleItem = null;
        intFieldsList = [];
        intPreviewRows = [];
        intPreviewTotal = 0;
        intPreviewSig = '';
        applyConfig((integ && integ.config) || {});
        applySchedule(integ);
        renderFieldChips([]);
        if (intItemsSummary) intItemsSummary.innerHTML = '';
        if (intItemsChoice) intItemsChoice.classList.add('hidden');
        if (intSample) intSample.textContent = '';
        if (intFetchStatus) intFetchStatus.textContent = '';
        if (intPreviewResult) intPreviewResult.innerHTML = '';
        if (intBulkBar) intBulkBar.classList.add('hidden');
        updateTitlePreview();
    }

    function syncJsonFromForm() {
        if (intJson) intJson.value = JSON.stringify(getFormConfig(), null, 2);
    }

    // ── Lista ──────────────────────────────────────────────────────
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

    function intFmtWhen(iso) {
        if (!iso) return '';
        // Backend grava em UTC sem sufixo; força interpretação como UTC.
        const norm = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z';
        const d = new Date(norm);
        if (isNaN(d.getTime())) return '';
        const min = Math.floor((Date.now() - d.getTime()) / 60000);
        if (min < 1) return 'agora mesmo';
        if (min < 60) return `há ${min} min`;
        const h = Math.floor(min / 60);
        if (h < 24) return `há ${h} h`;
        const days = Math.floor(h / 24);
        return days === 1 ? 'ontem' : `há ${days} dias`;
    }

    function intFmtNext(iso) {
        if (!iso) return '';
        const norm = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z';
        const d = new Date(norm);
        if (isNaN(d.getTime())) return '';
        const min = Math.round((d.getTime() - Date.now()) / 60000);
        if (min <= 0) return 'em instantes';
        if (min < 60) return `em ${min} min`;
        const h = Math.floor(min / 60);
        if (h < 24) return `em ${h} h`;
        const days = Math.floor(h / 24);
        return days === 1 ? 'amanhã' : `em ${days} dias`;
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
            const when = intFmtWhen(integ.last_run_at);
            let meta;
            if (status === 'ok') {
                const n = integ.last_item_count || 0;
                meta = `Última importação: ${n} tarefa(s)${when ? ' • ' + when : ''}`;
            } else if (status === 'error') {
                meta = `Falhou${when ? ' ' + when : ''}: ${integ.last_error || 'erro desconhecido'}`;
            } else {
                meta = 'Ainda não foi executada';
            }
            const paused = !integ.enabled;
            let schedLine = '';
            if (paused) {
                schedLine = '<div class="int-card-sched int-card-sched--paused">⏸ Pausada — não roda automaticamente</div>';
            } else if (integ.schedule_enabled && integ.schedule_interval_minutes) {
                const nextWhen = intFmtNext(integ.next_run_at);
                schedLine = `<div class="int-card-sched">⏱ A cada ${integ.schedule_interval_minutes} min${nextWhen ? ' • próxima ' + nextWhen : ''}</div>`;
            }
            const card = document.createElement('div');
            card.className = 'int-card' + (paused ? ' int-card--paused' : '');
            const toggleLabel = paused ? 'Ativar' : 'Pausar';
            const toggleTitle = paused
                ? 'Reativa a integração (volta a rodar no agendamento)'
                : 'Pausa a integração (não roda no agendamento; ainda dá para executar manualmente)';
            card.innerHTML = `
                <div class="int-card-main">
                    <div class="int-card-title">${escapeHTML(integ.name)}</div>
                    <div class="int-card-sub">${escapeHTML(baseUrl)}</div>
                    <div class="int-card-meta int-meta-${escapeHTML(status)}">${escapeHTML(meta)}</div>
                    ${schedLine}
                </div>
                <div class="int-card-status int-status-${escapeHTML(status)}">${statusText}</div>
                <div class="int-card-actions">
                    <button class="int-text-btn" data-act="edit">Editar</button>
                    <button class="int-text-btn" data-act="history">Histórico</button>
                    <button class="int-text-btn" data-act="toggle" title="${toggleTitle}">${toggleLabel}</button>
                    <button class="int-text-btn int-btn-runcard" data-act="run" title="Re-importa da fonte aplicando as regras automáticas (sem os ajustes manuais da revisão)">Executar</button>
                </div>`;
            card.querySelector('[data-act="edit"]').addEventListener('click', () => openEditorById(integ.id));
            card.querySelector('[data-act="history"]').addEventListener('click', () => openHistory(integ.id, integ.name));
            card.querySelector('[data-act="toggle"]').addEventListener('click', () => toggleEnabled(integ.id, !integ.enabled));
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
            fillForm(integ);
            intEditorTitle.textContent = integ.name;
            intRunBtn.textContent = 'Importar agora';
            intDeleteBtn.classList.remove('hidden');
            intShowEditor();
            goToStep(1);
        } catch (e) {
            showToast('Erro ao carregar integração');
        }
    }

    function openNewIntegration() {
        intAlertShow('', false, true);
        fillForm(null);
        renderAuthFields('none', {});
        intEditorTitle.textContent = 'Nova integração';
        intRunBtn.textContent = 'Salvar e importar agora';
        intDeleteBtn.classList.add('hidden');
        intShowEditor();
        goToStep(1);
    }

    // ── Passo 1 -> 2: buscar dados e detectar ──────────────────────
    function intTestBody() {
        const cfg = getFormConfig();
        const body = { connection: cfg.connection, items_path: cfg.items_path };
        // Ao editar, envia o id para o backend restaurar segredos mascarados.
        if (intId.value) body.id = parseInt(intId.value, 10);
        return body;
    }

    async function onFetch() {
        if (!intUrl.value.trim()) { intFetchStatus.textContent = 'Informe a URL da API.'; return; }
        intFetchBtn.disabled = true;
        intFetchStatus.textContent = 'Buscando…';
        try {
            const res = await apiFetch('/api/integrations/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(intTestBody()),
            });
            const data = await res.json();
            if (!res.ok) {
                intFetchStatus.innerHTML = `<span class="int-error-inline">${escapeHTML(data.error || 'Falha ao buscar.')}</span>`;
                return;
            }
            applyFetchResult(data);
            intFetchStatus.textContent = '';
            goToStep(2);
        } catch (e) {
            intFetchStatus.innerHTML = '<span class="int-error-inline">Erro de rede ao buscar dados.</span>';
        } finally {
            intFetchBtn.disabled = false;
        }
    }

    function applyFetchResult(data) {
        const arrays = data.arrays || [];
        // Escolhe automaticamente o array com mais itens (ou o caminho atual, se houver).
        let chosen = intItemsPathSel.value || '';
        const arrayPaths = arrays.map(a => a.path);
        if (!chosen || arrayPaths.indexOf(chosen) === -1) {
            if (arrays.length) {
                chosen = arrays.slice().sort((a, b) => (b.count || 0) - (a.count || 0))[0].path;
            } else {
                chosen = '';
            }
        }
        // Popula dropdown de "onde estão os itens".
        intItemsPathSel.innerHTML = '';
        if (arrays.length) {
            arrays.forEach(a => {
                const opt = document.createElement('option');
                opt.value = a.path;
                opt.textContent = (a.path || '(raiz)') + ` — ${a.count} item(ns)`;
                if (a.path === chosen) opt.selected = true;
                intItemsPathSel.appendChild(opt);
            });
            intItemsChoice.classList.toggle('hidden', arrays.length <= 1);
        } else {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '(resposta inteira)';
            intItemsPathSel.appendChild(opt);
            intItemsChoice.classList.add('hidden');
        }

        intSampleItem = data.sample_item || null;
        intFieldsList = data.fields || [];

        // Resumo amigável.
        const count = data.item_count || 0;
        intItemsSummary.innerHTML = count
            ? `<div class="int-big-count">${count}</div><div class="int-muted">item(ns) encontrado(s) e prontos para virar tarefas.</div>`
            : '<div class="int-muted">Nenhum item encontrado no caminho detectado. Tente ajustar a URL ou escolher outra lista abaixo.</div>';

        // Amostra do item.
        const sampleStr = JSON.stringify(intSampleItem, null, 2) || '';
        intSample.textContent = sampleStr.slice(0, 4000);

        // Auto-seleções amigáveis.
        fillSelect(intExternalId, intFieldsList, guessExternalId(intFieldsList));
        if (!intTextTemplate.value.trim() && intFieldsList.length) {
            const idf = guessExternalId(intFieldsList);
            const titf = guessTitleField(intFieldsList);
            intTextTemplate.value = titf && titf !== idf ? `{{ ${idf} }} — {{ ${titf} }}` : `{{ ${titf || idf} }}`;
        }
        renderFieldChips(intFieldsList);
        updateTitlePreview();
    }

    async function onItemsPathChange() {
        // Rebusca para atualizar contagem/campos ao trocar a lista de itens.
        try {
            const res = await apiFetch('/api/integrations/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(intTestBody()),
            });
            const data = await res.json();
            if (!res.ok) return;
            intSampleItem = data.sample_item || null;
            intFieldsList = data.fields || [];
            const count = data.item_count || 0;
            intItemsSummary.innerHTML = count
                ? `<div class="int-big-count">${count}</div><div class="int-muted">item(ns) encontrado(s) e prontos para virar tarefas.</div>`
                : '<div class="int-muted">Nenhum item encontrado nesta lista.</div>';
            intSample.textContent = (JSON.stringify(intSampleItem, null, 2) || '').slice(0, 4000);
            fillSelect(intExternalId, intFieldsList, guessExternalId(intFieldsList));
        } catch (e) { /* silencioso */ }
    }

    // ── Preview interativa ─────────────────────────────────────────
    function intProjectNames() {
        return Array.from(document.querySelectorAll('.project-nav'))
            .map(el => normText(el.textContent)).filter(Boolean);
    }

    function optionsHtml(values, selected) {
        return values.map(v =>
            `<option value="${escapeHTML(v)}"${v === selected ? ' selected' : ''}>${escapeHTML(v || '—')}</option>`
        ).join('');
    }

    function rowIsValid(r) {
        return !!(r.external_id && (r.project || '').trim() && (r.text || '').trim());
    }

    async function onPreview() {
        intPreviewResult.innerHTML = '<p class="int-muted">Gerando prévia…</p>';
        if (intBulkBar) intBulkBar.classList.add('hidden');
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
                intPreviewResult.innerHTML = `<div class="int-error">${escapeHTML(data.error || 'Falha na prévia.')}</div>`;
                return;
            }
            intPreviewTotal = data.total_items || 0;
            intPreviewRows = (data.preview || []).map(r => ({
                external_id: r.external_id || '',
                project: r.project || '',
                text: r.text || '',
                due_date: WEEKDAYS.indexOf(r.due_date) !== -1 ? r.due_date : '',
                include: !!r.valid,
            }));
            intPreviewSig = getPreviewSig();
            renderPreviewTable();
        } catch (e) {
            intPreviewResult.innerHTML = '<div class="int-error">Erro de rede na prévia.</div>';
        }
    }

    function renderPreviewTable() {
        if (!intPreviewRows.length) {
            intPreviewResult.innerHTML = '<p class="int-muted">Nenhum item para importar. Revise os passos anteriores.</p>';
            if (intBulkBar) intBulkBar.classList.add('hidden');
            return;
        }
        const projects = intProjectNames();
        const shown = intPreviewRows.length;
        let html = `<div class="int-preview-head"><span class="int-muted">${intPreviewTotal} item(ns) no total • exibindo ${shown}. Ajuste o que quiser antes de importar.</span>` +
            '<button id="int-reload-preview" class="int-text-btn" type="button" title="Descarta ajustes e busca de novo da fonte">↻ Recarregar da fonte</button></div>';
        if (intPreviewTotal > shown) {
            html += `<div class="int-warn">Mostrando os primeiros ${shown} de ${intPreviewTotal} itens. O assistente importa apenas os exibidos; para importar todos de uma vez (aplicando as regras automáticas), use "Executar" na lista.</div>`;
        }
        html += '<table class="int-table int-table-edit"><thead><tr>' +
            '<th class="int-col-check"><input type="checkbox" id="int-check-all" title="Selecionar todas"></th>' +
            '<th>Identificador</th><th>Projeto</th><th>Dia</th><th>Texto da tarefa</th><th></th>' +
            '</tr></thead><tbody>';
        intPreviewRows.forEach((r, i) => {
            const valid = rowIsValid(r);
            // Monta as opções de projeto garantindo que o valor atual (mesmo vazio
            // ou vindo de um campo) apareça e fique selecionado, sem desalinhar do estado.
            const projValues = [];
            if (!r.project) projValues.push('');
            if (r.project && projects.indexOf(r.project) === -1) projValues.push(r.project);
            projects.forEach(p => projValues.push(p));
            const projOpts = optionsHtml(projValues, r.project);
            const dayOpts = optionsHtml([''].concat(WEEKDAYS), r.due_date);
            html += `<tr class="${valid ? '' : 'int-row-invalid'}" data-i="${i}">
                <td class="int-col-check"><input type="checkbox" class="int-row-check" ${r.include ? 'checked' : ''}></td>
                <td>${escapeHTML(r.external_id)}</td>
                <td><select class="auth-input int-cell-select int-cell-project">${projOpts}</select></td>
                <td><select class="auth-input int-cell-select int-cell-day">${dayOpts}</select></td>
                <td class="int-cell-text" title="${escapeHTML(r.text)}">${escapeHTML(r.text)}</td>
                <td>${valid ? '✓' : '⚠'}</td></tr>`;
        });
        html += '</tbody></table>';
        intPreviewResult.innerHTML = html;

        // Liga os eventos das células.
        intPreviewResult.querySelectorAll('tr[data-i]').forEach(tr => {
            const i = parseInt(tr.dataset.i, 10);
            tr.querySelector('.int-row-check').addEventListener('change', (e) => {
                intPreviewRows[i].include = e.target.checked;
                updateBulkCount();
            });
            tr.querySelector('.int-cell-project').addEventListener('change', (e) => {
                intPreviewRows[i].project = e.target.value;
                tr.classList.toggle('int-row-invalid', !rowIsValid(intPreviewRows[i]));
                tr.querySelector('td:last-child').textContent = rowIsValid(intPreviewRows[i]) ? '✓' : '⚠';
            });
            tr.querySelector('.int-cell-day').addEventListener('change', (e) => {
                intPreviewRows[i].due_date = e.target.value;
            });
        });
        const checkAll = document.getElementById('int-check-all');
        if (checkAll) {
            checkAll.addEventListener('change', (e) => {
                const on = e.target.checked;
                intPreviewRows.forEach(r => { r.include = on; });
                intPreviewResult.querySelectorAll('.int-row-check').forEach(cb => { cb.checked = on; });
                updateBulkCount();
            });
        }
        const reloadBtn = document.getElementById('int-reload-preview');
        if (reloadBtn) reloadBtn.addEventListener('click', () => onPreview());

        // Barra de ações em massa.
        if (intBulkBar) {
            intBulkBar.classList.remove('hidden');
            fillSelect(intBulkProject, projects, projects[0] || '');
        }
        updateBulkCount();
    }

    function updateBulkCount() {
        if (!intBulkCount) return;
        const n = intPreviewRows.filter(r => r.include).length;
        intBulkCount.textContent = `${n} selecionada(s)`;
    }

    function applyBulkProject() {
        const proj = intBulkProject.value;
        if (!proj) return;
        let changed = 0;
        intPreviewRows.forEach(r => { if (r.include) { r.project = proj; changed++; } });
        if (changed) { renderPreviewTable(); showToast(`${changed} tarefa(s) movida(s) para "${proj}"`); }
    }

    function applyBulkWeekday() {
        const day = intBulkWeekday.value;
        let changed = 0;
        intPreviewRows.forEach(r => { if (r.include) { r.due_date = day; changed++; } });
        if (changed) { renderPreviewTable(); showToast(`Dia atualizado em ${changed} tarefa(s)`); }
    }

    // ── Salvar / executar / excluir ────────────────────────────────
    async function saveIntegration() {
        const name = intName.value.trim();
        if (!name) { intAlertShow('Dê um nome à integração (passo 1).', true); return null; }
        const config = getFormConfig();
        const schedule = readSchedule();
        const editingId = intId.value ? parseInt(intId.value, 10) : null;
        const payload = { name, config, schedule };
        const res = editingId
            ? await apiFetch(`/api/integrations/${editingId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            })
            : await apiFetch('/api/integrations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
        const data = await res.json();
        if (!res.ok) { intAlertShow(data.error || 'Falha ao salvar.', true); return null; }
        if (!editingId && data.id) intId.value = data.id;
        intEditorTitle.textContent = name;
        intDeleteBtn.classList.remove('hidden');
        intRunBtn.textContent = 'Importar agora';
        return parseInt(intId.value, 10);
    }

    async function onSave() {
        intSetBusy(true);
        try {
            const id = await saveIntegration();
            if (id) {
                const sched = readSchedule();
                const msg = sched.enabled && sched.interval_minutes
                    ? `Integração salva • agendada a cada ${sched.interval_minutes} min`
                    : 'Integração salva';
                intAlertShow(msg, false);
                showToast(msg);
                loadIntegrations();
            }
        } catch (e) {
            intAlertShow('Erro de rede ao salvar.', true);
        } finally {
            intSetBusy(false);
        }
    }

    function intSetBusy(busy) {
        [intSaveBtn, intRunBtn, intDeleteBtn].forEach(b => { if (b) b.disabled = busy; });
    }

    async function onImport() {
        const chosen = intPreviewRows.filter(r => r.include && rowIsValid(r));
        if (!chosen.length) {
            intAlertShow('Selecione ao menos uma tarefa válida para importar.', true);
            return;
        }
        intSetBusy(true);
        try {
            const id = await saveIntegration();
            if (!id) return;
            intAlertShow('Importando…', false);
            const items = chosen.map(r => ({
                external_id: r.external_id,
                project: r.project,
                text: r.text,
                due_date: r.due_date,
            }));
            const res = await apiFetch(`/api/integrations/${id}/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    items,
                    on_update: intOnUpdate.value,
                    reimport_deleted: !!(intReimportDeleted && intReimportDeleted.checked),
                }),
            });
            const data = await res.json();
            if (!res.ok) { intAlertShow(data.error || 'Falha ao importar.', true); return; }
            const parts = [`${data.created} criada(s)`];
            if (data.updated) parts.push(`${data.updated} atualizada(s)`);
            if (data.skipped) parts.push(`${data.skipped} ignorada(s)`);
            showToast('Importado: ' + parts.join(' • '));
            await fetchInitialData();
            intAlertShow('', false, true);
            intShowList();
            loadIntegrations();
        } catch (e) {
            intAlertShow('Erro de rede ao importar.', true);
        } finally {
            intSetBusy(false);
        }
    }

    async function toggleEnabled(id, enabled) {
        try {
            const res = await apiFetch(`/api/integrations/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled }),
            });
            if (!res.ok) { showToast('Falha ao atualizar'); return; }
            showToast(enabled ? 'Integração reativada' : 'Integração pausada');
            loadIntegrations();
        } catch (e) {
            showToast('Erro de rede');
        }
    }

    async function runById(id) {
        showToast('Executando integração…');
        try {
            const res = await apiFetch(`/api/integrations/${id}/run`, { method: 'POST' });
            const data = await res.json();
            if (!res.ok) { showToast(data.error || 'Falha ao executar'); return; }
            const parts = [`${data.created} criada(s)`];
            if (data.updated) parts.push(`${data.updated} atualizada(s)`);
            if (data.skipped) parts.push(`${data.skipped} ignorada(s)`);
            showToast('Importado: ' + parts.join(' • '));
            await fetchInitialData();
            loadIntegrations();
            if (intHistoryCurrent && intHistoryCurrent.id === id) loadHistory();
        } catch (e) {
            showToast('Erro ao executar');
        }
    }

    // ── Histórico de execuções ─────────────────────────────────────
    const intHistoryOverlay = document.getElementById('int-history-overlay');
    const intHistoryBody    = document.getElementById('int-history-body');
    const intHistoryTitle   = document.getElementById('int-history-title');
    const intHistoryClose   = document.getElementById('int-history-close');
    const intHistoryRefresh = document.getElementById('int-history-refresh');
    let intHistoryCurrent   = null;

    function intTriggerLabel(t) {
        if (t === 'import') return 'Revisão manual';
        if (t === 'schedule') return 'Agendado';
        return 'Manual';
    }

    function renderRuns(runs) {
        if (!runs.length) {
            intHistoryBody.innerHTML = '<p class="int-muted">Nenhuma execução registrada ainda.</p>';
            return;
        }
        const rows = runs.map(r => {
            const when = intFmtWhen(r.finished_at || r.started_at) || '';
            const st = r.status === 'ok' ? 'ok' : 'error';
            const stText = r.status === 'ok' ? 'OK' : 'Erro';
            const detail = r.status === 'ok'
                ? `${r.created} criada(s) • ${r.updated} atualizada(s) • ${r.skipped} ignorada(s)`
                : escapeHTML(r.error || 'erro desconhecido');
            return `
                <div class="int-run-row">
                    <span class="int-run-status int-status-${st}">${stText}</span>
                    <div class="int-run-info">
                        <div class="int-run-detail">${detail}</div>
                        <div class="int-run-meta">${escapeHTML(intTriggerLabel(r.trigger))}${when ? ' • ' + when : ''} • ${r.total_items} item(ns)</div>
                    </div>
                </div>`;
        }).join('');
        intHistoryBody.innerHTML = rows;
    }

    async function loadHistory() {
        if (!intHistoryCurrent) return;
        intHistoryBody.innerHTML = '<p class="int-muted">Carregando…</p>';
        try {
            const res = await apiFetch(`/api/integrations/${intHistoryCurrent.id}/runs?limit=50`);
            const data = await res.json();
            if (!res.ok) {
                intHistoryBody.innerHTML = `<p class="int-error-inline">${escapeHTML(data.error || 'Falha ao carregar histórico.')}</p>`;
                return;
            }
            renderRuns(data);
        } catch (e) {
            intHistoryBody.innerHTML = '<p class="int-error-inline">Erro de rede ao carregar histórico.</p>';
        }
    }

    function openHistory(id, name) {
        if (!intHistoryOverlay) return;
        intHistoryCurrent = { id, name };
        intHistoryTitle.textContent = `Histórico — ${name}`;
        intHistoryOverlay.classList.remove('hidden');
        loadHistory();
    }

    function closeHistory() {
        if (intHistoryOverlay) intHistoryOverlay.classList.add('hidden');
        intHistoryCurrent = null;
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

    // ── Listeners ──────────────────────────────────────────────────
    if (integrationsView) {
        intNewBtn.addEventListener('click', openNewIntegration);
        intBackBtn.addEventListener('click', () => { intShowList(); loadIntegrations(); });
        intAuthType.addEventListener('change', () => renderAuthFields(intAuthType.value, {}));
        if (intPagMode) intPagMode.addEventListener('change', () => renderPagFields(intPagMode.value, {}));
        if (intSchedEnabled) intSchedEnabled.addEventListener('change', updateSchedUI);
        intAddHeader.addEventListener('click', () => kvAddRow(intHeaders, '', ''));
        intAddQuery.addEventListener('click', () => kvAddRow(intQuery, '', ''));
        intProjectByField.addEventListener('change', updateProjectModeUI);
        intFetchBtn.addEventListener('click', onFetch);
        intItemsPathSel.addEventListener('change', onItemsPathChange);
        intTo3Btn.addEventListener('click', () => goToStep(3));
        intTo4Btn.addEventListener('click', () => goToStep(4));
        intTextTemplate.addEventListener('input', updateTitlePreview);
        intSaveBtn.addEventListener('click', onSave);
        intRunBtn.addEventListener('click', onImport);
        intDeleteBtn.addEventListener('click', onDelete);
        if (intBulkProjectApply) intBulkProjectApply.addEventListener('click', applyBulkProject);
        if (intBulkWeekdayApply) intBulkWeekdayApply.addEventListener('click', applyBulkWeekday);

        if (intHistoryClose) intHistoryClose.addEventListener('click', closeHistory);
        if (intHistoryRefresh) intHistoryRefresh.addEventListener('click', loadHistory);
        if (intHistoryOverlay) {
            intHistoryOverlay.addEventListener('click', (e) => {
                if (e.target === intHistoryOverlay) closeHistory();
            });
        }

        // Navegação livre pelos números do stepper.
        intStepper.querySelectorAll('.int-step').forEach(s => {
            s.addEventListener('click', () => goToStep(parseInt(s.dataset.step, 10)));
        });
        // Botões "← Voltar" internos dos passos.
        intEditor.querySelectorAll('[data-goto]').forEach(b => {
            b.addEventListener('click', () => goToStep(parseInt(b.dataset.goto, 10)));
        });

        // JSON avançado: preencher ao abrir, aplicar ao clicar.
        const jsonDetails = document.querySelector('.int-json-advanced');
        if (jsonDetails) {
            jsonDetails.addEventListener('toggle', () => { if (jsonDetails.open) syncJsonFromForm(); });
        }
        if (intJsonApply) {
            intJsonApply.addEventListener('click', () => {
                try {
                    applyConfig(JSON.parse(intJson.value));
                    intAlertShow('JSON aplicado ao formulário.', false);
                } catch (e) {
                    intAlertShow('JSON inválido.', true);
                }
            });
        }
    }

});
