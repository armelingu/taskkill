/**
 * O JavaScript puro aqui adiciona interatividade e lógica de estado simples
 * focando na funcionalidade e em manutenabilidade com manipulação direta do DOM.
 */

document.addEventListener('DOMContentLoaded', () => {
    // 1. Elementos da Interface
    const skeletonItems = document.querySelectorAll('.skeleton-item:not(.system-action)');
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

    // Seção "Sistema" colapsável
    const sistemaToggle = document.getElementById('sistema-toggle');
    const sistemaItems  = document.getElementById('sistema-items');
    if (sistemaToggle && sistemaItems) {
        const toggleSistema = () => {
            const expanded = sistemaToggle.getAttribute('aria-expanded') === 'true';
            sistemaToggle.setAttribute('aria-expanded', String(!expanded));
            sistemaItems.classList.toggle('hidden', expanded);
        };
        sistemaToggle.addEventListener('click', toggleSistema);
        sistemaToggle.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSistema(); }
        });
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

    // Conecta com o Backend logo ao abrir
    async function fetchInitialData() {
        try {
            const res = await apiFetch('/api/tasks');
            if(res.ok) {
                tasksData = await res.json();
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
            skeletonItems.forEach(sib => sib.classList.remove('active'));
            item.classList.add('active');

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
            if (item.id === 'nav-dashboard') return; // Não permite soltar no dashboard global
            e.preventDefault(); // Permitir o Drop
            item.classList.add('drag-over');
        });

        item.addEventListener('dragleave', e => {
            item.classList.remove('drag-over');
        });

        item.addEventListener('drop', e => {
            e.preventDefault();
            item.classList.remove('drag-over');
            if (item.id === 'nav-dashboard') return;

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

});
