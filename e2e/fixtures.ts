import { test as base, type BrowserContext, type Page, type Request, type TestInfo } from '@playwright/test';

export { expect } from '@playwright/test';

// 画面のスクリーンショット（evidence-<n>.png）。CI の evidence が main の画像と中身のハッシュで比べ、違う画面だけを PR に並べる
// （docs/development.md の「e2e の画像のコメント」）。同じ画面なら撮り直しても同じ画像になるよう、次をそろえる。
// - 撮るたびに変わる文字を透明にする。場所と大きさは残るので、並びの変化は写り、toBeVisible と toHaveText も変わらない
//   - <time>: サーバーが付ける時刻（コメント、変更の履歴、組織の履歴）。テストの中で作った行は実行の時刻になる
//   - 組織の画面の API の節の状態: 版（APP_VERSION）を出し、PR の head と main のコミットで必ず違う
//   - 入力欄のカーソル: 点滅する
// - テストの終わりに、通信が止まるのを待ち、アニメーションとトランジションを終わりまで進めてから撮る。
//   Playwright のテストの終わりのスクリーンショット（screenshot: 'on'）は、読み込みやトーストの出入りの途中を撮ることがあり、
//   同じコミットで撮り直すと3割ほどの画面が違った（#337）
export const STEADY_SCREENSHOT_CSS = [
  'time, section[aria-labelledby="s-api"] p[role="status"] { color: transparent !important; text-shadow: none !important; }',
  '* { caret-color: transparent !important; }',
].join('\n');

// 通信が止まったとみなすまでの間と、待つ上限（わざと返さない要求を置いたテストでは上限まで待つ）
const QUIET_MS = 300;
const QUIET_TIMEOUT_MS = 2_000;
const SCREENSHOT_TIMEOUT_MS = 5_000;
// 1枚を撮る時間の最長（通信を待つ上限、書体と描画を待つ分、撮る上限）
const CAPTURE_BUDGET_MS = QUIET_TIMEOUT_MS + 1_000 + SCREENSHOT_TIMEOUT_MS;

const pending = new WeakMap<BrowserContext, Set<Request>>();
const captured = new WeakSet<Page>();
const counters = new WeakMap<TestInfo, number>();
// テストごとの、撮る context（作った順）。ほかのテストで開いたまま残った context は撮らない
const contextsOf = new WeakMap<TestInfo, BrowserContext[]>();

// 画面の CSP は style 要素と style 属性をハッシュで絞るので、構築可能なスタイルシート（CSP の対象外）で当てる。
// 文書ができるたびに当たるよう、context の init script にする。
// browser.newContext() で作った context には、テストの中で自分で呼ぶ（閉じる前と、テストの終わりに開いている画面を撮る）
export async function steadyScreenshots(context: BrowserContext, info: TestInfo = test.info()): Promise<void> {
  contextsOf.set(info, [...(contextsOf.get(info) ?? []), context]);
  await context.addInitScript((css: string) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }, STEADY_SCREENSHOT_CSS);
  const requests = new Set<Request>();
  pending.set(context, requests);
  context.on('request', (request) => requests.add(request));
  context.on('requestfinished', (request) => requests.delete(request));
  context.on('requestfailed', (request) => requests.delete(request));
  // テストの中で閉じる context（組織の見た目のテストなど）は、閉じる前に撮る
  const close = context.close.bind(context);
  context.close = async (options) => {
    await captureEvidence(context, info);
    return close(options);
  };
}

async function waitQuiet(requests: Set<Request> | undefined): Promise<void> {
  const deadline = Date.now() + QUIET_TIMEOUT_MS;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    if ((requests?.size ?? 0) > 0) quietSince = Date.now();
    else if (Date.now() - quietSince >= QUIET_MS) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// context の開いている画面を、開いた順に evidence-<n>.png に撮る。通ったテストだけを撮る（失敗の画像は Playwright が撮る）
async function captureEvidence(context: BrowserContext, info: TestInfo): Promise<void> {
  // 落ちた、時間切れ、飛ばした（test.skip）テストでは撮らない。test.fail の印を付けて期待どおり落ちたテストも撮らない
  if (info.status !== 'passed') return;
  for (const page of context.pages()) {
    if (captured.has(page) || page.isClosed()) continue;
    captured.add(page);
    const index = (counters.get(info) ?? 0) + 1;
    counters.set(info, index);
    // テストの中で閉じる context を撮る時間は、テストの時間に数えられる。撮る分の最長をテストの上限に足し、
    // 撮ることでテストが時間切れにならないようにする（テストの後の撮影は、後片付けの別の枠で数えられる）
    if (info.timeout > 0) info.setTimeout(info.timeout + CAPTURE_BUDGET_MS);
    try {
      await waitQuiet(pending.get(context));
      await page.evaluate(() =>
        document.fonts.ready.then(
          () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        ),
      );
      await page.screenshot({
        path: info.outputPath(`evidence-${index}.png`),
        animations: 'disabled',
        timeout: SCREENSHOT_TIMEOUT_MS,
      });
    } catch {
      // 撮れなくてもテストは落とさない（画像が無い画面は、evidence で新しい画面か無くなった画面に出る）
    }
  }
}

// e2e のテストは test をここから import する（docs/development.md の「e2e の書き方」。lint で止めている）。
// route の処理の中の route.fetch() がテストの終わった後に走ると「Test ended」で落ち、その失敗が次のテストに付く（#318）。
// テストの後で、開いている画面を撮ってから route を外し、まだ処理中のものの失敗は捨てる
export const test = base.extend({
  context: async ({ context }, use, info) => {
    await steadyScreenshots(context, info);
    await use(context);
  },
  page: async ({ page }, use, info) => {
    await use(page);
    for (const context of contextsOf.get(info) ?? []) await captureEvidence(context, info);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  },
});
