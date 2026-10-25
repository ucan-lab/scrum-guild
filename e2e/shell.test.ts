import { expect, test, type Page } from '@playwright/test';

// build と wrangler dev に渡した版。埋めていなければ dev（docs/development.md の「版」）
const version = process.env.APP_VERSION || 'dev';

// CSP の違反は、ページのスクリプトより先に securitypolicyviolation を拾い、コンソールのエラーと合わせて集める
async function watchViolations(page: Page): Promise<() => Promise<string[]>> {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await page.addInitScript(() => {
    const violations: string[] = [];
    (window as unknown as { __cspViolations: string[] }).__cspViolations = violations;
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return async () => {
    const violations = await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
    return [...violations, ...consoleErrors];
  };
}

test('/ はシェルを返し、API の版を出し、CSP の違反が無い', async ({ page }) => {
  const collect = await watchViolations(page);
  const res = await page.goto('/');
  expect(res?.status()).toBe(200);
  expect(res?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");

  await expect(page.getByRole('heading', { level: 1, name: 'Scrum Guild' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText(`API: ok（版 ${version}）`);
  expect(await collect()).toEqual([]);
});

// 画面の無いパスも SPA の fallback で 200 のシェルを返し、404 は SvelteKit が画面の中で描く
test('画面の無いパスも 200 でシェルを返し、CSP の違反が無い', async ({ page }) => {
  const collect = await watchViolations(page);
  const res = await page.goto('/foo');
  expect(res?.status()).toBe(200);
  expect(res?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");

  await expect(page.getByRole('heading', { level: 1, name: '404' })).toBeVisible();
  expect(await collect()).toEqual([]);
});

test('/api/health は D1 に届いて 200 で版を返す', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ status: 'ok', database: 'ok', version });
});

// 画面のシェルが出す版は API から取ったものなので、build に埋めた kit.version.name は SvelteKit が書き出す version.json で見る
test('画面の build に埋めた版が API の版と同じ', async ({ request }) => {
  const res = await request.get('/_app/version.json');
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ version });
});
