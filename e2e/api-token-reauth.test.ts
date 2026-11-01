// 再認証の画面は本物の古いセッションで確かめる。共有 seed の Cookie は変えず、このファイル専用の行を作って消す。
// 手元の D1 への問い合わせは e2e/local-d1.ts と同じ wrangler のエクスプローラーを使う。
// OAuth の往復は行わず、ログイン開始の URL と戻り先までを見る。
import { createHash, randomBytes } from 'node:crypto';
import { sessionInserts } from '../scripts/seed.ts';
import { SEED_SESSIONS } from '../seed/sessions.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { tokenCreate, tokenList } from '../src/shared/operations/session/index.ts';
import { expect, test } from './fixtures.ts';
import { failOperation, mockOperation } from './operations.ts';
import { executeLocalD1 } from './local-d1.ts';

test.describe('API トークンの再認証', () => {
  // ファイル内で各テスト専用のセッションを持つ。失敗時も afterEach で消し、繰り返しや他ファイルに残さない。
  let hash: string;

  test.beforeEach(async ({ context, baseURL }) => {
    if (baseURL === undefined) throw new Error('baseURL が無い');
    const token = randomBytes(32).toString('base64url');
    hash = createHash('sha256').update(token).digest('hex');
    const session = { ...SEED_SESSIONS.admin, token };
    await executeLocalD1([sessionInserts([session], new Date())]);
    await context.addCookies([{ name: sessionCookieName(baseURL), value: token, url: baseURL, httpOnly: true }]);
  });

  test.afterEach(async () => {
    await executeLocalD1([`DELETE FROM sessions WHERE token_hash = '${hash}'`]);
  });

  test('10分を超えたセッションは、発行の欄に代わってログインし直すリンクを出す', async ({ page }) => {
    await executeLocalD1([
      `UPDATE sessions SET created_at = '${new Date(Date.now() - 11 * 60_000).toISOString()}' WHERE token_hash = '${hash}'`,
    ]);
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
    await expect(link).toHaveAccessibleDescription(
      'API トークンを発行するには、ログインし直してください。発行はログインから10分以内に限られます。',
    );
    await expect(section.getByRole('button', { name: '発行する', exact: true })).toHaveCount(0);
  });

  for (const canCreate of [true, false]) {
    for (const closeWith of ['閉じる', '×']) {
      test(`発行後の一覧が can_create=${canCreate} のとき、${closeWith}で閉じた後に今の発行可否に合う操作へ戻す`, async ({
        page,
      }) => {
        await page.goto('/aoba/me');
        const section = page.getByRole('region', { name: 'API トークン', exact: true });
        await section.getByLabel('名前', { exact: true }).fill('手元の CLI');
        await mockOperation(page, tokenCreate, {
          id: 'a'.repeat(64),
          name: '手元の CLI',
          scope: 'read',
          expires_at: '2026-12-31T00:00:00.000Z',
          token: `sgp_${'a'.repeat(43)}`,
        });
        await mockOperation(page, tokenList, { can_create: canCreate, tokens: [] });
        await section.getByRole('button', { name: '発行する', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'API トークンを発行しました' });
        await expect(dialog).toBeVisible();
        // ダイアログを開いた後の reload が発行の欄を消したことを、閉じる前に待つ。
        if (!canCreate) await expect(section.getByRole('link', { name: 'ログインし直す' })).toHaveCount(1);
        await dialog
          .getByRole('button', { name: '閉じる', exact: true })
          .nth(closeWith === '×' ? 0 : 1)
          .click();
        await expect(dialog).not.toBeVisible();
        const target = canCreate
          ? section.getByLabel('名前', { exact: true })
          : section.getByRole('link', { name: 'ログインし直す' });
        await expect(target).toBeFocused();
        await expect(page.locator(`input[value="sgp_${'a'.repeat(43)}"]`)).toHaveCount(0);
      });
    }
  }
});
