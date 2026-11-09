/* Версия для macOS: колоды хранятся в файле, экспорт — через окно «Сохранить» */
(() => {
  const h = window.webkit?.messageHandlers;
  if (!h?.save) return;
  const d = window.DESKTOP_DATA;
  const body = () => JSON.stringify({ app: 'kartochki', version: 1, decks: S.decks, settings: S.settings });
  let timer;
  window.afterSave = () => { clearTimeout(timer); timer = setTimeout(() => h.save.postMessage(body()), 250); };
  window.saveFile = (filename, data) => { h.download.postMessage({ filename, data }); return Promise.resolve(); };
  addEventListener('pagehide', () => h.save.postMessage(body()));
  if (d && d.decks) {
    S.decks = d.decks;
    Object.assign(S.settings, d.settings || {});
    fixDecks(); applyTheme(); render();
  } else if (Object.keys(S.decks).length) window.afterSave();
})();
