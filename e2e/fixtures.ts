import { test as base, type BrowserContext, type Page, type Request, type TestInfo } from '@playwright/test';

import {
  type DevWarningAt,
  formatDevWarnings,
  isKnownDevWarning,
  isUnjudgeableDevWarning,
  parseDevWarning,
} from '../scripts/dev-warnings.ts';
import { isDevBuild } from '../scripts/e2e-server.ts';
import { EVIDENCE } from './evidence-mode.ts';

export { expect } from '@playwright/test';

// 画面のスクリーンショット（evidence-<n>.png）。CI の evidence が main の画像と中身のハッシュで比べ、違う画面だけを PR に並べる
// （docs/development.md の「e2e の画像のコメント」）。同じ画面なら撮り直しても同じ画像になるよう、次をそろえる。
// - 撮るたびに変わる文字を透明にする。場所と大きさは残るので、並びの変化は写り、toBeVisible と toHaveText も変わらない
//   - <time>: サーバーが付ける時刻（コメント、変更の履歴、組織の履歴）。テストの中で作った行は実行の時刻になる
//   - 組織の画面の API の節の状態: 版（APP_VERSION）を出し、PR の head と main のコミットで必ず違う
//   - ヘッダーのレベルの印の数字: 組織の中の経験値の合計で決まり、並べて走るほかのテストの完了で、撮る時機ごとに変わる（#377）
//   - 入力欄のカーソル: 点滅する
// - テストの終わりに、通信が止まるのを待ち、アニメーションとトランジションを終わりまで進めてから撮る。
//   Playwright のテストの終わりのスクリーンショット（screenshot: 'on'）は、読み込みやトーストの出入りの途中を撮ることがあり、
//   同じコミットで撮り直すと3割ほどの画面が違った（#337）
// 撮るのは E2E_EVIDENCE=1 のとき（CI の e2e）だけ（e2e/evidence-mode.ts）
export const STEADY_SCREENSHOT_CSS = [
  'time, section[aria-labelledby="s-api"] p[role="status"], .account-menu .emblem { color: transparent !important; text-shadow: none !important; }',
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

// 開発モードの build（E2E_DEV_BUILD=1。CI の e2e-dev）で、テストごとに集めた Svelte と SvelteKit の開発時の警告（#375）
const DEV_BUILD = isDevBuild(process.env);
const devWarningsOf = new WeakMap<TestInfo, DevWarningAt[]>();
// 数えずに通した既知の警告（テストの annotation に残し、直った Issue の行を一覧から外し忘れていないかを見られるようにする）
const knownDevWarningsOf = new WeakMap<TestInfo, Set<string>>();
const watchedContexts = new WeakSet<BrowserContext>();

function watchDevWarnings(context: BrowserContext, info: TestInfo): void {
  if (!DEV_BUILD || watchedContexts.has(context)) return;
  watchedContexts.add(context);
  const warnings = devWarningsOf.get(info) ?? [];
  devWarningsOf.set(info, warnings);
  const known = knownDevWarningsOf.get(info) ?? new Set<string>();
  knownDevWarningsOf.set(info, known);
  context.on('console', (message) => {
    if (message.type() !== 'warning') return;
    const warning = parseDevWarning(message.text());
    // 開発モードの build では判定が働かない警告は数えない（scripts/dev-warnings.ts の UNJUDGEABLE_DEV_WARNINGS）
    if (!warning || isUnjudgeableDevWarning(warning)) return;
    const page = message.page();
    const at = { ...warning, path: page ? new URL(page.url()).pathname : '（画面の外）' };
    // 直す Issue のある既知の警告は数えない（scripts/dev-warnings.ts の KNOWN_DEV_WARNINGS）
    if (isKnownDevWarning(at)) known.add(`${at.name}（画面 ${at.path}）`);
    else warnings.push(at);
  });
}

// 画面の CSP は style 要素と style 属性をハッシュで絞るので、構築可能なスタイルシート（CSP の対象外）で当てる。
// 文書ができるたびに当たるよう、context の init script にする。
// browser.newContext() で作った context には、テストの中で自分で呼ぶ（閉じる前と、テストの終わりに開いている画面を撮る）。
// 開発モードの build では、その context の開発時の警告もここで集め始める
export async function steadyScreenshots(context: BrowserContext, info: TestInfo = test.info()): Promise<void> {
  watchDevWarnings(context, info);
  if (!EVIDENCE) return;
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
  // テストの中の finally で閉じる context では、落ちた後でも status はまだ passed なので、errors も見る
  // 開発時の警告で落ちるテスト（開発モードの build）も撮らない
  if (info.status !== 'passed' || info.errors.length > 0 || (devWarningsOf.get(info)?.length ?? 0) > 0) return;
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
// テストの後で、開いている画面を撮ってから route を外し、まだ処理中のものの失敗は捨てる。
// 開発モードの build では、テストの間に開発時の警告が出ていれば、テストを落とす。page を使わないテストでも確かめるよう auto にする
// （auto の fixture は最初に立ち、最後に片付くので、page と context の片付けの後に確かめる）。
// テストの中で browser.newContext()（と、中で newContext を呼ぶ browser.newPage()）で作る context も、
// steadyScreenshots を呼び忘れても集めるよう、テストの間だけ newContext を包む
export const test = base.extend<{ devWarnings: void }>({
  devWarnings: [
    async ({ browser }, use, info) => {
      const newContext = browser.newContext;
      if (DEV_BUILD) {
        browser.newContext = async (options) => {
          const context = await newContext.call(browser, options);
          watchDevWarnings(context, info);
          return context;
        };
      }
      try {
        await use();
      } finally {
        if (DEV_BUILD) browser.newContext = newContext;
      }
      const known = knownDevWarningsOf.get(info);
      if (known && known.size > 0) {
        info.annotations.push({ type: 'known-dev-warning', description: [...known].join('\n') });
      }
      const warnings = devWarningsOf.get(info) ?? [];
      if (warnings.length > 0) throw new Error(formatDevWarnings(warnings));
    },
    { auto: true },
  ],
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
