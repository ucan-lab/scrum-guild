import type { Page, Request } from '@playwright/test';
import { experienceSummary } from '../src/shared/operations/experience/index.ts';
import { myOrganizations, organizationInfo } from '../src/shared/operations/organization/index.ts';
import { expect, test } from './fixtures.ts';
import { signIn } from './helpers.ts';
import { failOperation, routeOperation } from './operations.ts';

// 画面のエラーの送り手（Issue #376）を、src/hooks.client.ts の init で付け、handleError からも渡すことを確かめる。
// root のレイアウトの onMount で付けると、最初の描画で起きた例外と、SvelteKit が受ける例外（load の失敗）を拾えない。
// どちらも、操作の応答をわざと形の合わない本文にして起こす（画面は応答の形を確かめずに使う。src/lib/api.ts）

const isReport = (request: Request) =>
  request.method() === 'POST' && new URL(request.url()).pathname === '/api/client-errors';

// 送った本文と、その応答の状態を返す
async function captured(page: Page, waiting: Promise<Request>): Promise<Record<string, unknown>> {
  const request = await waiting;
  expect((await request.response())?.status()).toBe(204);
  return request.postDataJSON() as Record<string, unknown>;
}

test('最初の描画で投げた例外も送る', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  // ワークスペースの内訳を配列でなくし、経験値の欄（LevelPanel）の描画で TypeError を起こす
  await routeOperation(page, experienceSummary, { slug: 'aoba' }, (call) =>
    call.route.fulfill({
      status: 200,
      json: { total: 0, level: 1, level_start: 0, next_level_at: 100, prospective: 0, workspaces: { length: 1 } },
    }),
  );
  const waiting = page.waitForRequest(isReport);
  await page.goto('/aoba/me');
  const body = await captured(page, waiting);
  expect(body).toMatchObject({ kind: 'error', name: 'TypeError', route: '/[slug]/me' });
  expect(JSON.stringify(body)).not.toContain('aoba');
});

test('load の失敗（SvelteKit が受け、handleError に渡す例外）も送る', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  // 組織に入れず（404）、組織の選択の一覧に invitations が無い本文にして、組織の枠の load（src/routes/[slug]/+layout.ts）で
  // TypeError を起こす
  await failOperation(page, organizationInfo, { slug: 'aoba' }, 404, 'not_found');
  await routeOperation(page, myOrganizations, (call) => call.route.fulfill({ status: 200, json: {} }));
  const waiting = page.waitForRequest(isReport);
  await page.goto('/aoba');
  const body = await captured(page, waiting);
  expect(body).toMatchObject({ kind: 'error', name: 'TypeError', route: '/[slug]' });
  expect(JSON.stringify(body)).not.toContain('aoba');
});
