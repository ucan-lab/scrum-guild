// 線画の定義。読み込むと body の先頭に SVG のスプライトを差し込む。
// 使い方: <svg class="art" aria-hidden="true"><use href="#a-notice"/></svg>
// 64px の格子に線だけで描く。線の太さと端の形は components.css の .art で揃える。
// 絵柄はテーマで替えない。色は currentColor で、テーマの色に従う。
(function () {
  "use strict";
  const ARTS = {
    // 空の掲示板: 一覧に何も貼られていない場面
    notice: '<path d="M8 8h48v34H8z"/><path d="M20 42v14M44 42v14"/><path d="M16 14h16v14H16z"/><path d="M24 14v.01"/><path d="M40 16h10M40 22h10M40 28h6" stroke-dasharray="1 5"/>',
    // 空の宝箱: 報酬や明細がまだ入っていない場面
    chest: '<path d="M10 32h44v20H10z"/><path d="M10 32l4-16h36l4 16"/><path d="M28 32v6h8v-6"/><path d="M32 4v5M21 7l2 4M43 7l-2 4"/>',
    // 出発の地図: 最初の一歩を踏み出す場面
    map: '<path d="M8 14l16-6 16 6 16-6v42l-16 6-16-6-16 6z"/><path d="M24 8v42M40 14v42"/><path d="M13 40c5-8 10-8 15-4s9 0 11-8" stroke-dasharray="2 4"/><path d="M45 28l6 6M51 28l-6 6"/>',
  };
  const svg = Object.entries(ARTS)
    .map(([id, body]) => `<symbol id="a-${id}" viewBox="0 0 64 64">${body}</symbol>`)
    .join("");
  const holder = document.createElement("div");
  holder.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">${svg}</svg>`;
  document.body.prepend(holder.firstChild);
  window.SQ_ARTS = Object.keys(ARTS);
})();
