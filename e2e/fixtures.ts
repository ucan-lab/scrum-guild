import { test as base } from '@playwright/test';

export { expect } from '@playwright/test';

// e2e のテストは test をここから import する（docs/development.md の「e2e の書き方」。lint で止めている）。
// route の処理の中の route.fetch() がテストの終わった後に走ると「Test ended」で落ち、その失敗が次のテストに付く（#318）。
// テストの後で route を外し、まだ処理中のものの失敗は捨てる
export const test = base.extend({
  page: async ({ page }, use) => {
    await use(page);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  },
});
