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
