/**
 * Quick Add: parser de linguagem natural (pt-BR) para extrair uma DATA de prazo
 * do texto digitado, devolvendo o texto limpo + a data ISO YYYY-MM-DD.
 *
 * É puro e sem dependências de DOM/rede (respeita o CSP 'self'); testável
 * isoladamente em tests/js/nlp.test.mjs.
 *
 * Reconhece (pt-BR, sem depender de acento/caixa):
 *  - relativos: hoje, amanhã, depois de amanhã
 *  - dias da semana: seg/segunda … dom/domingo (próxima ocorrência futura)
 *  - "dia N" (dia N do mês atual; próximo mês se já passou)
 *  - datas dd/mm(/aaaa)
 *  - "em N dias" / "daqui a N dias"
 *
 * O modelo de prazo é SÓ data (sem hora): tokens de hora (14h, 14:30, às 9h)
 * são reconhecidos e removidos do texto, mas não viram prazo (fica p/ lembretes).
 * Apenas a PRIMEIRA expressão de data encontrada define o prazo.
 */

import { todayISO, addDaysISO } from './util.js';

// Fronteiras "de palavra" tolerantes a acento (o \b do JS é ASCII e quebra em
// letras como ç/ã); usamos início/fim ou pontuação/espaço ao redor do token.
const BL = '(?<=^|[\\s,.;:!?/])';
const BR = '(?=$|[\\s,.;:!?/])';
// Conectivos opcionais que costumam preceder a data ("para amanhã", "no dia 5").
const PRE = '(?:(?:para|pra|pro|at[eé]|no|na|em)\\s+)?';

// Ordem importa: formas longas antes das curtas (segunda-feira antes de seg).
const WEEKDAY_ALT =
    'domingo|dom|segunda-feira|segunda|seg|ter[çc]a-feira|ter[çc]a|ter|' +
    'quarta-feira|quarta|qua|quinta-feira|quinta|qui|sexta-feira|sexta|sex|' +
    's[áa]bado|sabado|sab';

function _weekdayIndex(token) {
    const x = String(token).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (x.startsWith('dom')) return 0;
    if (x.startsWith('seg')) return 1;
    if (x.startsWith('ter')) return 2;
    if (x.startsWith('qua')) return 3;
    if (x.startsWith('qui')) return 4;
    if (x.startsWith('sex')) return 5;
    if (x.startsWith('sab')) return 6;
    return null;
}

function _dow(iso) {
    return new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)).getDay();
}

// Monta ISO validando a data real (retorna null se inválida, ex.: 31/02).
function _iso(y, m, d) {
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Tokens de hora (removidos do texto; não viram prazo no modelo atual).
const TIME_RES = [
    new RegExp(`${BL}(?:[àa]s\\s*)?\\d{1,2}(?:h(?:\\d{2})?|:\\d{2})${BR}`, 'gi'),
    new RegExp(`${BL}[àa]s\\s+\\d{1,2}${BR}`, 'gi'),
];

/**
 * @param {string} input  texto digitado pelo usuário
 * @param {string} [todayIso] data de referência (para testes); default = hoje
 * @returns {{text: string, due_date: string, matched: string}}
 */
export function parseQuickAdd(input, todayIso) {
    const today = todayIso || todayISO();
    let text = String(input || '');
    let due = '';
    let matched = '';

    const trials = [
        { re: new RegExp(`${BL}${PRE}(depois de amanh[ãa])${BR}`, 'i'), fn: () => addDaysISO(today, 2) },
        { re: new RegExp(`${BL}${PRE}(amanh[ãa])${BR}`, 'i'), fn: () => addDaysISO(today, 1) },
        { re: new RegExp(`${BL}${PRE}(hoje)${BR}`, 'i'), fn: () => today },
        {
            re: new RegExp(`${BL}(\\d{1,2})\\/(\\d{1,2})(?:\\/(\\d{2,4}))?${BR}`, 'i'),
            fn: (m) => {
                let y = m[3] ? +m[3] : +today.slice(0, 4);
                if (y < 100) y += 2000;
                return _iso(y, +m[2], +m[1]);
            },
        },
        {
            re: new RegExp(`${BL}${PRE}dia\\s+(\\d{1,2})${BR}`, 'i'),
            fn: (m) => {
                const d = +m[1];
                const y = +today.slice(0, 4);
                const mo = +today.slice(5, 7);
                let iso = _iso(y, mo, d);
                if (iso && iso < today) {           // já passou este mês -> próximo mês
                    let nm = mo + 1, ny = y;
                    if (nm > 12) { nm = 1; ny++; }
                    iso = _iso(ny, nm, d);
                }
                return iso;
            },
        },
        {
            re: new RegExp(`${BL}(?:daqui a|em)\\s+(\\d{1,3})\\s+dias?${BR}`, 'i'),
            fn: (m) => addDaysISO(today, +m[1]),
        },
        {
            re: new RegExp(`${BL}${PRE}(?:(?:pr[oó]xim[ao]|prox)\\s+)?(${WEEKDAY_ALT})(?:\\s+que\\s+vem)?${BR}`, 'i'),
            fn: (m) => {
                const target = _weekdayIndex(m[1]);
                if (target === null) return null;
                let delta = ((target - _dow(today)) % 7 + 7) % 7;
                if (delta === 0) delta = 7;          // nome de dia = próxima ocorrência futura
                return addDaysISO(today, delta);
            },
        },
    ];

    for (const t of trials) {
        const m = t.re.exec(text);
        if (!m) continue;
        const iso = t.fn(m);
        if (!iso) continue;
        due = iso;
        matched = m[0];
        text = `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}`;
        break;
    }

    for (const re of TIME_RES) text = text.replace(re, ' ');

    text = text.replace(/\s{2,}/g, ' ').trim();

    return { text, due_date: due, matched: matched.trim() };
}
