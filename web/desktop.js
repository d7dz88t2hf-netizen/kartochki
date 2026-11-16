'use strict';
(async () => {
  const native = window.webkit?.messageHandlers?.save;
  const http = /^https?:$/.test(location.protocol);
  let token = '', etag = '';
  try {
    token = location.hash.slice(1) || sessionStorage.getItem('kartochki.token') || '';
    if (token) { sessionStorage.setItem('kartochki.token', token); history.replaceState(null, '', location.pathname); }
  } catch {}
  const request = (path, options = {}) => fetch(path, { ...options,
    headers: { 'X-Kartochki-Token': token, 'Content-Type': 'application/json', ...options.headers } });
  const pending = new Map(); let seq = 0, initialized = false, revision = 0, written = 0, running;
  let timeout;
  window.nativeResult = (id, error, cancelled = false) => {
    const task = pending.get(id); if (!task) return;
    clearTimeout(task.timer); pending.delete(id);
    error ? task.reject(Error(error)) : cancelled ? task.reject(Error('Сохранение отменено')) : task.resolve();
  };
  function message(handler, body) {
    return new Promise((resolve, reject) => {
      const id = String(++seq);
      const timer = setTimeout(() => { pending.delete(id); reject(Error('Нет ответа от приложения')); }, 30000);
      pending.set(id, { resolve, reject, timer });
      try { handler.postMessage({ id, ...body }); }
      catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
    });
  }
  function failure(e) { saveStatus('Не сохранено — повторите или сделайте копию', true); toast('Ошибка сохранения: ' + e.message); }
  async function drain() {
    while (written < revision) {
      const current = revision, data = snapshot();
      if (new TextEncoder().encode(data).length > Model.MAX_BYTES) throw Error('Коллекция превышает 32 МБ');
      if (native) await message(window.webkit.messageHandlers.save, { data });
      else {
        const response = await request('/api/data', { method: 'PUT', body: data, headers: { 'If-Match': etag } });
        if (!response.ok) throw Error(response.status === 409 ? 'Коллекция открыта в другом окне. Перезапустите приложение.' : 'Не удалось записать файл на диск');
        etag = response.headers.get('ETag') || etag;
      }
      written = current;
    }
    saveStatus('Все изменения сохранены');
  }
  window.flushSave = () => {
    clearTimeout(timeout);
    if (written === revision) return Promise.resolve();
    if (!initialized) return Promise.reject(Error('Коллекция ещё не открыта'));
    if (!running) {
      running = drain().finally(() => { running = null; });
    }
    return running;
  };
  window.afterSave = () => {
    revision++; saveStatus('Сохранение…');
    window.flushSave().catch(failure);
  };
  const cover = document.createElement('div'); cover.className = 'startup-cover'; cover.textContent = 'Открываем колоды…';
  document.body.append(cover);
  try {
    let result;
    if (native) {
      result = window.DESKTOP_BOOT;
      window.saveFile = (filename, data) => message(window.webkit.messageHandlers.download, { filename, data });
    } else if (http && token) {
      const response = await request('/api/data');
      if (!response.ok) throw Error('Не удалось открыть коллекцию');
      etag = response.headers.get('ETag') || '';
      result = await response.json();
    } else {
      initialized = true; delete window.afterSave;
      saveStatus(cacheError || 'Данные хранятся в этом браузере', !!cacheError); cover.remove(); return;
    }
    if (!result || result.error) throw Error(result?.error || 'Нет ответа от приложения');
    if (result.data) {
      const data = Model.collection(result.data);
      S.decks = data.decks; S.settings = data.settings;
    } else if (cacheError) throw Error(cacheError);
    initialized = true; applyTheme(); render(); cover.remove();
    if (result.notice) toast(result.notice);
    saveStatus(result.notice || 'Все изменения сохранены');
    if (!result.data && Object.keys(S.decks).length) window.afterSave();
    if (http && token) {
      const ping = () => request('/api/ping').catch(() => {});
      ping(); setInterval(ping, 20000);
    }
    const retry = document.createElement('button'); retry.className = 'link'; retry.textContent = 'Повторить сохранение';
    retry.onclick = () => window.flushSave().catch(failure); $('#saveStatus').after(retry);
  } catch (e) {
    cover.textContent = '';
    const box = document.createElement('section');
    const title = document.createElement('h2'); title.textContent = 'Не удалось открыть колоды';
    const detail = document.createElement('p'); detail.textContent = e.message;
    const hint = document.createElement('p'); hint.textContent = 'Файлы на диске не изменены. Сохраните kartochki.json и kartochki.json.bak, затем восстановите корректную копию и перезапустите приложение.';
    const retry = document.createElement('button'); retry.className = 'btn main'; retry.textContent = 'Открыть снова'; retry.onclick = () => location.reload();
    box.append(title, detail, hint, retry); cover.append(box); saveStatus('Коллекция не открыта', true);
  }
  addEventListener('beforeunload', e => {
    if (written < revision) { e.preventDefault(); e.returnValue = ''; }
  });
  window.closeDesktop = () => window.flushSave().then(() => request('/api/close', { method: 'POST' })).catch(failure);
  addEventListener('pagehide', () => {
    if (http && token) request('/api/bye', { method: 'POST', keepalive: true }).catch(() => {});
  });
})();
