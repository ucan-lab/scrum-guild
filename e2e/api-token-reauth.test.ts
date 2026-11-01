// 再認証の画面は本物の古いセッションで確かめる。共有 seed の Cookie は変えず、このファイル専用の行を作って消す。
// 手元の D1 への問い合わせは e2e/local-d1.ts と同じ wrangler のエクスプローラーを使う。
// OAuth の往復は行わず、ログイン開始の URL と戻り先までを見る。
import { createHash, randomBytes } from 'node:crypto';
import { devPorts } from '../scripts/dev-ports.ts';
import { sessionInserts } from '../scripts/seed.ts';
import { SEED_SESSIONS } from '../seed/sessions.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { tokenCreate } from '../src/shared/operations/session/index.ts';
import { expect, test } from './fixtures.ts';
import { failOperation } from './operations.ts';

const explorerUrl = `http://localhost:${devPorts(process.env).api}/cdn-cgi/local/explorer/api/d1/database`;

async function explorer(url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const body = (await response.json()) as { success: boolean; result: unknown };
  expect(response.ok, 'ローカル D1 のエクスプローラーの HTTP 応答').toBe(true);
  expect(body.success, 'ローカル D1 の SQL の結果').toBe(true);
  return body.result;
}

async function executeSessionSql(sql: string): Promise<void> {
  const databases = (await explorer(explorerUrl)) as { name: string; uuid: string }[];
  const database = databases.find((item) => item.name === 'DB');
  if (database === undefined) throw new Error('ローカル D1 の DB binding が無い');
  await explorer(`${explorerUrl}/${database.uuid}/raw`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ batch: [{ sql }] }),
  });
}

test.describe('API トークンの再認証', () => {
  // ファイル内で各テスト専用のセッションを持つ。失敗時も afterEach で消し、繰り返しや他ファイルに残さない。
  let hash: string;

  test.beforeEach(async ({ context, baseURL }) => {
    if (baseURL === undefined) throw new Error('baseURL が無い');
    const token = randomBytes(32).toString('base64url');
    hash = createHash('sha256').update(token).digest('hex');
    const session = { ...SEED_SESSIONS.admin, token };
    await executeSessionSql(sessionInserts([session], new Date()));
    await context.addCookies([{ name: sessionCookieName(baseURL), value: token, url: baseURL, httpOnly: true }]);
  });

  test.afterEach(async () => {
    await executeSessionSql(`DELETE FROM sessions WHERE token_hash = '${hash}'`);
  });

  test('10分を超えたセッションは、発行の欄に代わってログインし直すリンクを出す', async ({ page }) => {
    await executeSessionSql(
      `UPDATE sessions SET created_at = '${new Date(Date.now() - 11 * 60_000).toISOString()}' WHERE token_hash = '${hash}'`,
    );
    await page.goto('/aoba/me');
    const section = page.getByRole('region', { name: 'API トークン', exact: true });
    const link = section.getByRole('link', { name: 'ログインし直す' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', '/api/auth/github/start?return_to=%2Faoba%2Fme');
    await expect(section.getByRole('button', { name: '発行する', exact: true })).toHaveCount(0);
    // 再認証せず一覧は使える。
    await expect(section.getByRole('table', { name: '発行済みの API トークン' })).toBeVisible();
  });

  test('入力中に猶予を過ぎて reauth_required を受けたら、同じ案内へ切り替えてフォーカスを移す', async ({ page }) => {
    await page.goto('/aoba/me');
    const section = page.getByRole('region', { name: 'API トークン', exact: true });
    await section.getByLabel('名前', { exact: true }).fill('手元の CLI');
    await failOperation(page, tokenCreate, 403, 'reauth_required');
    await section.getByRole('button', { name: '発行する', exact: true }).click();
    const link = section.getByRole('link', { name: 'ログインし直す' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', '/api/auth/github/start?return_to=%2Faoba%2Fme');
    await expect(link).toBeFocused();
    await expect(section.getByRole('button', { name: '発行する', exact: true })).toHaveCount(0);
  });
});
