import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildGraphModel } from '../../static/js/modules/graph-model.js';

// Datas reais ISO: 2026-07-27 é uma segunda-feira; 2026-08-03 também é segunda
// (semana seguinte) — devem agregar no MESMO nó de dia da semana ('Seg').
// 2026-07-28 é terça-feira.
const tasksData = {
    Proj1: [
        { text: 'Task A #infra', due_date: '2026-07-27', deleted: false },
        { text: 'Task B #infra #urgente', due_date: '2026-08-03', deleted: false },
        { text: 'Excluida #infra', due_date: '2026-07-28', deleted: true },
    ],
    Proj2: [
        { text: 'Task C #infra', due_date: '', deleted: false },
    ],
};

test('buildGraphModel cria nós de dia (dia da semana), projeto e tag', () => {
    const { nodes } = buildGraphModel([], ['Proj1', 'Proj2'], tasksData);
    const ids = new Set(nodes.map(n => n.id));
    assert.ok(ids.has('day:Seg'));
    assert.ok(ids.has('project:Proj1'));
    assert.ok(ids.has('project:Proj2'));
    assert.ok(ids.has('tag:infra'));
});

test('buildGraphModel agrega datas do mesmo dia da semana e ignora deletadas', () => {
    const { edges } = buildGraphModel([], ['Proj1', 'Proj2'], tasksData);
    // Duas segundas (datas diferentes) agregam no nó 'Seg' -> weight 2.
    const sched = edges.find(e =>
        e.kind === 'schedule' && e.a === 'day:Seg' && e.b === 'project:Proj1');
    assert.ok(sched, 'aresta de agendamento Seg<->Proj1 deve existir');
    assert.equal(sched.weight, 2);
    // Não deve haver aresta para Terça (única task de terça está deletada).
    assert.ok(!edges.some(e => e.a === 'day:Ter' || e.b === 'day:Ter'));
});

test('buildGraphModel conecta projetos por tag compartilhada', () => {
    const { edges } = buildGraphModel([], ['Proj1', 'Proj2'], tasksData);
    const shared = edges.find(e =>
        e.kind === 'tags' &&
        ((e.a === 'project:Proj1' && e.b === 'project:Proj2') ||
         (e.a === 'project:Proj2' && e.b === 'project:Proj1')));
    assert.ok(shared, 'Proj1 e Proj2 compartilham #infra');
});

// ── Dependências entre tarefas ─────────────────────────────────────
const depData = {
    Proj: [
        { id: 1, text: 'Fundacao', due_date: '', deleted: false, depends_on: [] },
        { id: 2, text: 'Parede', due_date: '', deleted: false, depends_on: [1] },
        { id: 3, text: 'Telhado', due_date: '', deleted: false, depends_on: [2] },
        { id: 4, text: 'Isolada', due_date: '', deleted: false, depends_on: [] },
    ],
};

test('só participantes viram nós de tarefa (isoladas ficam de fora)', () => {
    const { nodes } = buildGraphModel([], ['Proj'], depData);
    const ids = new Set(nodes.map(n => n.id));
    assert.ok(ids.has('task:1'));
    assert.ok(ids.has('task:2'));
    assert.ok(ids.has('task:3'));
    assert.ok(!ids.has('task:4'), 'tarefa sem dependência não vira nó');
});

test('arestas de dependência são direcionadas (pré-requisito -> dependente)', () => {
    const { edges } = buildGraphModel([], ['Proj'], depData);
    const dep = edges.filter(e => e.kind === 'dependency');
    assert.equal(dep.length, 2);
    const e12 = dep.find(e => e.a === 'task:1' && e.b === 'task:2');
    assert.ok(e12 && e12.directed === true, 'Fundacao -> Parede direcionada');
    assert.ok(dep.find(e => e.a === 'task:2' && e.b === 'task:3'));
});

test('cada nó de tarefa se liga ao seu projeto', () => {
    const { edges } = buildGraphModel([], ['Proj'], depData);
    const tp = edges.filter(e => e.kind === 'taskproject');
    assert.ok(tp.find(e => e.a === 'task:1' && e.b === 'project:Proj'));
    assert.ok(tp.find(e => e.a === 'task:2' && e.b === 'project:Proj'));
});

test('pré-requisito deletado não gera nó nem aresta de dependência', () => {
    const data = {
        Proj: [
            { id: 10, text: 'Prereq', due_date: '', deleted: true, depends_on: [] },
            { id: 11, text: 'Dependente', due_date: '', deleted: false, depends_on: [10] },
        ],
    };
    const { nodes, edges } = buildGraphModel([], ['Proj'], data);
    const ids = new Set(nodes.map(n => n.id));
    assert.ok(!ids.has('task:10'));
    assert.ok(!ids.has('task:11'), 'sem pré-requisito válido, não participa');
    assert.ok(!edges.some(e => e.kind === 'dependency'));
});
