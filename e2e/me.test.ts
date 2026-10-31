// 自分の設定の画面の経験値の節と、バックログの画面のチーム全体の経験値。seed のセッション（seed/sessions.ts）の Cookie で開く。
// あおば開発のミナトは、完了したタスクの起票と完了の明細2行（seed/data.sql）。ひばり工房のミナト（同じアカウント）は、
// 完了と打ち消しをくり返した明細 52 行（合計 0）で、「続きを読む」を確かめる。
// ほかのファイルの e2e がタスクを完了にすると、あおば開発のミナトの明細とレベルは増えうるので、数は ひばり工房で確かめる
import { expect, test } from './fixtures.ts';
import { signIn, watchViolations } from './helpers.ts';

const AOBA_WORKSPACE_ID = '019a0000-0000-7000-8000-000000000401';

test.describe('自分の設定（ミナト）', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL, 'admin');
  });

  // ゲージの伸びと先端の光は CSS の animation。動きを減らす設定では止まり、光（::after の opacity 0）も出ない
  test('ゲージは、ふだんは伸びる animation が付き、動きを減らす設定では付かない', async ({ page }) => {
    const animations = () =>
      page.locator('.gauge-got').evaluate((got) => ({
        got: getComputedStyle(got).animationName,
        gotCount: getComputedStyle(got).animationIterationCount,
        tip: getComputedStyle(got, '::after').animationName,
      }));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/aoba/me');
    await expect(page.locator('.gauge-got')).toBeVisible();
    expect(await animations()).toEqual({ got: 'gauge-grow', gotCount: '1', tip: 'gauge-tip' });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await animations()).toMatchObject({ got: 'none', tip: 'none' });
  });

  test('メニューの「自分の設定」から開くと、レベルの面と経験値の明細が出る', async ({ page }) => {
    const collect = await watchViolations(page);
    await page.goto('/aoba');
    await page.locator('.nav-item', { hasText: '自分の設定' }).click();
    await expect(page).toHaveURL(/\/aoba\/me$/);
    await expect(page.getByRole('heading', { level: 1, name: '自分の設定' })).toBeVisible();
    await expect(page.locator('.page-eyebrow')).toHaveText('ミナト');
    await expect(page.locator('.nav-item[aria-current="page"]')).toHaveText('自分の設定');
    await expect(page).toHaveTitle('自分の設定 - Scrum Guild');

    // レベルの面。紋章（大）、合計、次のレベルまでと見込み、ゲージ、凡例、ワークスペースごとの内訳
    const panel = page.getByRole('region', { name: 'レベル' });
    await expect(panel.locator('.emblem:not(.is-sm)')).toHaveAttribute('aria-label', /^レベル \d+$/);
    await expect(panel.locator('.xp-num')).toHaveText(/^[\d,]+XP$/);
    // 合計の前に経験値のアイコン（crystal）。経験値の色で、読み上げから外す。題には紋章と重ねないのでアイコンを付けない
    const totalIcon = panel.locator('.xp-num > svg.ico');
    await expect(totalIcon).toHaveClass(/\bis-xp\b/);
    await expect(totalIcon).toHaveAttribute('aria-hidden', 'true');
    await expect(totalIcon.locator('use')).toHaveAttribute('href', '#i-crystal');
    await expect(panel.locator('h2 svg')).toHaveCount(0);
    await expect(panel.locator('.xp-sub')).toHaveText(/^次のレベルまで [\d,]+・見込み \+[\d,]+$/);
    await expect(panel.locator('.gauge')).toHaveAttribute(
      'aria-label',
      /^次のレベルまでの \d+% を確定、\d+% が見込み$/,
    );
    // ゲージの両端に今のレベルと次のレベルの数字。読み上げからは外す
    const gaugeEnds = panel.locator('.gauge-end');
    const emblemLevel = Number(
      (await panel.locator('.emblem:not(.is-sm)').getAttribute('aria-label'))?.replace('レベル ', ''),
    );
    await expect(gaugeEnds).toHaveText([`LV ${emblemLevel}`, `LV ${emblemLevel + 1}`]);
    await expect(gaugeEnds.first()).toHaveAttribute('aria-hidden', 'true');
    await expect(gaugeEnds.last()).toHaveAttribute('aria-hidden', 'true');
    await expect(panel.locator('.legend > span')).toHaveText(['確定', '見込み（クエストの完遂で確定）']);
    await expect(panel.getByRole('group', { name: 'パーティごとの経験値' })).toBeVisible();
    // ほかのファイルの e2e がミナトをリーダーにしたワークスペースを足すので、受託開発チームがあることと、末尾の合計だけを見る
    await expect(panel.locator('.breakdown dt', { hasText: '受託開発チーム' })).toHaveCount(1);
    await expect(panel.locator('.breakdown .is-total dt')).toHaveText('すべてのパーティ');
    // 受け取った感謝の数。seed に、ハルカがミナトに送った1件がある（本人の分だけ数える）
    const thanksReceived = panel.getByRole('group', { name: '受け取った感謝' });
    await expect(thanksReceived.locator('dt')).toHaveText('受け取った感謝');
    await expect(thanksReceived.locator('dd')).toHaveText('1');

    // 経験値の明細。seed の起票と完了が並ぶ（ほかのファイルが完了にした行が上に足されうる）
    await expect(page.getByRole('heading', { level: 2, name: '経験値の明細' })).toBeVisible();
    const table = page.getByRole('table', { name: '経験値の明細' });
    await expect(table.locator('thead th')).toHaveText(['確定日時', 'パーティ', '行動', '内容', 'XP']);
    // XP の列の見出しに経験値のアイコン（crystal）。読み上げの名前は文字の「XP」だけ
    const headerIcon = table.locator('thead th').last().locator('svg.ico');
    await expect(headerIcon).toHaveClass(/\bis-xp\b/);
    await expect(headerIcon).toHaveAttribute('aria-hidden', 'true');
    await expect(headerIcon.locator('use')).toHaveAttribute('href', '#i-crystal');
    await expect(table.getByRole('columnheader', { name: 'XP', exact: true })).toHaveCount(1);
    const seeded = table.locator('tbody tr', { hasText: '付与の履歴を返す API を作る' });
    await expect(seeded).toHaveCount(2);
    await expect(seeded.nth(0).locator('td').nth(1)).toHaveText('受託開発チーム');
    await expect(seeded.locator('.tag')).toHaveText(['完遂', '起票']);
    await expect(seeded.locator('.xp-delta')).toHaveText(['+30', '+10']);
    await expect(page.getByText('明細をすべて表示しました')).toBeVisible();

    // アカウントのメニューの名前の横に、自分のレベルの小さい紋章
    await expect(page.locator('.account-menu-button .emblem.is-sm')).toHaveAttribute('aria-label', /^レベル \d+$/);
    expect(await collect()).toEqual([]);
  });

  test('50 件ずつ出し、「続きを読む」で次を足し、最後まで読んだらその旨を出してフォーカスを移す', async ({ page }) => {
    const collect = await watchViolations(page);
    await page.goto('/hibari/me');
    const panel = page.getByRole('region', { name: 'レベル' });
    // 打ち消しで合計 0。レベル1、次のレベルまで 100
    await expect(panel.locator('.emblem:not(.is-sm)')).toHaveAttribute('aria-label', 'レベル 1');
    await expect(panel.locator('.xp-num')).toHaveText('0XP');
    await expect(panel.locator('.xp-sub')).toHaveText('次のレベルまで 100・見込み +0');
    await expect(panel.locator('.gauge-end')).toHaveText(['LV 1', 'LV 2']);
    const breakdown = panel.getByRole('group', { name: 'パーティごとの経験値' });
    await expect(breakdown.locator('dt')).toHaveText(['社内ツール', 'すべてのパーティ']);
    await expect(breakdown.locator('dd')).toHaveText(['0', '0']);
    // 受け取った感謝は無い（0 と出す）
    await expect(panel.getByRole('group', { name: '受け取った感謝' }).locator('dd')).toHaveText('0');

    const rows = page.getByRole('table', { name: '経験値の明細' }).locator('tbody tr');
    await expect(rows).toHaveCount(50);
    // 新しい順。打ち消しは元の行動に「の打ち消し」を添えて負の値
    await expect(rows.nth(0).locator('td').nth(2)).toHaveText('完遂の打ち消し');
    await expect(rows.nth(0).locator('.xp-delta.is-minus')).toHaveText('-30');
    await expect(rows.nth(1).locator('td').nth(2)).toHaveText('完遂');
    await expect(rows.nth(1).locator('.xp-delta')).toHaveText('+30');
    await expect(rows.nth(0).locator('td').nth(3)).toHaveText('締め日の選択欄を足す');

    await page.getByRole('button', { name: '続きを読む' }).click();
    await expect(rows).toHaveCount(52);
    await expect(page.getByRole('button', { name: '続きを読む' })).toHaveCount(0);
    await expect(page.getByText('明細をすべて表示しました')).toBeFocused();
    // 一番古い行は、最初の完了
    await expect(rows.nth(51).locator('td').nth(2)).toHaveText('完遂');
    expect(await collect()).toEqual([]);
  });

  test('続きの読み込みに失敗したら、表を残して知らせ、同じボタンで読み直せる', async ({ page }) => {
    let fail = true;
    await page.route('**/api/hibari/experience-grants', async (route) => {
      const body = route.request().postDataJSON() as { before?: unknown };
      if (body.before !== undefined && fail) {
        fail = false;
        await route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'x' } } });
        return;
      }
      await route.continue();
    });
    await page.goto('/hibari/me');
    const rows = page.getByRole('table', { name: '経験値の明細' }).locator('tbody tr');
    await expect(rows).toHaveCount(50);
    // 知らせの領域は押す前から置き、失敗したときに文字だけを入れる（読み上げに確かに伝えるため）
    await expect(page.getByRole('alert')).toHaveText('');
    await page.getByRole('button', { name: '続きを読む' }).click();
    await expect(page.getByRole('alert')).toHaveText('続きを読み込めませんでした。もう一度試してください');
    await expect(page.locator('.callout.is-warn', { hasText: '続きを読み込めませんでした' })).toBeVisible();
    await expect(rows).toHaveCount(50);
    await page.getByRole('button', { name: '続きを読む' }).click();
    await expect(rows).toHaveCount(52);
    await expect(page.getByRole('alert')).toHaveText('');
  });

  test('明細が無ければ空の状態を出す', async ({ page }) => {
    await page.route('**/api/aoba/experience-grants', (route) => route.fulfill({ json: { grants: [], next: null } }));
    await page.goto('/aoba/me');
    await expect(page.getByText('経験値の明細はまだありません')).toBeVisible();
    // ゲームの言葉の「完遂」で出す（辞書の complete と done）
    await expect(page.getByText('クエストを完遂にすると、起票や完遂の経験値がここに並びます。')).toBeVisible();
    await expect(page.getByRole('table', { name: '経験値の明細' })).toHaveCount(0);
  });

  test('面と明細が読めなければ、それぞれに失敗と節ごとの「もう一度試す」を出し、押した節だけを読み直して題へフォーカスを移す', async ({
    page,
  }) => {
    const failing = new Set(['experience-summary', 'experience-grants']);
    for (const name of ['experience-summary', 'experience-grants']) {
      await page.route(`**/api/hibari/${name}`, (route) =>
        failing.has(name)
          ? route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'x' } } })
          : route.continue(),
      );
    }
    await page.goto('/hibari/me');
    await expect(page.getByRole('heading', { level: 1, name: '自分の設定' })).toBeVisible();
    await expect(page.getByText('今は経験値と API トークンだけを扱えます。')).toBeVisible();
    await expect(page.getByText('レベルを読み込めませんでした')).toBeVisible();
    await expect(page.getByText('経験値の明細を読み込めませんでした')).toBeVisible();
    const retrySummary = page.getByRole('button', { name: 'もう一度試す（レベル）' });
    const retryGrants = page.getByRole('button', { name: 'もう一度試す（経験値の明細）' });
    await expect(retrySummary).toBeVisible();
    await expect(retryGrants).toBeVisible();

    // 面だけが読めるようになった。面を読み直しても、明細はまだ失敗のまま
    failing.delete('experience-summary');
    await retrySummary.click();
    const panel = page.getByRole('region', { name: 'レベル' });
    await expect(panel.locator('.xp-num')).toHaveText('0XP');
    await expect(panel.getByRole('heading', { level: 2, name: 'レベル' })).toBeFocused();
    // 読み直しで出た面は、ゲージを伸ばさず今の値で出す
    await expect(panel.locator('.gauge.is-still')).toHaveCount(1);
    // 終わった animation は getAnimations() に出ないので、時間に依らない animation-name で見る
    expect(
      await panel.locator('.gauge-got').evaluate((got) => ({
        got: getComputedStyle(got).animationName,
        tip: getComputedStyle(got, '::after').animationName,
        soon: getComputedStyle(got.nextElementSibling!).animationName,
      })),
    ).toEqual({ got: 'none', tip: 'none', soon: 'none' });
    await expect(page.getByText('経験値の明細を読み込めませんでした')).toBeVisible();

    // 明細はまた失敗すると、その節にだけ「まだ読み込めませんでした」
    await retryGrants.click();
    await expect(page.getByRole('region', { name: '経験値の明細' }).getByRole('status').last()).toHaveText(
      'まだ読み込めませんでした',
    );
    failing.delete('experience-grants');
    await retryGrants.click();
    await expect(page.getByRole('table', { name: '経験値の明細' }).locator('tbody tr')).toHaveCount(50);
    await expect(page.getByRole('heading', { level: 2, name: '経験値の明細' })).toBeFocused();
  });

  test('面を読み直しても、「続きを読む」で足した明細の行は残る', async ({ page }) => {
    let failSummary = true;
    await page.route('**/api/hibari/experience-summary', (route) =>
      failSummary
        ? route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'x' } } })
        : route.continue(),
    );
    await page.goto('/hibari/me');
    const rows = page.getByRole('table', { name: '経験値の明細' }).locator('tbody tr');
    await expect(rows).toHaveCount(50);
    await page.getByRole('button', { name: '続きを読む' }).click();
    await expect(rows).toHaveCount(52);

    failSummary = false;
    await page.getByRole('button', { name: 'もう一度試す（レベル）' }).click();
    await expect(page.getByRole('region', { name: 'レベル' }).locator('.xp-num')).toHaveText('0XP');
    await expect(rows).toHaveCount(52);
  });

  test('今所属していないワークスペースの明細は、内容を伏せた旨を出す', async ({ page }) => {
    await page.route('**/api/aoba/experience-grants', (route) =>
      route.fulfill({
        json: {
          grants: [
            {
              id: '019a0000-0000-7000-8000-00000000fff1',
              confirmed_at: '2026-09-18T01:30:00.000Z',
              workspace_id: '019a0000-0000-7000-8000-00000000fff2',
              workspace_name: '旧パーティ',
              action: 'task_completed',
              content: null,
              content_hidden: true,
              amount: 30,
            },
          ],
          next: null,
        },
      }),
    );
    await page.goto('/aoba/me');
    const cells = page.getByRole('table', { name: '経験値の明細' }).locator('tbody tr').first().locator('td');
    await expect(cells.nth(1)).toHaveText('旧パーティ');
    await expect(cells.nth(3)).toHaveText('（今所属していないパーティの内容は表示しません）');
    await expect(cells.nth(4)).toHaveText('+30');
  });

  test('PC の幅（1100px と 1440px）では、明細の表を本文の幅いっぱいに出し、押しつぶさない', async ({ page }) => {
    for (const width of [1100, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/hibari/me');
      const table = page.getByRole('table', { name: '経験値の明細' });
      await expect(table.locator('tbody tr')).toHaveCount(50);
      // 説明は表の上（.setting の見出しの列に入れない）
      // （本文の API トークンの節は .setting を使うので、明細の表を含む .setting が無いことで確かめる）
      await expect(page.locator('.setting').filter({ has: table })).toHaveCount(0);
      const sizes = await page.evaluate(() => {
        const ledger = document.querySelector('table[aria-label="経験値の明細"]')!;
        const wrap = ledger.closest('.table-wrap')!;
        const main = document.querySelector('.layout-main')!;
        const content = ledger.querySelector('tbody td.is-name')!;
        return {
          overflow: wrap.scrollWidth - wrap.clientWidth,
          wrapWidth: wrap.getBoundingClientRect().width,
          mainWidth: main.getBoundingClientRect().width,
          contentWidth: content.getBoundingClientRect().width,
        };
      });
      expect(sizes.overflow).toBeLessThanOrEqual(0);
      expect(sizes.wrapWidth).toBeGreaterThanOrEqual(sizes.mainWidth - 1);
      expect(sizes.contentWidth).toBeGreaterThan(120);
    }
  });

  test('390px の幅では表の行を縦に積み、XP の値が見え、明細の表とレベルの面が画面からはみ出さない', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/hibari/me');
    const rows = page.getByRole('table', { name: '経験値の明細' }).locator('tbody tr');
    await expect(rows).toHaveCount(50);
    // 見出しの行の代わりに data-label を値の前に出す
    const xp = rows.first().locator('td[data-label="XP"]');
    await expect(xp.locator('.xp-delta')).toBeVisible();
    // 明細はレベルの面の下にあるので、行まで送ってから、値が横に切れずに見えることを確かめる
    await xp.scrollIntoViewIfNeeded();
    await expect(xp.locator('.xp-delta')).toBeInViewport({ ratio: 1 });
    const box = await xp.boundingBox();
    expect(box !== null && box.x >= 0 && box.x + box.width <= 390).toBe(true);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('320px の幅で、区切りの無い長い名前（小見出し、ワークスペース、内容、内訳）と大きな合計も折り返し、はみ出さない', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    const longName = 'ミナト'.repeat(15);
    const longWorkspace = 'とても長いパーティの名前'.repeat(5);
    const longTitle = 'ポイント付与のバッチを作る'.repeat(6);
    await page.route('**/api/hibari/organization', async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as { me: { name: string } };
      json.me.name = longName;
      await route.fulfill({ response, json });
    });
    await page.route('**/api/hibari/experience-summary', (route) =>
      route.fulfill({
        json: {
          total: 99999,
          level: 45,
          level_start: 99000,
          next_level_at: 103500,
          prospective: 40,
          thanks_received: 12,
          workspaces: [{ id: 'w1', name: longWorkspace, total: 99999, prospective: 40, thanks_received: 12 }],
        },
      }),
    );
    await page.route('**/api/hibari/experience-grants', (route) =>
      route.fulfill({
        json: {
          grants: [
            {
              id: '019a0000-0000-7000-8000-00000000fff3',
              confirmed_at: '2026-10-16T06:20:00.000Z',
              workspace_id: 'w1',
              workspace_name: longWorkspace,
              action: 'task_completed',
              content: longTitle,
              content_hidden: false,
              amount: 30,
            },
          ],
          next: null,
        },
      }),
    );
    await page.goto('/hibari/me');
    await expect(page.locator('.page-eyebrow')).toHaveText(longName);
    await expect(page.locator('.breakdown dt').first()).toHaveText(longWorkspace);
    await expect(page.getByRole('table', { name: '経験値の明細' }).locator('tbody tr')).toHaveCount(1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    // 面と明細の表の中身が、面と表の枠の外へはみ出さない（API トークンの節の表は含めない。明細の表の枠に絞る）
    const inside = await page.evaluate(() => {
      const ledger = document.querySelector('table[aria-label="経験値の明細"]')!.closest('.table-wrap')!;
      return [...document.querySelectorAll('.panel'), ledger].every((box) => box.scrollWidth <= box.clientWidth);
    });
    expect(inside).toBe(true);
  });
});

test.describe('チーム全体の経験値（バックログの画面）', () => {
  test('一般のメンバーにも、見出しの中にワークスペースの全員の合計が1つの数で出る', async ({
    page,
    context,
    baseURL,
  }) => {
    await signIn(context, baseURL, 'member');
    await page.goto(`/aoba/w/${AOBA_WORKSPACE_ID}`);
    await expect(page.getByRole('heading', { level: 1, name: '掲示板' })).toBeVisible();
    await expect(page.locator('.page-head .team-xp')).toHaveText(/^パーティ全体の経験値[\d,]+XP$/);
    // ラベルの前に経験値のアイコン（crystal）。経験値の色で、読み上げから外す
    const icon = page.locator('.page-head .team-xp > svg.ico');
    await expect(icon).toHaveClass(/\bis-xp\b/);
    await expect(icon).toHaveAttribute('aria-hidden', 'true');
    await expect(icon.locator('use')).toHaveAttribute('href', '#i-crystal');
  });

  test('読めなくても、バックログの画面は開き、合計だけを出さない', async ({ page, context, baseURL }) => {
    await signIn(context, baseURL, 'member');
    await page.route('**/api/aoba/experience-team-total', (route) =>
      route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'x' } } }),
    );
    await page.goto(`/aoba/w/${AOBA_WORKSPACE_ID}`);
    await expect(page.getByRole('heading', { level: 1, name: '掲示板' })).toBeVisible();
    await expect(page.locator('.tree')).toBeVisible();
    await expect(page.locator('.team-xp')).toHaveCount(0);
  });
});
