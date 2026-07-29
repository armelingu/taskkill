import { test } from 'node:test';
import assert from 'node:assert/strict';

import { escapeHTML, normText, pfFmtDate } from '../../static/js/modules/util.js';

test('escapeHTML neutraliza caracteres perigosos', () => {
    assert.equal(
        escapeHTML('<img src=x onerror="alert(1)">'),
        '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
    );
    assert.equal(escapeHTML("a & b ' c"), 'a &amp; b &#39; c');
    assert.equal(escapeHTML(''), '');
    assert.equal(escapeHTML(null), '');
});

test('normText colapsa e apara espaços', () => {
    assert.equal(normText('  a   b\tc\n'), 'a b c');
    assert.equal(normText(null), '');
    assert.equal(normText(123), '123');
});

test('pfFmtDate trata entradas inválidas', () => {
    assert.equal(pfFmtDate(''), '—');
    assert.equal(pfFmtDate('nao-e-data'), '—');
    // Data válida: não deve retornar o placeholder.
    assert.notEqual(pfFmtDate('2026-07-27T20:14:00'), '—');
});
