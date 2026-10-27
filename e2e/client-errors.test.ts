import { expect, test } from './fixtures.ts';

// 画面で捕まえていない例外と Promise の拒否を、POST /api/client-errors へ送る（Issue #376）。
// 送り手は src/hooks.client.ts の init が付けるので、ログイン前の画面（/login）でも送る。
// 受ける側の伏せ方と上限は test/client-errors*.test.ts

test('ログイン前の画面で捕まえていない例外が起きると、route.id と版を添えて送り、204 を受ける', async ({ page }) => {
  await page.goto('/login?return_to=%2Fsecret-path');
  await expect(page.getByRole('heading', { level: 1, name: 'ログイン' })).toBeVisible();

  const sent = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/client-errors');
  await page.evaluate(() => {
    setTimeout(() => {
      throw new TypeError("e2e boom 'quoted'");
    });
  });
  const request = await sent;
  const response = await request.response();
  expect(response?.status()).toBe(204);

  const body = request.postDataJSON() as Record<string, unknown>;
  expect(body).toMatchObject({ kind: 'error', name: 'TypeError', message: "e2e boom 'quoted'", route: '/login' });
  expect(typeof body.clientVersion).toBe('string');
  expect(body.clientVersion).not.toBe('dev');
  // URL のクエリは送らない
  expect(JSON.stringify(body)).not.toContain('secret-path');
});

test('捕まえていない Promise の拒否も送る。同じものは1回だけ', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { level: 1, name: 'ログイン' })).toBeVisible();

  const bodies: Record<string, unknown>[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/client-errors') {
      bodies.push(request.postDataJSON() as Record<string, unknown>);
    }
  });
  const answered = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/client-errors');
  await page.evaluate(() => {
    for (let i = 0; i < 3; i++) void Promise.reject(new Error('e2e rejected'));
  });
  expect((await answered).status()).toBe(204);
  // 2回目と3回目が送られないことを、後から別の拒否を1つ起こし、それが届いた時点の数で確かめる
  // （送り手は起きた順に送るので、2回目と3回目を送るなら、後の拒否より先に送っている）
  const later = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === '/api/client-errors' &&
      (request.postDataJSON() as { message?: unknown }).message === 'e2e later',
  );
  await page.evaluate(() => {
    void Promise.reject(new Error('e2e later'));
  });
  await later;
  expect(bodies.map((body) => body.message)).toEqual(['e2e rejected', 'e2e later']);
  expect(bodies[0]).toMatchObject({
    kind: 'unhandledrejection',
    name: 'Error',
    message: 'e2e rejected',
    route: '/login',
  });
});
