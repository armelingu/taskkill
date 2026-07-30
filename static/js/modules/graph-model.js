/**
 * Construção PURA do modelo do grafo (nós + arestas) a partir dos dados.
 *
 * Recebe os dias e projetos já extraídos do DOM (pelo chamador) e o mapa de
 * tarefas. Não toca no DOM, então é testável isoladamente
 * (ver tests/js/graph.test.mjs).
 *
 * Relações modeladas:
 *  - Dia  <-> Projeto  (tarefas com due_date; o "dia" é o dia da semana da data
 *    ISO da tarefa, agregando todas as datas de um mesmo dia em ≤7 nós)
 *  - Projeto <-> Tag   (hashtags no texto das tarefas)
 *  - Projeto <-> Projeto (tags compartilhadas)
 *  - Tarefa  -> Tarefa  (dependência real, direcionada: pré-requisito -> dependente);
 *    só entram nós de tarefa que participam de alguma dependência (minimalismo),
 *    e cada nó de tarefa se liga ao seu projeto.
 */

import { normText, weekdayShort } from './util.js';

export function buildGraphModel(days, projects, tasksData) {
    days = days || [];
    projects = projects || [];
    tasksData = tasksData || {};

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
            r: type === 'day' ? 12 : (type === 'tag' ? 11 : (type === 'task' ? 9 : 14))
        };
        nodeById.set(id, n);
        nodes.push(n);
        return n;
    }

    days.forEach(d => addNode('day', d, d));
    projects.forEach(p => addNode('project', p, p));

    const edges = [];

    // Dia <-> Projeto (tarefas com due_date). O nó "dia" é o dia da SEMANA da
    // data ISO (Seg…Dom), então datas diferentes de um mesmo dia agregam.
    const counts = new Map(); // day||project -> count
    for (const p of projects) {
        const list = (tasksData[p] || []).filter(t => !t.deleted);
        for (const t of list) {
            const d = weekdayShort(t.due_date || '');
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

    // Tags (relações Projeto <-> Tag e Projeto <-> Projeto)
    const tagRe = /(^|\s)#([\w\u00C0-\u00FF]+)/g;
    const tagsByProject = new Map();       // proj -> Set(tag)
    const tagCountsByProject = new Map();  // proj -> Map(tag -> count)
    const tagCountsGlobal = new Map();     // tag -> count
    for (const p of projects) {
        const set = new Set();
        const localCounts = new Map();
        const list = (tasksData[p] || []).filter(t => !t.deleted);
        for (const t of list) {
            const text = String(t.text || '');
            let m;
            while ((m = tagRe.exec(text)) !== null) {
                const tag = String(m[2] || '').toLowerCase();
                if (!tag) continue;
                set.add(tag);
                localCounts.set(tag, (localCounts.get(tag) || 0) + 1);
                tagCountsGlobal.set(tag, (tagCountsGlobal.get(tag) || 0) + 1);
            }
        }
        tagsByProject.set(p, set);
        tagCountsByProject.set(p, localCounts);
    }

    // Mantém o grafo minimalista: limita o número de tags na visão global.
    const topTags = Array.from(tagCountsGlobal.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 14)
        .map(([t]) => t);
    const topTagSet = new Set(topTags);

    topTags.forEach(t => addNode('tag', t, `#${t}`));

    for (const p of projects) {
        const localCounts = tagCountsByProject.get(p);
        if (!localCounts) continue;
        for (const [t, c] of localCounts.entries()) {
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

    // Tarefa -> Tarefa (dependências reais, direcionadas). Só entram nós de
    // tarefa que participam de alguma dependência (mantém o grafo enxuto).
    const taskById = new Map();
    for (const p of projects) {
        for (const t of (tasksData[p] || [])) {
            if (t.deleted) continue;
            taskById.set(t.id, { task: t, project: p });
        }
    }
    const participants = new Set();
    const depPairs = [];  // [prereqId, dependentId]
    for (const { task: t } of taskById.values()) {
        const deps = Array.isArray(t.depends_on) ? t.depends_on : [];
        for (const depId of deps) {
            if (!taskById.has(depId)) continue;  // pré-requisito arquivado/ausente
            participants.add(t.id);
            participants.add(depId);
            depPairs.push([depId, t.id]);
        }
    }
    for (const id of participants) {
        const entry = taskById.get(id);
        const text = String(entry.task.text || '');
        const label = text.length > 22 ? text.slice(0, 21) + '…' : text;
        const node = addNode('task', String(id), label);
        node.completed = !!entry.task.completed;
        node.projectKey = entry.project;
        // Liga a tarefa ao seu projeto (aresta leve) para agrupar visualmente.
        const projId = `project:${entry.project}`;
        if (nodeById.has(projId)) {
            edges.push({ a: node.id, b: projId, weight: 1, kind: 'taskproject' });
        }
    }
    for (const [prereqId, dependentId] of depPairs) {
        edges.push({
            a: `task:${prereqId}`,
            b: `task:${dependentId}`,
            weight: 2,
            kind: 'dependency',
            directed: true,
        });
    }

    // Vincula os nós às arestas.
    for (const e of edges) {
        e.na = nodeById.get(e.a);
        e.nb = nodeById.get(e.b);
    }

    return { nodes, edges };
}
