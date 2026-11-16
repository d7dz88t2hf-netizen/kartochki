'use strict';
// The disk format, imports and browser cache share one validation boundary.
const Model = (() => {
  const MAX_BYTES = 32 * 1024 * 1024, MAX_CARDS = 100000;
  const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  const id = p => p + Array.from(crypto.getRandomValues(new Uint32Array(3)), n => n.toString(36)).join('');
  const number = (v, fallback, min = 0, max = 1e12) => {
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw Error('Некорректное число в карточке или настройках');
    return v;
  };
  const text = (s, fallback = '') => {
    if (s === undefined || s === null) return fallback;
    if (typeof s !== 'string' || s.length > 200000) throw Error('Некорректный или слишком длинный текст');
    return s;
  };
  function card(c, freshId = false) {
    if (!object(c)) throw Error('Карточка должна быть объектом');
    const front = text(c.front).trim();
    if (!front) throw Error('В карточке отсутствует вопрос');
    const state = c.state ?? 'new';
    if (!['new', 'learn', 'review'].includes(state)) throw Error('Неизвестное состояние карточки');
    const freq = c.freq ?? 1;
    if (![0.25, 0.5, 1, 2, 4].includes(freq)) throw Error('Некорректная частота карточки');
    return { id: !freshId && /^[a-zA-Z0-9_-]{1,100}$/.test(c.id) ? c.id : id('c'), front,
      back: text(c.back), state, freq, due: number(c.due, 0, 0, 8640000000000000),
      interval: number(c.interval, 0), ease: number(c.ease, 2.5, 1.3, 1000),
      reps: number(c.reps, 0), lapses: number(c.lapses, 0), step: number(c.step, 0),
      ...(c.last === undefined ? {} : { last: number(c.last, 0, 0, 8640000000000000) }) };
  }
  function collection(value, freshIds = false) {
    if (!object(value)) throw Error('Резервная копия должна быть объектом');
    if (value.app !== undefined && value.app !== 'kartochki') throw Error('Это файл другого приложения');
    if (value.version !== undefined && value.version !== 1) throw Error('Эта версия резервной копии не поддерживается');
    if (!object(value.decks) && !Array.isArray(value.decks)) throw Error('В файле отсутствуют колоды');
    const decks = Object.create(null); let total = 0;
    for (const src of Object.values(value.decks)) {
      if (!object(src) || !Array.isArray(src.cards)) throw Error('Некорректная структура колоды');
      total += src.cards.length;
      if (total > MAX_CARDS) throw Error('Лимит — 100 000 карточек в коллекции');
      const deckId = !freshIds && /^[a-zA-Z0-9_-]{1,100}$/.test(src.id) ? src.id : id('d');
      if (decks[deckId]) throw Error('Повторяющийся идентификатор колоды');
      const cards = src.cards.map(c => card(c, freshIds));
      if (new Set(cards.map(c => c.id)).size !== cards.length) throw Error('Повторяющийся идентификатор карточки');
      let newLog = null;
      if (src.newLog != null) {
        if (!object(src.newLog) || !/^\d{4}-\d{2}-\d{2}$/.test(src.newLog.date)) throw Error('Некорректный журнал новых карточек');
        newLog = { date: src.newLog.date, count: number(src.newLog.count, 0) };
      }
      decks[deckId] = { id: deckId, name: text(src.name, 'Импорт').trim() || 'Импорт',
        created: number(src.created, Date.now(), 0, 8640000000000000), cards, newLog };
    }
    const s = value.settings ?? {};
    if (!object(s)) throw Error('Некорректные настройки');
    if (s.theme !== undefined && !['light', 'dark'].includes(s.theme)) throw Error('Некорректная тема');
    const newPerDay = number(s.newPerDay, 20, 0, 100000);
    if (!Number.isInteger(newPerDay)) throw Error('Дневной лимит должен быть целым числом');
    return { app: 'kartochki', version: 1, decks, settings: { theme: s.theme ?? 'light', newPerDay } };
  }
  function decode(raw) {
    if (new TextEncoder().encode(raw).length > MAX_BYTES) throw Error('Размер файла превышает 32 МБ');
    return collection(JSON.parse(raw));
  }
  // CSV records may contain quoted delimiters, newlines and doubled quotes.
  function records(raw, sep) {
    if (sep.length > 1) return raw.split(/\r?\n/).filter(x => x.trim() && !x.startsWith('#')).map(line => {
      const i = line.indexOf(sep); return i < 0 ? [line] : [line.slice(0, i), line.slice(i + sep.length)];
    });
    const rows = []; let row = [], cell = '', quoted = false;
    const push = () => { row.push(cell); if (row.some(x => x.trim()) && !row[0].startsWith('#')) rows.push(row); row = []; cell = ''; };
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (quoted) {
        if (ch === '"' && raw[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"' && cell === '') quoted = true;
      else if (ch === sep) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && raw[i + 1] === '\n') i++; push(); }
      else cell += ch;
    }
    if (quoted) throw Error('В CSV не закрыты кавычки');
    if (cell || row.length) push();
    return rows;
  }
  return { MAX_BYTES, MAX_CARDS, id, card, collection, decode, records };
})();
if (typeof module !== 'undefined') module.exports = Model;
