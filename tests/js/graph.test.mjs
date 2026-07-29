import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildGraphModel } from '../../static/js/modules/graph-model.js';

const tasksData = {
    Proj1: [
        { text: 'Task A #infra', due_date: 'Segunda', deleted: false },
        { text: 'Task B #infra #urgente', due_date: 'Segunda', deleted: false },
        { text: 'Excluida #infra', due_date: 'Terça', deleted: true },
    ],
    Proj2: [
        { text: 'Task C #infra', due_date: '', deleted: false },
    ],
};

test('buildGraphModel cria nós de dia, projeto e tag', () => {
    const { nodes } = buildGraphModel(['Segunda', 'Terça'], ['Proj1', 'Proj2'], tasksData);
    const ids = new Set(nodes.map(n => n.id));
    assert.ok(ids.has('day:Segunda'));
    assert.ok(ids.has('project:Proj1'));
    assert.ok(ids.has('project:Proj2'));
    assert.ok(ids.has('tag:infra'));
});

test('buildGraphModel ignora tarefas deletadas na contagem', () => {
    const { edges } = buildGraphModel(['Segunda', 'Terça'], ['Proj1', 'Proj2'], tasksData);
    // Aresta schedule Segunda<->Proj1 conta as 2 tasks não-deletadas de Segunda.
    const sched = edges.find(e =>
        e.kind === 'schedule' && e.a === 'day:Segunda' && e.b === 'project:Proj1');
    assert.ok(sched, 'aresta de agendamento Segunda<->Proj1 deve existir');
    assert.equal(sched.weight, 2);
    // Não deve haver aresta para Terça (única task de Terça está deletada).
    assert.ok(!edges.some(e => e.a === 'day:Terça' || e.b === 'day:Terça'));
});

test('buildGraphModel conecta projetos por tag compartilhada', () => {
    const { edges } = buildGraphModel([], ['Proj1', 'Proj2'], tasksData);
    const shared = edges.find(e =>
        e.kind === 'tags' &&
        ((e.a === 'project:Proj1' && e.b === 'project:Proj2') ||
         (e.a === 'project:Proj2' && e.b === 'project:Proj1')));
    assert.ok(shared, 'Proj1 e Proj2 compartilham #infra');
});
