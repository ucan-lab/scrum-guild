// 描く前に、覚えているテーマを html の data-theme に当てる（src/app.html の head で同期して読む）。
// インラインにすると CSP のハッシュから漏れて止まるので、自分のオリジンのファイルにしてある。
// 値とキーは src/shared/theme.ts と同じにする（scripts/theme.test.ts が突き合わせる）。
// localStorage が使えない、値が壊れているときは何もせず、属性なし（シンプル（自動））で描く。
(function () {
  try {
    var theme = localStorage.getItem('sg-theme');
    if (['simple', 'simple_light', 'simple_dark', 'medieval', 'modern'].indexOf(theme) !== -1) {
      document.documentElement.dataset.theme = theme;
    }
  } catch {
    // 覚えていないものとして扱う
  }
})();
