import { test as base, type BrowserContext, type TestInfo } from '@playwright/test';

import {
  type DevWarningAt,
  formatDevWarnings,
  isKnownDevWarning,
  isUnjudgeableDevWarning,
  parseDevWarning,
} from '../scripts/dev-warnings.ts';
import { isDevBuild } from '../scripts/e2e-server.ts';

export { expect } from '@playwright/test';

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

// e2e のテストは test をここから import する（docs/development.md の「e2e の書き方」。lint で止めている）。
// route の処理の中の route.fetch() がテストの終わった後に走ると「Test ended」で落ち、その失敗が次のテストに付く（#318）。
// テストの後で route を外し、まだ処理中のものの失敗は捨てる。
// 開発モードの build では、テストの間に開発時の警告が出ていれば、テストを落とす。page を使わないテストでも確かめるよう auto にする
// （auto の fixture は最初に立ち、最後に片付くので、page と context の片付けの後に確かめる）。
// テストの中で browser.newContext()（と、中で newContext を呼ぶ browser.newPage()）で作る context も集めるよう、テストの間だけ newContext を包む
export const test = base.extend<{ afterTest: void }>({
  afterTest: [
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
    watchDevWarnings(context, info);
    await use(context);
  },
  page: async ({ page }, use) => {
    await use(page);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  },
});
