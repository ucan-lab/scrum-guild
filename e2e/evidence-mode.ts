// CI の evidence が比べる画像を撮るか（docs/development.md の「e2e の書き方」）。
// CI の e2e が E2E_EVIDENCE=1 を付ける。撮る前に通信と描画を待ち、描画を1本のスレッドで行うので e2e が延びる。
// 手元では付けずに、元の速さで走らせる。playwright.config.ts と e2e/fixtures.ts が読む
export const EVIDENCE = process.env.E2E_EVIDENCE === '1';
