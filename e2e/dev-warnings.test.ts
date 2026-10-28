// 開発時の警告を集める仕組み（e2e/fixtures.ts の devWarnings）が空振りしないことの確かめ（#375）。開発モードの build（E2E_DEV_BUILD=1）でだけ動く。
// 警告を出すテストは test.fail() を付ける。fixture がテストの終わりに落とせば期待どおりで通り、
// Playwright の console の形が変わるなどして集められなくなると、落ちなかったテストとして落ちる
import type { Page } from '@playwright/test';
import { isDevBuild } from '../scripts/e2e-server.ts';
import { test } from './fixtures.ts';

test.skip(!isDevBuild(process.env), '開発モードの build（E2E_DEV_BUILD=1）のときだけ確かめる');

// Svelte が開発時に出すのと同じ形（%c と書式の引数）で警告を出す
async function warn(page: Page, name: string): Promise<void> {
  await page.evaluate((name) => {
    console.warn(`%c[svelte] ${name}\n%c確かめのための警告`, 'font-weight: bold', 'font-weight: normal');
  }, name);
}

test('テストの引数の page で出た警告で落ちる', async ({ page }) => {
  test.fail();
  await page.goto('/login');
  await warn(page, 'dev_warning_probe_page');
});

test('browser.newContext() で作った context の警告で落ちる', async ({ browser, baseURL }) => {
  test.fail();
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto('/login');
  await warn(page, 'dev_warning_probe_context');
  await context.close();
});

test('browser.newPage() で作った画面の警告で落ちる', async ({ browser, baseURL }) => {
  test.fail();
  const page = await browser.newPage({ baseURL });
  await page.goto('/login');
  await warn(page, 'dev_warning_probe_new_page');
  await page.close();
});

// annotation（known-dev-warning）はテストの終わりに fixture が足すので、テストの中では確かめない
test('既知の警告では落ちない', async ({ page }) => {
  await page.goto('/foo/bar/baz');
  await page.evaluate(() => console.warn('%c[sveltekit] hmr_reload_after_error\n%c確かめのための警告', '', ''));
});

test('ほかの console.warn では落ちない', async ({ page }) => {
  await page.goto('/login');
  await page.evaluate(() => console.warn('[vite] connected.'));
});
