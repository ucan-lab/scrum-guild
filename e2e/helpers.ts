import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { SEED_SESSIONS } from '../seed/sessions.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';

// CSP の違反は、ページのスクリプトより先に securitypolicyviolation を拾い、コンソールのエラーと合わせて集める
export async function watchViolations(page: Page): Promise<() => Promise<string[]>> {
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

// seed のセッション（seed/sessions.ts）の Cookie を置いて、ログインした状態にする。
// 名前は画面を開く URL で決まる（e2e は pnpm preview の http の localhost なので sg_session）
export async function signIn(
  context: BrowserContext,
  baseURL: string | undefined,
  who: keyof typeof SEED_SESSIONS,
): Promise<void> {
  if (baseURL === undefined) throw new Error('baseURL が無い');
  await context.addCookies([
    { name: sessionCookieName(baseURL), value: SEED_SESSIONS[who].token, url: baseURL, httpOnly: true },
  ]);
}

// 管理の画面から、自分をリーダーにワークスペースを作り、その画面へ移る（admin でログインしている前提）
export async function createWorkspace(page: Page, name: string, vocabulary: 'game' | 'scrum'): Promise<void> {
  await page.goto('/aoba/admin');
  await page.getByRole('button', { name: 'パーティを作る' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('combobox')).toBeEnabled();
  await dialog.getByRole('radio', { name: vocabulary === 'game' ? /ゲームの言葉/ : /スクラムの言葉/ }).check();
  await dialog.getByLabel('名前').fill(name);
  await dialog.getByRole('button', { name: '作る' }).click();
  await expect(page).toHaveURL(/\/aoba\/w\/[0-9a-f-]{36}$/);
  // 見出しは画面の名前（掲示板／バックログ）、小見出しがワークスペースの名前
  const backlog = vocabulary === 'game' ? '掲示板' : 'バックログ';
  await expect(page.getByRole('heading', { level: 1, name: backlog })).toBeVisible();
  await expect(page.locator('.page-eyebrow')).toHaveText(name);
  await expect(page).toHaveTitle(`${backlog}・${name} - Scrum Guild`);
}

// 行の先頭のつまみ（handle）をマウスで押し、row の上端寄り（top）、下端寄り（bottom）、真ん中（middle）まで動かして離す。
// 離す直前に beforeRelease を呼ぶので、落とす位置の印（線か囲み）を確かめられる。
// Playwright の mouse は Chromium のネイティブのドラッグ（dragstart、dragover、drop）を起こす
export async function dragTo(
  page: Page,
  handle: Locator,
  row: Locator,
  where: 'top' | 'bottom' | 'middle',
  beforeRelease?: () => Promise<void>,
): Promise<void> {
  const from = await handle.boundingBox();
  if (from === null) throw new Error('つまみが見えていない');
  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 4, startY + 4, { steps: 3 });
  // 行き先の行は、つかんだ後に出るもの（親なしの段が空のときの落とし先）もあるので、つかんでから位置を測る
  await row.waitFor({ state: 'visible' });
  const to = await row.boundingBox();
  if (to === null) throw new Error('行が見えていない');
  const endX = to.x + to.width / 2;
  const endY = where === 'top' ? to.y + 3 : where === 'bottom' ? to.y + to.height - 3 : to.y + to.height / 2;
  await page.mouse.move(endX, endY, { steps: 12 });
  // 同じ場所でもう一度動かし、重ねた行の更新を確かにする
  await page.mouse.move(endX + 1, endY);
  await beforeRelease?.();
  await page.mouse.up();
}
