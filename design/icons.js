// アイコンの定義。読み込むと body の先頭に SVG のスプライトを差し込む。
// 使い方: <svg class="ico" aria-hidden="true"><use href="#i-sun"/></svg>
// 線の太さと端の形は components.css の .ico で揃える。
(function () {
  "use strict";
  const ICONS = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    inbox: '<path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1 3h6l1-3h5"/>',
    board: '<path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    columns: '<path d="M4 4h4v16H4zM10 4h4v11h-4zM16 4h4v7h-4z"/>',
    calendar: '<path d="M4 6h16v14H4zM4 10h16M8 3v5M16 3v5"/>',
    flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
    archive: '<path d="M3 4h18v4H3zM5 8v12h14V8M10 12h4"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    git: '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 8v8M8 6h4a4 4 0 0 1 4 4"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
    alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.01"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    pen: '<path d="M4 20l4-1 11-11-3-3L5 16z"/>',
    swap: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
    moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2l1.5 2.6 3-.6.6 3L20 9l-1.4 3L20 15l-2.9 1.9-.6 3-3-.6L12 22l-1.5-2.6-3 .6-.6-3L4 15l1.4-3L4 9l2.9-1.9.6-3 3 .6z"/>',
    redo: '<path d="M20 8H9a5 5 0 0 0 0 10h3"/><path d="M16 4l4 4-4 4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
    heart: '<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M16 5a3 3 0 0 1 0 6M21 20a6 6 0 0 0-4-5.6"/>',
  };
  const svg = Object.entries(ICONS)
    .map(([id, body]) => `<symbol id="i-${id}" viewBox="0 0 24 24">${body}</symbol>`)
    .join("");
  const holder = document.createElement("div");
  holder.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">${svg}</svg>`;
  document.body.prepend(holder.firstChild);
  window.SQ_ICONS = Object.keys(ICONS);
})();
