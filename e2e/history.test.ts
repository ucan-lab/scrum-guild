// 組織の変更の履歴。管理者が組織の管理の画面の最後の節で、seed の履歴（seed/data.sql の change_logs）を新しい順に見る。
// seed のセッション（seed/sessions.ts）の Cookie で開く。あおば開発の管理者はミナト、一般のユーザーはハルカ。
// ほかのファイルが並列にワークスペースを作って終了するので、行の数は数えず、seed の行どうしの順だけを見る。
// 足された行（新しい日時で先頭に来る）が多いと、seed の行は最初の 50 件の外へ押し出される（並べて繰り返す --repeat-each で起きる）。
// そこで seed の行を見るテストは、一番古い seed の行が出るまで「古い履歴を読む」で読み足す。
// 「古い履歴を読む」の振る舞いは、応答を差し替えて確かめる（seed の行は 50 件に満たない）
import type { Page, Route } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { signIn, watchViolations } from './helpers.ts';

test.use({ timezoneId: 'Asia/Tokyo' });

function sectionOf(page: Page) {
  return page.getByRole('region', { name: '変更の履歴' });
}

function tableOf(page: Page) {
  return sectionOf(page).getByRole('table', { name: '冒険者ギルドの変更の履歴' });
}

// seed の一番古い行。これより古い履歴は無い
const OLDEST_SEED_EVENT = '冒険者ギルド「あおば開発」を作りました';

// 一番古い seed の行が出るまで「古い履歴を読む」で読み足す。読み足すたびに、行が増えるのを待ってから次を押す
async function readToOldestSeedRow(page: Page): Promise<void> {
  const rows = tableOf(page).locator('tbody tr');
  const oldest = rows.filter({ hasText: OLDEST_SEED_EVENT });
  const more = sectionOf(page).getByRole('button', { name: '古い履歴を読む' });
  // 最初のページを読み終えてから数える
  await expect(rows.first()).toBeVisible();
  while ((await oldest.count()) === 0) {
    const count = await rows.count();
    await more.click();
    await expect(rows).not.toHaveCount(count);
  }
}

type Entry = { id: string; created_at: string; actor: unknown; event: unknown };

// 差し替える応答の行。id は UUIDv7 の形の架空の値
function entry(index: number, text: string): Entry {
  return {
    id: `019a0000-0000-7000-8000-${String(index).padStart(12, '0')}`,
    created_at: new Date(Date.UTC(2026, 9, 20, 0, 0) - index * 60_000).toISOString(),
    actor: { kind: 'system' },
    event: { kind: 'workspace_created', workspace_name: text },
  };
}

function cursorOf(item: Entry) {
  return { created_at: item.created_at, id: item.id };
}

test.describe('管理者（あおば開発のミナト）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  test('seed の履歴が新しい順に、日時、した人、内容で出る。運用者は「運用者」とだけ出て、所属の行は出ない', async ({
    page,
  }) => {
    const collect = await watchViolations(page);
    await page.goto('/aoba/admin');
    const table = tableOf(page);
    await expect(table.getByRole('columnheader')).toHaveText(['日時', 'した人', '内容']);
    const seedRows = [
      ['2026/10/10 14:00', '運用者', '冒険者ギルドを再開しました'],
      ['2026/10/10 12:00', '運用者', '冒険者ギルドを一時的に停止しました'],
      ['2026/10/01 09:30', 'ミナト', 'パーティ「受託開発チーム」を作りました'],
      ['2026/10/01 09:00', '運用者', 'ミナトをギルドマスターに指名しました'],
      ['2026/10/01 09:00', '運用者', '冒険者ギルド「あおば開発」を作りました'],
    ];
    // 並列のテストが足した行（新しい日時）は先頭に来るので、seed の行だけを抜き出して順を見る
    await readToOldestSeedRow(page);
    const rows = table.locator('tbody tr');
    await expect(rows.filter({ hasText: OLDEST_SEED_EVENT })).toHaveCount(1);
    // アバターの頭文字は除き、日付と時刻の間の折り返さない空白は普通の空白にして読む
    const texts = await rows.evaluateAll((trs) =>
      trs.map((tr) =>
        [...tr.querySelectorAll('td')].map((td) => {
          const copy = td.cloneNode(true) as HTMLElement;
          copy.querySelectorAll('.avatar').forEach((avatar) => avatar.remove());
          return (copy.textContent ?? '').replace(/\s+/gu, ' ').trim();
        }),
      ),
    );
    const seedTexts = new Set(seedRows.map((row) => row[2]));
    expect(texts.filter((row) => seedTexts.has(row[2]!))).toEqual(seedRows);
    // 運用者のログインの ID も、所属の行も出ない
    await expect(sectionOf(page)).not.toContainText('9000000000000001');
    // 所属の行（受託開発チームの作成と同じ日時）が出ていれば、知らない組の「冒険者ギルドを変更しました」になる
    await expect(table).not.toContainText('冒険者ギルドを変更しました');
    await expect(rows.filter({ hasText: '2026/10/01' })).toHaveCount(3);
    // した人がユーザーなら名前とアバター、運用者は文字だけ
    await expect(rows.filter({ hasText: '受託開発チーム' }).getByRole('img')).toHaveCount(0);
    await expect(rows.filter({ hasText: '受託開発チーム' }).locator('.avatar')).toHaveCount(1);
    // seed の一番古い行より前の履歴は無いので、そこまで読めば「古い履歴を読む」は出ない
    await expect(sectionOf(page).getByRole('button', { name: '古い履歴を読む' })).toHaveCount(0);
    expect(await collect()).toEqual([]);
  });

  test('「古い履歴を読む」で次のページを後ろに足し、最後まで読んだら終わりの文へフォーカスを移す', async ({ page }) => {
    const first = [entry(1, '一番目'), entry(2, '二番目')];
    const second = [entry(3, '三番目')];
    const bodies: unknown[] = [];
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/api/aoba/organization-history', async (route: Route) => {
      const body = route.request().postDataJSON() as { before?: unknown };
      bodies.push(body);
      if (body.before === undefined) {
        await route.fulfill({ json: { entries: first, next: cursorOf(first[1]!) } });
        return;
      }
      await released;
      await route.fulfill({ json: { entries: second, next: null } });
    });
    await page.goto('/aoba/admin');
    const section = sectionOf(page);
    const rows = tableOf(page).locator('tbody tr');
    await expect(rows).toHaveCount(2);

    const more = section.getByRole('button', { name: '古い履歴を読む' });
    await more.click();
    // 読んでいる間は押しても無視し、読み上げに伝える
    await expect(more).toHaveAttribute('aria-disabled', 'true');
    await expect(more).toHaveAttribute('aria-busy', 'true');
    await expect(section.getByRole('status').filter({ hasText: '読み込んでいます' })).toBeAttached();
    // aria-disabled のボタンは Playwright の click が待つので、押す出来事を直に送る
    await more.dispatchEvent('click');
    release();

    await expect(rows).toHaveCount(3);
    await expect(rows.nth(2)).toContainText('パーティ「三番目」を作りました');
    await expect(rows.first()).toContainText('自動の処理');
    await expect(more).toHaveCount(0);
    await expect(section.getByText('これより前の履歴はありません')).toBeFocused();
    // 読めた件数を読み上げに伝える（ボタンが消えても、読み上げの領域は残る）
    await expect(section.getByRole('status').filter({ hasText: '1 件を読みました' })).toBeAttached();
    // 2回目の呼び出しは、前のページの最後の行のカーソルを送る。読んでいる間に押した分は送らない
    expect(bodies).toEqual([{}, { before: cursorOf(first[1]!) }]);
  });

  test('続きを読めなかったら、読めた行を残したまま理由を出し、もう一度押すと読める', async ({ page }) => {
    const first = [entry(1, '一番目')];
    let failNext = true;
    await page.route('**/api/aoba/organization-history', async (route: Route) => {
      const body = route.request().postDataJSON() as { before?: unknown };
      if (body.before === undefined) {
        await route.fulfill({ json: { entries: first, next: cursorOf(first[0]!) } });
      } else if (failNext) {
        failNext = false;
        await route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'x' } } });
      } else {
        await route.fulfill({ json: { entries: [entry(2, '二番目')], next: cursorOf(entry(2, '二番目')) } });
      }
    });
    await page.goto('/aoba/admin');
    const section = sectionOf(page);
    const rows = tableOf(page).locator('tbody tr');
    const more = section.getByRole('button', { name: '古い履歴を読む' });
    await more.click();
    await expect(section.getByRole('alert')).toHaveText('続きを読み込めませんでした。もう一度試してください。');
    await expect(rows).toHaveCount(1);
    await expect(more).toHaveAttribute('aria-disabled', 'false');

    await more.click();
    await expect(rows).toHaveCount(2);
    await expect(section.getByRole('alert')).toHaveText('');
    // 続きがあるうちは、ボタンが残り、フォーカスもボタンのまま
    await expect(more).toBeFocused();
  });

  test('履歴が無ければ、空の状態を出す', async ({ page }) => {
    await page.route('**/api/aoba/organization-history', (route) =>
      route.fulfill({ json: { entries: [], next: null } }),
    );
    await page.goto('/aoba/admin');
    await expect(sectionOf(page).getByText('まだ変更の履歴がありません')).toBeVisible();
    await expect(tableOf(page)).toHaveCount(0);
  });

  test('320px の幅でも、節は横にはみ出さず、行を縦に積む', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/aoba/admin');
    await readToOldestSeedRow(page);
    const row = tableOf(page).locator('tbody tr').filter({ hasText: OLDEST_SEED_EVENT });
    await row.scrollIntoViewIfNeeded();
    await expect(row).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  });

  for (const width of [320, 1280]) {
    test(`${width}px の幅で、空白の無い50字の名前も内容の列で折り返し、横にはみ出さない`, async ({ page }) => {
      const long = 'W'.repeat(50);
      await page.route('**/api/aoba/organization-history', (route) =>
        route.fulfill({
          json: {
            entries: [
              { ...entry(1, long), actor: { kind: 'user', id: '019a0000-0000-7000-8000-000000000301', name: long } },
              { ...entry(2, long), actor: { kind: 'user', id: '019a0000-0000-7000-8000-000000000999', name: null } },
            ],
            next: null,
          },
        }),
      );
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/aoba/admin');
      const table = tableOf(page);
      const rows = table.locator('tbody tr');
      await expect(rows.first()).toContainText(`パーティ「${long}」を作りました`);
      await rows.first().scrollIntoViewIfNeeded();
      // 表の枠の中でも、画面でも、横にはみ出さない
      const wrap = sectionOf(page).locator('.table-wrap');
      expect(await wrap.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      // 名前の分からない人は、仮の頭文字のアバターを出さず、文字だけにする
      await expect(rows.nth(1)).toContainText('名前の分からない人');
      await expect(rows.nth(1).locator('.avatar')).toHaveCount(0);
    });
  }
});

test.describe('一般のユーザー（あおば開発のハルカ）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'member');
  });

  test('組織の管理の画面は「見つからない」で、変更の履歴の節は出ない', async ({ page }) => {
    let historyCalls = 0;
    await page.route('**/api/aoba/organization-history', (route) => {
      historyCalls++;
      return route.continue();
    });
    await page.goto('/aoba/admin');
    await expect(page.getByRole('heading', { level: 1, name: '画面が見つかりません' })).toBeVisible();
    await expect(sectionOf(page)).toHaveCount(0);
    expect(historyCalls).toBe(0);
  });
});
