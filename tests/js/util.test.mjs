import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    escapeHTML, normText, pfFmtDate,
    startOfWeekISO, addDaysISO, formatBR, weekdayShort, weekdayLong,
} from '../../static/js/modules/util.js';

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

test('startOfWeekISO devolve a segunda-feira da semana', () => {
    // 2026-07-29 é uma quarta-feira -> segunda = 2026-07-27.
    assert.equal(startOfWeekISO('2026-07-29'), '2026-07-27');
    // Uma segunda mantém-se igual; um domingo recua até a segunda anterior.
    assert.equal(startOfWeekISO('2026-07-27'), '2026-07-27');
    assert.equal(startOfWeekISO('2026-08-02'), '2026-07-27'); // domingo
});

test('addDaysISO soma dias respeitando virada de mês', () => {
    assert.equal(addDaysISO('2026-07-27', 6), '2026-08-02');
    assert.equal(addDaysISO('2026-07-31', 1), '2026-08-01');
    assert.equal(addDaysISO('2026-07-27', 0), '2026-07-27');
});

test('formatBR formata dd/mm e ignora inválidos', () => {
    assert.equal(formatBR('2026-08-03'), '03/08');
    assert.equal(formatBR(''), '');
    assert.equal(formatBR('Segunda'), '');
});

test('weekdayShort/weekdayLong identificam o dia', () => {
    assert.equal(weekdayShort('2026-07-27'), 'Seg'); // segunda
    assert.equal(weekdayLong('2026-07-27'), 'Segunda');
    assert.equal(weekdayShort('2026-08-02'), 'Dom'); // domingo
    assert.equal(weekdayLong('2026-08-01'), 'Sábado');
});
