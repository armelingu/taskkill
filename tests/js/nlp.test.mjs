import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseQuickAdd } from '../../static/js/modules/nlp.js';

// Referência fixa: 2026-07-27 é uma SEGUNDA-feira.
const MON = '2026-07-27';

test('relativos: hoje / amanhã / depois de amanhã', () => {
    assert.deepEqual(parseQuickAdd('hoje reunião', MON),
        { text: 'reunião', due_date: '2026-07-27', matched: 'hoje' });
    assert.equal(parseQuickAdd('amanhã comprar leite', MON).due_date, '2026-07-28');
    assert.equal(parseQuickAdd('comprar leite amanhã', MON).text, 'comprar leite');
    assert.equal(parseQuickAdd('depois de amanhã X', MON).due_date, '2026-07-29');
});

test('conectivo "para" é absorvido e removido do texto', () => {
    const r = parseQuickAdd('revisar PR para amanhã', MON);
    assert.equal(r.due_date, '2026-07-28');
    assert.equal(r.text, 'revisar PR');
});

test('dias da semana resolvem para a próxima ocorrência futura', () => {
    // Sexta a partir de segunda 27/07 -> 31/07.
    const sexta = parseQuickAdd('revisar PR sexta #infra', MON);
    assert.equal(sexta.due_date, '2026-07-31');
    assert.equal(sexta.text, 'revisar PR #infra');
    // "segunda" na própria segunda -> próxima semana (03/08), nunca hoje.
    assert.equal(parseQuickAdd('planejar segunda', MON).due_date, '2026-08-03');
    // Fim de semana também é suportado.
    assert.equal(parseQuickAdd('sábado limpar casa', MON).due_date, '2026-08-01');
    assert.equal(parseQuickAdd('domingo descansar', MON).due_date, '2026-08-02');
});

test('abreviações e "próxima" funcionam', () => {
    assert.equal(parseQuickAdd('seg planejar', MON).due_date, '2026-08-03');
    assert.equal(parseQuickAdd('próxima terça call', MON).due_date, '2026-07-28');
});

test('"dia N" usa o mês atual e avança se já passou', () => {
    // Hoje é dia 27: "dia 5" já passou -> próximo mês (05/08).
    assert.equal(parseQuickAdd('dia 5 pagar conta', MON).due_date, '2026-08-05');
    assert.equal(parseQuickAdd('no dia 30 entregar', MON).due_date, '2026-07-30');
});

test('datas dd/mm(/aaaa)', () => {
    assert.equal(parseQuickAdd('reunião 30/07', MON).due_date, '2026-07-30');
    assert.equal(parseQuickAdd('reunião 30/07/2027', MON).due_date, '2027-07-30');
    // Data inválida não vira prazo (fica como texto).
    const inval = parseQuickAdd('bug 31/02', MON);
    assert.equal(inval.due_date, '');
});

test('"em N dias" / "daqui a N dias"', () => {
    assert.equal(parseQuickAdd('em 3 dias entregar', MON).due_date, '2026-07-30');
    assert.equal(parseQuickAdd('daqui a 10 dias revisar', MON).due_date, '2026-08-06');
});

test('tokens de hora são removidos, mas não viram prazo', () => {
    const r = parseQuickAdd('call às 14h amanhã', MON);
    assert.equal(r.due_date, '2026-07-28');
    assert.equal(r.text, 'call');
    // Só hora, sem data: sem prazo e hora some do texto.
    const s = parseQuickAdd('reunião 9:30', MON);
    assert.equal(s.due_date, '');
    assert.equal(s.text, 'reunião');
});

test('sem expressão de data: texto intacto, sem prazo', () => {
    assert.deepEqual(parseQuickAdd('comprar pão', MON),
        { text: 'comprar pão', due_date: '', matched: '' });
    // #tags são preservadas no texto.
    assert.equal(parseQuickAdd('amanhã deploy #api', MON).text, 'deploy #api');
});

test('não confunde palavras que contêm nomes de dia', () => {
    // "alterar" contém "ter" mas não deve casar como terça.
    const r = parseQuickAdd('alterar layout', MON);
    assert.equal(r.due_date, '');
    assert.equal(r.text, 'alterar layout');
});