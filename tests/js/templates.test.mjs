import { test } from 'node:test';
import assert from 'node:assert/strict';

import { intResolvePath, intRenderTemplate } from '../../static/js/modules/templates.js';

test('intResolvePath acessa campos aninhados e índices', () => {
    const obj = { a: { b: [{ c: 1 }, { c: 2 }] } };
    assert.equal(intResolvePath(obj, 'a.b.1.c'), 2);
    assert.equal(intResolvePath(obj, 'a.b[0].c'), 1);
    assert.equal(intResolvePath(obj, 'a.x'), null);
    assert.equal(intResolvePath(obj, ''), obj);
});

test('intRenderTemplate substitui apenas {{campo}} (sem executar código)', () => {
    const item = { id: 7, title: 'Bug', flag: true, obj: { x: 1 } };
    assert.equal(intRenderTemplate('#{{id}} {{title}}', item), '#7 Bug');
    assert.equal(intRenderTemplate('{{flag}}', item), 'true');
    assert.equal(intRenderTemplate('{{obj}}', item), '{"x":1}');
    assert.equal(intRenderTemplate('{{missing}}', item), '');
    assert.equal(intRenderTemplate('', item), '');
});
