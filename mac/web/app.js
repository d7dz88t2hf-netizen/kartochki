'use strict';
/* ===== утилиты ===== */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const br = s => esc(s).replace(/\n/g, '<br>');
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const MIN = 6e4, HOUR = 60 * MIN, DAY = 24 * HOUR;
const today = () => new Date().toLocaleDateString('sv');
const plural = (n, [one, few, many]) => { const a = n % 10, b = n % 100; return `${n} ${a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many}`; };
const CARDS = ['карточка', 'карточки', 'карточек'];
const FREQS = [[0.25, 'очень часто'], [0.5, 'часто'], [1, 'обычно'], [2, 'редко'], [4, 'очень редко']];
const freqName = v => (FREQS.find(f => f[0] === v) || FREQS[2])[1];
const PRESETS = [['10 минут', 10 * MIN], ['час', HOUR], ['завтра', DAY], ['3 дня', 3 * DAY], ['неделю', 7 * DAY], ['2 недели', 14 * DAY], ['месяц', 30 * DAY], ['3 месяца', 90 * DAY]];
const GRADES = [['again', 'Не помню'], ['hard', 'С трудом'], ['good', 'Помню'], ['easy', 'Легко']];
const ICONS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/>',
  undo: '<path d="M9 7L4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 0 12"/>'
};
const icon = n => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg>`;

function dur(ms) {
  const r = n => String(Math.round(n * 10) / 10).replace('.', ',');
  return ms < HOUR ? Math.max(1, Math.round(ms / MIN)) + ' мин'
    : ms < DAY ? Math.round(ms / HOUR) + ' ч'
    : ms < 30 * DAY ? Math.round(ms / DAY) + ' дн'
    : ms < 365 * DAY ? r(ms / DAY / 30) + ' мес' : r(ms / DAY / 365) + ' г';
}
const whenDue = c => c.state === 'new' ? 'новая' : c.due <= Date.now() ? 'сейчас' : 'через ' + dur(c.due - Date.now());

/* ===== состояние и хранение ===== */
const KEY = 'kartochki.v1';
const S = { decks: {}, settings: { theme: 'light', newPerDay: 20 }, view: 'home', deckId: null, search: '', study: null };
try { Object.assign(S, JSON.parse(localStorage.getItem(KEY)) || {}); } catch {}
const fixCard = c => ({ freq: 1, state: 'new', due: 0, interval: 0, ease: 2.5, reps: 0, lapses: 0, step: 0, ...c });
const fixDecks = () => Object.values(S.decks).forEach(d => (d.cards = d.cards.map(fixCard)));
fixDecks();
const save = () => {
  try { localStorage.setItem(KEY, JSON.stringify({ decks: S.decks, settings: S.settings })); } catch { if (!window.afterSave) toast('Не удалось сохранить. Сделайте экспорт колод.'); }
  window.afterSave?.(); // онлайн-версия дополнительно сохраняет в аккаунт
};
const deck = () => S.decks[S.deckId];

/* ===== интервалы (упрощённый SM-2) ===== */
function schedule(card, g, now = Date.now()) {
  const c = { ...card, reps: card.reps + 1, last: now }, f = c.freq;
  const learn = (ms, step) => Object.assign(c, { state: 'learn', step, due: now + ms });
  const review = iv => Object.assign(c, { state: 'review', step: 0, interval: iv, due: now + iv * f * DAY });
  if (c.state !== 'review') {
    if (g === 'again') learn(MIN, 0);
    else if (g === 'hard') learn(6 * MIN, c.step);
    else if (g === 'good') c.state === 'new' || c.step < 1 ? learn(10 * MIN, 1) : review(Math.max(c.interval, 1));
    else review(Math.max(c.interval * 1.5, 4));
  } else {
    const iv = Math.max(c.interval, 1);
    if (g === 'again') { c.lapses++; c.ease = Math.max(1.3, c.ease - 0.2); c.interval = Math.max(1, iv / 2); learn(10 * MIN, 1); }
    else if (g === 'hard') { c.ease = Math.max(1.3, c.ease - 0.15); review(Math.max(iv * 1.2, iv + 0.5)); }
    else if (g === 'good') review(Math.max(iv + 1, iv * c.ease));
    else { review(Math.max(iv + 2, iv * c.ease * 1.3)); c.ease += 0.15; }
  }
  return c;
}
function scheduleFixed(card, ms, now = Date.now()) {
  const c = { ...card, reps: card.reps + 1, last: now, due: now + ms };
  return ms >= DAY ? Object.assign(c, { state: 'review', step: 0, interval: ms / DAY / c.freq }) : Object.assign(c, { state: 'learn', step: 1 });
}

/* ===== колоды ===== */
const makeCard = (front, back, freq = 1) => fixCard({ id: uid('c'), front, back, freq });
function createDeck(name, cards = []) {
  const d = { id: uid('d'), name, created: Date.now(), cards, newLog: null };
  S.decks[d.id] = d; save(); return d;
}
const newLeft = d => Math.max(0, S.settings.newPerDay - (d.newLog?.date === today() ? d.newLog.count : 0));
function counts(d) {
  const now = Date.now(), k = { new: 0, learn: 0, rev: 0, learnAll: 0 };
  for (const c of d.cards) {
    if (c.state === 'new') k.new++;
    else if (c.state === 'learn') { k.learnAll++; if (c.due <= now) k.learn++; }
    else if (c.due <= now) k.rev++;
  }
  return { ...k, newAll: k.new, new: Math.min(k.new, newLeft(d)), total: d.cards.length };
}
const earliest = a => a.reduce((x, y) => (y.due < x.due ? y : x));
function nextCard(d) {
  const now = Date.now(), st = S.study, by = fn => d.cards.filter(fn);
  if (st.cram) { const p = by(c => !st.seen.has(c.id)); return p.length ? earliest(p) : null; }
  const learn = by(c => c.state === 'learn' && c.due <= now);
  if (learn.length) return earliest(learn);
  const rev = by(c => c.state === 'review' && c.due <= now);
  const news = newLeft(d) ? by(c => c.state === 'new') : [];
  if (news.length && (!rev.length || st.count % 3 === 2)) return news[0];
  if (rev.length) return earliest(rev);
  const soon = by(c => c.state === 'learn' && c.due <= now + 20 * MIN);
  return soon.length ? earliest(soon) : null;
}

/* ===== общие элементы ===== */
function toast(msg) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg, role: 'status' });
  document.body.append(t); setTimeout(() => t.remove(), 2600);
}
function modal(html, mount) {
  $('#modal').innerHTML = `<div class="overlay" data-act="overlay"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  $('#modal [autofocus]')?.focus();
  mount?.($('#modal .modal'));
}
const close = () => ($('#modal').innerHTML = '');
const isModal = () => !!$('#modal').innerHTML;
const cancelBtn = '<button class="btn plain" data-act="close">Отмена</button>';
function ask(title, text, ok, fn) {
  modal(`<h3>${esc(title)}</h3><p class="soft">${esc(text)}</p><div class="actions">${cancelBtn}<button class="btn main" id="ok" autofocus>${ok}</button></div>`,
    m => ($('#ok', m).onclick = () => { close(); fn(); }));
}
function nameBox(title, value, okText, fn) {
  modal(`<h3>${title}</h3><label class="f" for="nm">Название</label><input type="text" id="nm" value="${esc(value)}" placeholder="Например, английский для работы" autofocus>
    <div class="actions">${cancelBtn}<button class="btn main" id="ok">${okText}</button></div>`, m => {
    const go = () => { const v = $('#nm', m).value.trim(); if (v) { close(); fn(v); } else $('#nm', m).focus(); };
    $('#ok', m).onclick = go; $('#nm', m).addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  });
}
const applyTheme = () => {
  const dark = S.settings.theme === 'dark';
  document.documentElement.dataset.theme = S.settings.theme;
  $('#themeBtn').innerHTML = icon(dark ? 'sun' : 'moon');
  $('#themeBtn').title = dark ? 'Светлая тема' : 'Тёмная тема';
};
const go = (view, id) => { S.view = view; if (id) S.deckId = id; render(); scrollTo(0, 0); };
const backBtn = (act, text) => `<button class="back" data-act="${act}">${icon('back')}${esc(text)}</button>`;

/* ===== экраны ===== */
function render() {
  $('#app').innerHTML = S.view === 'home' || !deck() ? viewHome() : S.view === 'deck' ? viewDeck(deck()) : viewStudy(deck());
  if (S.keepFocus) { const s = $('#search'); s.focus(); s.selectionStart = s.value.length; S.keepFocus = false; }
}
function todayLine(c) {
  const parts = [];
  if (c.new) parts.push(`<span class="n-new">${plural(c.new, ['новая', 'новые', 'новых'])}</span>`);
  if (c.learn) parts.push(`<span class="n-learn">${c.learn} в изучении</span>`);
  if (c.rev) parts.push(`<span class="n-rev">${c.rev} на повторение</span>`);
  return parts.length ? 'Сегодня: ' + parts.join(', ') : `На сегодня всё, в колоде ${plural(c.total, CARDS)}`;
}

function viewHome() {
  const list = Object.values(S.decks).sort((a, b) => a.created - b.created);
  if (!list.length) return `<section class="intro">
    <h2>Начните с первой колоды</h2>
    <p>Колода — набор карточек на одну тему: слова, термины, правила, номера деталей. На лицевой стороне вопрос, на обороте ответ. После каждого ответа вы решаете, когда увидеть карточку снова.</p>
    <div class="row"><button class="btn main" data-act="new-deck">Создать колоду</button><button class="btn" data-act="import">Загрузить файл</button><button class="btn plain" data-act="sample">Посмотреть на примере</button></div></section>`;
  return `<div class="heading"><h2>Колоды</h2><span class="push"></span><button class="btn plain" data-act="import">Загрузить файл</button><button class="btn main" data-act="new-deck">Новая колода</button></div>
    <ul class="decks">${list.map(d => {
      const c = counts(d), todo = c.new + c.learn + c.rev;
      return `<li class="deck" data-act="open" data-id="${d.id}"><div><h3>${esc(d.name)}</h3><p>${todayLine(c)}</p></div>
        ${todo ? `<button class="btn main" data-act="study" data-id="${d.id}">Учить</button>` : ''}</li>`;
    }).join('')}</ul>`;
}

function viewDeck(d) {
  const c = counts(d), q = S.search.trim().toLowerCase();
  const found = q ? d.cards.filter(x => (x.front + ' ' + x.back).toLowerCase().includes(q)) : d.cards;
  const rows = found.slice(0, 300).map(x => `<li>
      <span class="clip" title="${esc(x.front)}">${esc(x.front)}</span><span class="clip soft hm" title="${esc(x.back)}">${esc(x.back)}</span>
      <span class="when hm">${freqName(x.freq)}</span>
      <span class="acts"><button class="btn icon" data-act="edit" data-id="${x.id}" title="Изменить">${icon('pen')}</button><button class="btn icon" data-act="del-card" data-id="${x.id}" title="Удалить">${icon('trash')}</button></span></li>`).join('');
  const todo = c.new + c.learn + c.rev;
  return `${backBtn('home', 'Все колоды')}
    <div class="heading"><h2>${esc(d.name)}</h2><button class="btn icon" data-act="rename" title="Переименовать">${icon('pen')}</button><span class="push"></span>${todo ? `<button class="btn main" data-act="study" data-id="${d.id}">Учить</button>` : d.cards.length ? '<button class="btn" data-act="cram">Повторить всё</button>' : ''}</div>
    <p class="summary">${d.cards.length ? `${plural(c.total, CARDS)}. Новых ${c.newAll}, в изучении ${c.learnAll}, ждут повторения ${c.rev + c.learn}.` : 'Пока пусто. Добавьте карточки вручную или загрузите файл.'}</p>
    <div class="tools"><button class="btn" data-act="add">Добавить карточку</button><button class="btn" data-act="import" data-id="${d.id}">Загрузить файл</button>
      ${d.cards.length ? '<button class="btn plain" data-act="export">Экспорт</button>' : ''}<button class="btn plain warn" data-act="del-deck">Удалить колоду</button></div>
    ${d.cards.length ? `<input type="search" id="search" placeholder="Найти карточку" value="${esc(S.search)}" aria-label="Поиск по карточкам">
      <ul class="cards">${rows || '<li class="note">Ничего не нашлось</li>'}
      ${found.length > 300 ? `<li class="note">Показаны 300 из ${found.length}. Уточните поиск.</li>` : ''}</ul>` : ''}`;
}

function viewStudy(d) {
  const st = S.study, card = d.cards.find(c => c.id === st.cardId), c = counts(d);
  const top = `<div class="study-top">${backBtn('end', d.name)}
    ${st.cram ? '<span class="soft" style="font-size:14px">Повторение всей колоды</span>' : `<span class="left"><span class="n-new" title="Новые">${c.new}</span><span class="n-learn" title="В изучении">${c.learn}</span><span class="n-rev" title="На повторение">${c.rev}</span></span>`}
    ${st.undo ? `<button class="btn plain" data-act="undo" title="Ctrl+Z">${icon('undo')}Отменить</button>` : ''}</div>`;
  if (!card) {
    const next = d.cards.filter(x => x.state !== 'new').map(x => x.due);
    const wait = next.length ? Math.min(...next) - Date.now() : 0;
    return top + `<section class="done"><h2>${st.count ? 'На сегодня всё' : 'Сейчас повторять нечего'}</h2>
      <p>${st.count ? `Пройдено: ${plural(st.count, CARDS)}. ` : ''}${wait > 0 ? 'Следующая появится через ' + dur(wait) + '.' : ''}</p>
      <div class="row"><button class="btn" data-act="end">К колоде</button>${d.cards.length ? '<button class="btn main" data-act="cram">Повторить всё ещё раз</button>' : ''}</div></section>`;
  }
  return top + `<div class="flashcard ${st.flipped ? 'open' : ''}">
      <button class="btn icon edit" data-act="edit" data-id="${card.id}" title="Изменить карточку">${icon('pen')}</button>
      <div class="q">${br(card.front)}</div>
      ${st.flipped ? `<div class="a">${br(card.back) || '<span class="soft">Ответ не заполнен</span>'}</div>` : ''}
    </div>
    <div id="answer">${answerBar(card)}</div>`;
}
function answerBar(card) {
  const st = S.study, now = Date.now();
  if (!st.flipped) return '<button class="btn main show" data-act="flip">Показать ответ</button><p class="keys"><kbd>Пробел</kbd> перевернуть</p>';
  return `<div class="grades">${GRADES.map(([g, l]) => `<button class="grade g-${g}" data-act="grade" data-g="${g}"><b>${l}</b><span>${dur(schedule(card, g, now).due - now)}</span></button>`).join('')}</div>
    <p class="keys"><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd> оценка, <kbd>Ctrl</kbd>+<kbd>Z</kbd> отменить</p>
    <div class="freq"><span>Эту карточку показывать</span>${FREQS.map(([v, l]) => `<button class="opt ${card.freq === v ? 'on' : ''}" data-act="freq" data-v="${v}">${l}</button>`).join('')}</div>
    <div class="freq"><button class="link" data-act="custom">${st.custom ? 'Скрыть выбор срока' : 'Выбрать срок вручную'}</button></div>
    ${st.custom ? `<div class="custom"><div class="presets">${PRESETS.map(([l, ms]) => `<button class="btn" data-act="fixed" data-ms="${ms}">${l}</button>`).join('')}</div>
      <div class="own"><span class="soft" style="font-size:14px">или через</span><input type="number" id="cNum" min="1" value="2" aria-label="Сколько">
      <select id="cUnit" aria-label="Единица">${[[MIN, 'минут'], [HOUR, 'часов'], [DAY, 'дней'], [7 * DAY, 'недель'], [30 * DAY, 'месяцев']].map(([v, l]) => `<option value="${v}" ${v === DAY ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button class="btn main" data-act="fixed">Готово</button></div></div>` : ''}`;
}

/* ===== изучение ===== */
function startStudy(id, cram = false) {
  S.study = { count: 0, cram, seen: new Set(), undo: null }; S.deckId = id; S.view = 'study'; pick(); render(); scrollTo(0, 0);
}
function pick() { const c = nextCard(deck()); Object.assign(S.study, { cardId: c?.id, flipped: false, custom: false }); }
function flip() { S.study.flipped = true; render(); }
const refreshBar = () => ($('#answer').innerHTML = answerBar(deck().cards.find(c => c.id === S.study.cardId)));
function answer(fn) {
  const d = deck(), st = S.study, i = d.cards.findIndex(c => c.id === st.cardId), prev = d.cards[i];
  st.undo = { card: prev, newLog: d.newLog, count: st.count };
  if (prev.state === 'new' && !st.cram) d.newLog = { date: today(), count: (d.newLog?.date === today() ? d.newLog.count : 0) + 1 };
  d.cards[i] = fn(prev); st.seen.add(prev.id); st.count++;
  save(); pick(); render();
}
function undo() {
  const d = deck(), st = S.study, u = st?.undo; if (!u) return;
  d.cards[d.cards.findIndex(c => c.id === u.card.id)] = u.card;
  Object.assign(st, { count: u.count, cardId: u.card.id, flipped: true, undo: null }); d.newLog = u.newLog;
  st.seen.delete(u.card.id); save(); render();
}

/* ===== окна ===== */
function cardBox(id) {
  const d = deck(), c = d.cards.find(x => x.id === id);
  modal(`<h3>${c ? 'Изменить карточку' : 'Новая карточка'}</h3>
    <label class="f" for="fr">Вопрос</label><textarea id="fr" autofocus>${esc(c?.front)}</textarea>
    <label class="f" for="bk">Ответ</label><textarea id="bk">${esc(c?.back)}</textarea>
    <label class="f" for="fq">Как часто показывать</label><select id="fq">${FREQS.map(([v, l]) => `<option value="${v}" ${v === (c?.freq ?? 1) ? 'selected' : ''}>${l[0].toUpperCase() + l.slice(1)}</option>`).join('')}</select>
    ${c ? '<p style="margin-top:14px"><button class="link" id="reset">Начать учить заново</button></p>' : ''}
    <div class="actions">${cancelBtn}${c ? '' : '<button class="btn" id="more">Сохранить и добавить ещё</button>'}
    <button class="btn main" id="ok">${c ? 'Сохранить' : 'Добавить'}</button></div>`, m => {
    const ok = more => {
      const front = $('#fr', m).value.trim(), back = $('#bk', m).value.trim(), freq = +$('#fq', m).value;
      if (!front) { $('#fr', m).focus(); return toast('Напишите вопрос'); }
      c ? Object.assign(c, { front, back, freq }) : d.cards.push(makeCard(front, back, freq));
      save(); render();
      if (more) { $('#fr', m).value = $('#bk', m).value = ''; $('#fr', m).focus(); toast('Карточка добавлена'); } else close();
    };
    $('#ok', m).onclick = () => ok(false);
    $('#more', m) && ($('#more', m).onclick = () => ok(true));
    $('#reset', m) && ($('#reset', m).onclick = () => { Object.assign(c, makeCard(c.front, c.back, c.freq), { id: c.id }); save(); close(); render(); toast('Карточка снова новая'); });
    m.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ok(!c); });
  });
}
function settingsBox() {
  modal(`<h3>Настройки</h3><label class="f" for="np">Сколько новых карточек давать в день (на колоду)</label>
    <input type="number" id="np" min="0" value="${S.settings.newPerDay}">
    <p class="soft" style="margin-top:18px;font-size:14px">Частота карточки растягивает или сжимает её интервалы: «часто» — вдвое короче, «редко» — вдвое длиннее.</p>
    <p class="soft" style="font-size:14px">Чтобы не потерять колоды или перенести их на другое устройство, делайте экспорт.</p>
    <div class="actions"><button class="btn main" id="ok">Сохранить</button></div>`, m => ($('#ok', m).onclick = () => {
    S.settings.newPerDay = Math.max(0, parseInt($('#np', m).value) || 0); save(); close(); render(); toast('Настройки сохранены');
  }));
}

/* ===== импорт ===== */
const unhtml = s => s.replace(/<br\s*\/?>|<\/(div|p|li)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
  .replace(/&(lt|gt|quot|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', amp: '&' })[e]).trim();
function split(line, sep) {
  if (sep.length > 1) { const i = line.indexOf(sep); return i < 0 ? [line] : [line.slice(0, i), line.slice(i + sep.length)]; }
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) ch !== '"' ? (cur += ch) : line[i + 1] === '"' ? (cur += '"', i++) : (q = false);
    else if (ch === '"' && !cur.trim()) { q = true; cur = ''; }
    else if (ch === sep) { out.push(cur); cur = ''; } else cur += ch;
  }
  return [...out, cur];
}
const SEPS = { '\t': 'табуляция', ';': 'точка с запятой', '|': 'вертикальная черта', ' — ': 'тире', ' - ': 'дефис', ': ': 'двоеточие', ',': 'запятая' };
function parse(text, sep, skipHead) {
  text = text.replace(/^﻿/, '').trim();
  if (/^[[{]/.test(text)) try {
    const o = JSON.parse(text);
    if (Array.isArray(o.decks)) return { decks: o.decks.filter(d => Array.isArray(d.cards)) };
    const a = Array.isArray(o) ? o : o.cards || [];
    return { cards: a.map(x => Array.isArray(x) ? { front: x[0], back: x[1] } : { front: x.front ?? x.question, back: x.back ?? x.answer })
      .map(x => ({ front: String(x.front ?? '').trim(), back: String(x.back ?? '').trim() })).filter(x => x.front) };
  } catch {}
  let lines = text.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
  if (skipHead) lines = lines.slice(1);
  if (sep === 'auto') sep = Object.keys(SEPS).find(s => lines.slice(0, 30).filter(l => l.includes(s)).length >= Math.ceil(Math.min(30, lines.length) * 0.6)) || '\t';
  const cards = lines.map(l => split(l, sep).map(x => unhtml(x.replace(/\\n/g, '\n'))))
    .map(([f, ...b]) => ({ front: (f || '').trim(), back: b.map(x => x.trim()).filter(Boolean).join('\n') })).filter(c => c.front);
  return { cards, sep };
}
function importBox(targetId) {
  let text = '', parsed;
  modal(`<h3>Загрузить карточки</h3>
    <p class="soft" style="font-size:14px">Подойдёт текстовый файл, где на каждой строке вопрос и ответ через разделитель. Например, таблица из Excel, сохранённая как CSV, или экспорт из Anki в виде простого текста.</p>
    <div class="drop" id="drop" style="margin-top:14px"><b>Выбрать файл</b> или перетащить его сюда</div>
    <label class="f" for="tx">Или вставьте текст</label><textarea id="tx" placeholder="apple;яблоко&#10;dog;собака"></textarea>
    <div class="two"><div><label class="f" for="sp">Разделитель</label><select id="sp"><option value="auto">Определить самому</option>
      ${Object.entries(SEPS).map(([k, v]) => `<option value="${esc(k)}">${v[0].toUpperCase() + v.slice(1)}</option>`).join('')}</select></div>
      <div><label class="f" for="tg">Куда добавить</label><select id="tg"><option value="">В новую колоду</option>
      ${Object.values(S.decks).map(d => `<option value="${d.id}" ${d.id === targetId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></div></div>
    <div id="nmw"><label class="f" for="nm">Название новой колоды</label><input type="text" id="nm" value="Моя колода"></div>
    <div class="checks"><label><input type="checkbox" id="hd"> В первой строке заголовки</label><label><input type="checkbox" id="sw"> Поменять вопрос и ответ местами</label></div>
    <div id="pv"></div><div class="actions">${cancelBtn}<button class="btn main" id="ok" disabled>Загрузить</button></div>`, m => {
    const el = s => $(s, m);
    const update = () => {
      const src = el('#tx').value || text;
      parsed = parse(src, el('#sp').value, el('#hd').checked);
      el('#nmw').hidden = !!el('#tg').value || !!parsed.decks;
      if (parsed.decks) {
        const n = parsed.decks.reduce((s, d) => s + d.cards.length, 0);
        el('#pv').innerHTML = `<p style="margin-top:14px">Это резервная копия: ${plural(parsed.decks.length, ['колода', 'колоды', 'колод'])}, ${plural(n, CARDS)}. Прогресс сохранится.</p>`;
        return (el('#ok').disabled = !n);
      }
      if (el('#sw').checked) parsed.cards = parsed.cards.map(c => ({ front: c.back, back: c.front })).filter(c => c.front);
      const cs = parsed.cards;
      el('#ok').disabled = !cs.length;
      el('#ok').textContent = cs.length ? `Загрузить ${plural(cs.length, CARDS)}` : 'Загрузить';
      el('#pv').innerHTML = cs.length ? `<p style="margin-top:14px;font-size:14px" class="soft">Разделитель: ${SEPS[parsed.sep] || 'нет'}. Первые строки:</p>
        <div class="preview">${cs.slice(0, 5).map(c => `<div><span class="clip">${esc(c.front)}</span><span class="clip soft">${esc(c.back)}</span></div>`).join('')}</div>`
        : src.trim() ? '<p class="soft" style="margin-top:14px;font-size:14px">Карточки не распознались. Выберите разделитель вручную.</p>' : '';
    };
    const read = f => {
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        text = String(r.result); el('#tx').value = text.length < 2e5 ? text : '';
        el('#drop').innerHTML = `<b>${esc(f.name)}</b>, выбрать другой`; el('#nm').value = f.name.replace(/\.[^.]+$/, ''); update();
      };
      r.readAsText(f);
    };
    const fi = $('#fileIn'), drop = el('#drop');
    drop.onclick = () => { fi.value = ''; fi.click(); };
    fi.onchange = () => read(fi.files[0]);
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); read(e.dataTransfer.files[0]); };
    el('#tx').oninput = () => { text = ''; update(); };
    ['#sp', '#tg', '#hd', '#sw'].forEach(s => (el(s).onchange = update));
    el('#ok').onclick = () => {
      close();
      if (parsed.decks) {
        parsed.decks.forEach(src => createDeck(String(src.name || 'Импорт'), src.cards.filter(c => c?.front)
          .map(c => ({ ...makeCard(String(c.front), String(c.back ?? '')), ...c, id: uid('c'), freq: FREQS.some(f => f[0] === c.freq) ? c.freq : 1 }))));
        toast('Загружено: ' + plural(parsed.decks.length, ['колода', 'колоды', 'колод'])); return go('home');
      }
      const d = S.decks[el('#tg').value] || createDeck(el('#nm').value.trim() || 'Моя колода');
      const have = new Set(d.cards.map(c => c.front + '\u0001' + c.back));
      const add = parsed.cards.filter(c => !have.has(c.front + '\u0001' + c.back) && have.add(c.front + '\u0001' + c.back));
      const skipped = parsed.cards.length - add.length;
      d.cards.push(...add.map(c => makeCard(c.front, c.back))); save();
      toast(`Загружено: ${plural(add.length, CARDS)}${skipped ? `. Повторы пропущены: ${skipped}` : ''}`);
      S.search = ''; go('deck', d.id);
    };
    update();
  });
}

/* ===== экспорт ===== */
function exportBox() {
  const d = deck(), name = d.name.replace(/[\\/:*?"<>|]+/g, '_') || 'deck';
  const download = (data, ext) => {
    if (window.saveFile) return window.saveFile(name + ext, data).then(() => close(), () => toast('Скачивание отменено'));
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([data], { type: 'text/plain;charset=utf-8' })), download: name + ext });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); close(); toast('Файл сохранён в «Загрузки»');
  };
  modal(`<h3>Экспорт колоды</h3>
    <p class="soft" style="font-size:14px">Резервная копия хранит всё, включая прогресс и частоту карточек. Её можно загрузить обратно здесь же.</p>
    <p class="soft" style="font-size:14px">Текстовый файл содержит только вопросы и ответы. Он откроется в Excel и Anki.</p>
    <div class="actions">${cancelBtn}<button class="btn" id="txt">Текстовый файл</button><button class="btn main" id="json">Резервная копия</button></div>`, m => {
    $('#json', m).onclick = () => download(JSON.stringify({ app: 'kartochki', version: 1, decks: [{ name: d.name, cards: d.cards.map(({ id, ...c }) => c) }] }), '.json');
    $('#txt', m).onclick = () => download(d.cards.map(c => [c.front, c.back].map(x => x.replace(/\t/g, ' ').replace(/\n/g, '<br>')).join('\t')).join('\n'), '.txt');
  });
}

/* ===== события ===== */
const ACTIONS = {
  home: () => go('home'),
  theme: () => { S.settings.theme = S.settings.theme === 'dark' ? 'light' : 'dark'; applyTheme(); save(); },
  settings: settingsBox, close,
  'new-deck': () => nameBox('Новая колода', '', 'Создать', v => { S.search = ''; go('deck', createDeck(v).id); }),
  sample: () => go('deck', createDeck('Пример', [['Hello', 'Привет'], ['Thank you', 'Спасибо'], ['Столица Австралии', 'Канберра'], ['Химический символ золота', 'Au'], ['Год полёта Гагарина', '1961']].map(([f, b]) => makeCard(f, b))).id),
  open: el => { S.search = ''; go('deck', el.dataset.id); },
  study: el => startStudy(el.dataset.id),
  cram: () => startStudy(S.deckId, true),
  end: () => go('deck'),
  rename: () => nameBox('Переименовать колоду', deck().name, 'Сохранить', v => { deck().name = v; save(); render(); }),
  'del-deck': () => ask('Удалить колоду?', `Колода «${deck().name}» и ${plural(deck().cards.length, CARDS)} будут удалены навсегда.`, 'Удалить', () => { delete S.decks[S.deckId]; save(); go('home'); toast('Колода удалена'); }),
  add: () => cardBox(),
  edit: el => cardBox(el.dataset.id),
  'del-card': el => ask('Удалить карточку?', deck().cards.find(x => x.id === el.dataset.id).front.slice(0, 140), 'Удалить', () => { deck().cards = deck().cards.filter(x => x.id !== el.dataset.id); save(); render(); toast('Карточка удалена'); }),
  import: el => importBox(el.dataset.id),
  export: exportBox,
  flip,
  grade: el => answer(c => schedule(c, el.dataset.g)),
  fixed: el => {
    const ms = el.dataset.ms ? +el.dataset.ms : parseFloat($('#cNum').value) * +$('#cUnit').value;
    ms > 0 ? answer(c => scheduleFixed(c, ms)) : toast('Укажите число больше нуля');
  },
  custom: () => { S.study.custom = !S.study.custom; refreshBar(); },
  freq: el => { const c = deck().cards.find(x => x.id === S.study.cardId); c.freq = +el.dataset.v; save(); refreshBar(); toast('Теперь показывать ' + freqName(c.freq)); },
  undo
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  if (el.dataset.act === 'overlay') return e.target === el && close();
  e.stopPropagation(); ACTIONS[el.dataset.act]?.(el);
});
document.addEventListener('input', e => { if (e.target.id === 'search') { S.search = e.target.value; S.keepFocus = true; render(); } });
document.addEventListener('keydown', e => {
  if (isModal()) return e.key === 'Escape' && close();
  if (S.view !== 'study' || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') return e.preventDefault(), undo();
  if (!S.study.cardId) return;
  const g = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' }[e.key];
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); S.study.flipped ? answer(c => schedule(c, 'good')) : flip(); }
  else if (g && S.study.flipped) answer(c => schedule(c, g));
});
setInterval(() => { // карточки в изучении «созревают» — обновляем счётчики
  if (isModal() || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
  if (S.view === 'study') { if (!S.study.cardId) { pick(); render(); } return; }
  render();
}, 60000);

if (!localStorage.getItem(KEY) && matchMedia('(prefers-color-scheme: dark)').matches) S.settings.theme = 'dark';
applyTheme(); render();
