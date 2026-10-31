import type { Page } from '@playwright/test';
import { sprintBoard, sprintExtend, sprintList } from '../src/shared/operations/sprint/index.ts';
import { expect, test } from './fixtures.ts';
import { createWorkspace, signIn, waitForResponses, waitForSettled, watchViolations } from './helpers.ts';
import { mockOperation, routeOperation } from './operations.ts';
import { NEXT_SPRINT, OVERDUE_PLAN, SAMPLE_BOARD } from './sprint-fixture.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

async function createSprint(page: Page, start: string, name: string): Promise<void> {
  await page.getByRole('button', { name: 'スプリントを作る' }).click();
  const dialog = page.getByRole('dialog', { name: 'スプリントを作る' });
  await dialog.getByLabel('開始日').fill(start);
  await dialog.getByLabel('長さ（日）').fill('14');
  await dialog.getByLabel('名前（任意）').fill(name);
  await dialog.getByRole('button', { name: '作る', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.lane-title', { hasText: name })).toBeVisible();
}

test('延長の予告どおり空きを吸収して後ろを押し出し、進行中の名前とゴールを直せる', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(90_000);
  await signIn(context, baseURL, 'admin');
  const collect = await watchViolations(page);
  await createWorkspace(page, '延長を確かめる隊');
  await page.getByRole('link', { name: '計画' }).click();
  await createSprint(page, '2099-03-01', '第1回');
  await createSprint(page, '2099-03-16', '第2回');
  await createSprint(page, '2099-03-30', '第3回');
  await page.getByRole('button', { name: '始める: スプリント 第1回' }).click();
  const start = page.getByRole('dialog', { name: 'スプリントを始める' });
  await start.getByRole('button', { name: '始める', exact: true }).click();
  await expect(start).toBeHidden();
  await page.getByRole('link', { name: 'スプリント', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'スプリント 第1回' })).toBeVisible();
  await page.getByRole('button', { name: '延長する', exact: true }).click();
  const extend = page.getByRole('dialog', { name: 'スプリントを延ばす' });
  await extend.getByLabel('延ばす日数').fill('3');
  await expect(extend.locator('[data-sprint-extend-end]')).toHaveText('2099-03-17');
  await expect(extend.locator('[data-sprint-shift]')).toHaveText(['3/16〜3/29 → 3/18〜3/31', '3/30〜4/12 → 4/1〜4/14']);
  await expect(extend.locator('[data-sprint-shift-days]')).toHaveText(['（2 日）', '（2 日）']);
  const extended = waitForResponses(page, '/sprint-extend');
  await extend.getByRole('button', { name: '3 日延長する', exact: true }).click();
  await extended;
  await expect(extend).toBeHidden();
  await expect(page.getByText('延長 3 日', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '名前とスプリントゴールを変更' }).click();
  const edit = page.getByRole('dialog', { name: 'スプリントを直す' });
  await expect(edit.getByLabel('開始日')).toHaveCount(0);
  await edit.getByLabel('名前（任意）').fill('延長した第1回');
  await edit.getByLabel('スプリントゴール', { exact: true }).fill('運用の手順を確かめる');
  const saved = waitForResponses(page, '/sprint-update');
  await edit.getByRole('button', { name: '保存する', exact: true }).click();
  await saved;
  await expect(edit).toBeHidden();
  await expect(page.getByRole('heading', { level: 1, name: 'スプリント 延長した第1回' })).toBeVisible();
  await expect(page.locator('.notice-title')).toHaveText('運用の手順を確かめる');

  await page.getByRole('link', { name: '計画' }).click();
  const lanes = page.locator('.lane');
  await expect(lanes.nth(0)).toContainText('延長 3 日');
  await expect(lanes.nth(0)).toContainText('運用の手順を確かめる');
  await expect(lanes.nth(1).locator('.lane-sub')).toContainText('3/18〜3/31');
  await expect(lanes.nth(2).locator('.lane-sub')).toContainText('4/1〜4/14');
  expect(await collect()).toEqual([]);
  await page.mouse.move(0, 0);
  await expect(page.locator('.toasts:visible .toast')).toHaveCount(0);
});

for (const width of [320, 390, 1024, 1280]) {
  test(`延長ダイアログは ${width}px で予告を表示し、28日を超える入力を送らない`, async ({ page, context, baseURL }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(context, baseURL, 'admin');
    await mockOperation(page, sprintBoard, { slug: 'aoba' }, SAMPLE_BOARD);
    await mockOperation(page, sprintList, { slug: 'aoba' }, OVERDUE_PLAN);
    let sent = 0;
    await routeOperation(page, sprintExtend, { slug: 'aoba' }, async (call) => {
      sent++;
      await call.fail(500, 'internal');
    });
    await page.goto('/aoba/w/019a0000-0000-7000-8000-000000000401/sprint');
    await expect(page.getByRole('button', { name: '延長する', exact: true })).toBeVisible();
    await waitForSettled(page);
    await page.getByRole('button', { name: '延長する', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'スプリントを延ばす' });
    await expect(dialog.getByLabel('延ばす日数')).toHaveAttribute('max', '14');
    await dialog.getByLabel('延ばす日数').fill('15');
    await dialog.getByRole('button', { name: '延長する', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('全体の長さは28日まで');
    await dialog.getByLabel('延ばす日数').fill('2');
    await expect(dialog.locator('[data-sprint-shift]')).toHaveText('10/27〜11/9 → 10/29〜11/11');
    await expect(dialog.locator('[data-sprint-shift-days]')).toHaveText('（2 日）');
    await expect(dialog.getByText('1〜14 日', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '2 日延長する', exact: true })).toBeVisible();
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await dialog.getByRole('button', { name: 'やめる' }).click();
    await page.reload();
    await expect(page.getByRole('button', { name: '延長する', exact: true })).toBeVisible();
    expect(sent).toBe(0);
    await waitForSettled(page);
    await page.getByRole('button', { name: '延長する', exact: true }).click();
    await expect(dialog.locator('[data-sprint-shift]')).toBeVisible();
    await page.mouse.move(0, 0);
  });
}

// 進行中（10/13〜10/26）の後ろに、14 日のスプリントを隙間なく count 本並べる。shiftDays は別の人の延長で既にずれた日数
function chainedPlan(count: number, shiftDays: number) {
  const day = 86_400_000;
  const iso = (date: number) => new Date(date).toISOString().slice(0, 10);
  const active = OVERDUE_PLAN.sprints[0]!;
  const followers = Array.from({ length: count }, (_, index) => {
    const start = Date.parse(NEXT_SPRINT.start_on) + (index * 14 + shiftDays) * day;
    return {
      ...NEXT_SPRINT,
      id: `019a0000-0000-7000-8000-00000000f3${String(index).padStart(2, '0')}`,
      name: `第${15 + index}回`,
      start_on: iso(start),
      end_on: iso(start + 13 * day),
      tasks: [],
    };
  });
  return {
    ...OVERDUE_PLAN,
    sprints: [
      {
        ...active,
        end_on: iso(Date.parse(active.end_on) + shiftDays * day),
        length: active.length + shiftDays,
        extended_days: shiftDays,
      },
      ...followers,
    ],
  };
}

test('押し出しは5本まで並べて残りを本数で示し、別の人が先に延ばしたら読み直して予告を出し直す', async ({
  page,
  context,
  baseURL,
}) => {
  await signIn(context, baseURL, 'admin');
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, SAMPLE_BOARD);
  const unroute = await mockOperation(page, sprintList, { slug: 'aoba' }, chainedPlan(7, 0));
  const sentEndOn: string[] = [];
  await routeOperation(page, sprintExtend, { slug: 'aoba' }, async (call) => {
    sentEndOn.push(call.input.end_on);
    // 送った後に別の人が1日延ばした状態へ一覧を差し替えてから、読んだ最終日が古いとして断る
    await unroute();
    await mockOperation(page, sprintList, { slug: 'aoba' }, chainedPlan(7, 1));
    await call.fail(409, 'conflict', { details: { reason: 'changed' } });
  });
  await page.goto('/aoba/w/019a0000-0000-7000-8000-000000000401/sprint');
  await waitForSettled(page);
  await page.getByRole('button', { name: '延長する', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'スプリントを延ばす' });
  await dialog.getByLabel('延ばす日数').fill('2');
  await expect(dialog.locator('[data-sprint-shift]')).toHaveCount(5);
  await expect(dialog.locator('[data-sprint-shift]').first()).toHaveText('10/27〜11/9 → 10/29〜11/11');
  await expect(dialog.locator('[data-sprint-shift-more]')).toHaveText(
    'ほか 2 本のスプリントも、重なる分だけ後ろへずらします',
  );
  await dialog.getByRole('button', { name: '2 日延長する', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('期間が変わりました。');
  expect(sentEndOn).toEqual(['2026-10-26']);
  await expect(dialog.getByText('1〜13 日', { exact: true })).toBeVisible();
  await expect(dialog.locator('[data-sprint-extend-end]')).toHaveText('2026-10-29');
  await expect(dialog.locator('[data-sprint-shift]').first()).toHaveText('10/28〜11/10 → 10/30〜11/12');
  await page.mouse.move(0, 0);
});

test('後ろと重ならなければ動かない予告を出し、28日では入力と送信を止める', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await mockOperation(page, sprintBoard, { slug: 'aoba' }, SAMPLE_BOARD);
  const plan = { ...OVERDUE_PLAN, sprints: [OVERDUE_PLAN.sprints[0]!] };
  const unroute = await mockOperation(page, sprintList, { slug: 'aoba' }, plan);
  await page.goto('/aoba/w/019a0000-0000-7000-8000-000000000401/sprint');
  await page.getByRole('button', { name: '延長する', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'スプリントを延ばす' });
  // 読み上げの要約にも同じ文が入るので、見える段落を指す
  await expect(dialog.getByRole('paragraph').filter({ hasText: '後ろのスプリントは動きません' })).toBeVisible();
  await dialog.getByRole('button', { name: 'やめる' }).click();
  await unroute();
  await mockOperation(
    page,
    sprintList,
    { slug: 'aoba' },
    {
      ...plan,
      sprints: [{ ...plan.sprints[0]!, end_on: '2026-11-09', length: 28, extended_days: 14 }],
    },
  );
  await page.getByRole('button', { name: '延長する', exact: true }).click();
  await expect(dialog.getByText('長さが28日のため、これ以上延長できません。')).toBeVisible();
  await expect(dialog.getByLabel('延ばす日数')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '延長する', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await page.mouse.move(0, 0);
});
