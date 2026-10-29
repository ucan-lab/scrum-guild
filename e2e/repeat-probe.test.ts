import { expect, test } from './fixtures.ts';

// #451 の確認方法の 1 のための一時的なテスト（確かめた後に消す）。1 回だけ走る e2e では通り、
// 繰り返しの 3 回目で落ちる、揺れるテストの代わり
test('繰り返しの 3 回目だけ落ちる', async ({ page }) => {
  await page.goto('/login');
  expect(test.info().repeatEachIndex).not.toBe(2);
});
