// 狭い幅の検査の関数（e2e/helpers.ts の findOverflowViolations、findTargetSizeViolations、createLayoutCheck）と
// 除外の一覧（e2e/ui-exclusions.ts）が空振りしないことを確かめる（#336）。壊した小さな HTML を page.setContent で置き、
// 違反を拾って落ちることと、疑似要素で押せる範囲を広げた部品や中で横に送れる入れ物を誤って落とさないことを見る
import { expect, test } from './fixtures.ts';
import {
  NARROW_VIEWPORT,
  createLayoutCheck,
  excludeKnownViolations,
  findOverflowViolations,
  findTargetSizeViolations,
} from './helpers.ts';
import { isLayoutCheck, staleExclusions, type UiExclusion } from './ui-exclusions.ts';

// 幅 600px の箱（文字を持つ）と、30px で押せる範囲を広げていないボタン
const BROKEN = `<!doctype html>
<html lang="en">
  <head><title>Broken</title><style>body { margin: 0; } button { padding: 0; border: 0; }</style></head>
  <body>
    <main>
      <div class="wide" style="width: 600px">Wide box</div>
      <button type="button" class="small" style="width: 30px; height: 30px; margin: 40px">S</button>
    </main>
  </body>
</html>`;

// 通るべきもの。見た目は 24px のまま ::after で押せる範囲を 44px 四方に広げたボタン、横に送る設計の入れ物（.table-wrap）の中の広い表、
// 文中のリンク、44px 四方のボタン（角を丸めた円も）、見えない input を包む 44px の高さの label（input は既定の余白で label より小さい）、
// 前後に文字の無い、折り返す inline のリンク（行の高さは 48px、行ごとの箱は padding で 45px。外接の箱の中心は行の間に落ちる）、見えないボタン、inert の中の小さなボタン
const FINE = `<!doctype html>
<html lang="en">
  <head>
    <title>Fine</title>
    <style>
      body { margin: 0; padding: 40px; }
      button { padding: 0; border: 0; }
      .pseudo { position: relative; width: 24px; height: 24px; }
      .pseudo::after { content: ""; position: absolute; left: 50%; top: 50%; width: 44px; height: 44px; transform: translate(-50%, -50%); }
      .table-wrap { overflow-x: auto; width: 300px; }
      .big { width: 44px; height: 44px; display: block; margin-top: 40px; }
      /* inline の要素は、行の高さではなく自分の箱（文字と padding）でしか当たらないので、上下の padding で 45px にする */
      .wrap-link { width: 120px; line-height: 48px; margin-top: 40px; }
      .wrap-link a { padding-block: 14px; }
    </style>
  </head>
  <body>
    <main>
      <button type="button" class="pseudo">P</button>
      <div class="table-wrap"><table style="width: 800px"><tr><td>Wide cell</td></tr></table></div>
      <div class="wrap-link" style="width: 80px"><a href="#w">Wrapping link text</a></div>
      <p>Read the <a href="#x">guide</a> first.</p>
      <button type="button" class="big">B</button>
      <button type="button" class="big" style="border-radius: 50%">R</button>
      <label style="display: inline-block; position: relative; width: 60px; height: 44px; margin-top: 40px"><input type="radio" name="r" style="position: absolute; inset: 0; opacity: 0" /> A</label>
      <button type="button" hidden style="width: 10px; height: 10px">H</button>
      <div inert><button type="button" style="width: 10px; height: 10px">I</button></div>
    </main>
  </body>
</html>`;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(NARROW_VIEWPORT);
});

test('幅 600px の箱で、ページが横に動くことと文字を持つ要素の右端のはみ出しを拾う', async ({ page }) => {
  await page.setContent(BROKEN);
  const violations = await findOverflowViolations(page);
  expect(violations.map((violation) => `${violation.rule} ${violation.target}`)).toEqual([
    'overflow html',
    'overflow div.wide',
  ]);
  expect(violations[0]!.detail).toBe('ページの幅 600px が画面の幅 390px を越え、横に動く');
  expect(violations[1]!.detail).toBe('右端 600px が画面の右端 390px を越える（「Wide box」）');
});

test('30px で押せる範囲を広げていないボタンを拾い、44px 四方のどの点が外れたかを出す', async ({ page }) => {
  await page.setContent(BROKEN);
  const violations = await findTargetSizeViolations(page);
  expect(violations.map((violation) => `${violation.rule} ${violation.target}`)).toEqual(['target-44 button.small']);
  // 中心と、44px の円の上の四隅は 30px の箱の中に入って当たり、辺の中点の4点が外れる（main に当たる）
  expect(violations[0]!.detail).toMatch(
    /^見た目の箱は 30×30px。44px 四方のうち 上（[\d.]+, [\d.]+）は main、左（[\d.]+, [\d.]+）は main、右（[\d.]+, [\d.]+）は main、下（[\d.]+, [\d.]+）は main$/,
  );
});

test('疑似要素で広げたボタン、中で横に送れる入れ物、文中のリンク、見えないものと inert の中は落とさない', async ({
  page,
}) => {
  await page.setContent(FINE);
  expect(await findOverflowViolations(page)).toEqual([]);
  expect(await findTargetSizeViolations(page)).toEqual([]);
  // 疑似要素を外すと落ちる（上の通る結果が、ボタンを数えずに通ったのではない）
  await page.addStyleTag({ content: '.pseudo::after { content: none; }' });
  expect((await findTargetSizeViolations(page)).map((violation) => violation.target)).toEqual(['button.pseudo']);
});

test('画面の外のボタンは中へ送ってから調べ、画面の端に接したボタンは画面の内側に寄せた点で調べる', async ({ page }) => {
  await page.setContent(`<!doctype html>
<html lang="en">
  <head>
    <title>Edge</title>
    <style>
      body { margin: 0; }
      button { padding: 0; border: 0; width: 44px; height: 44px; }
      .edge { position: absolute; left: 0; top: 100px; width: 20px; }
      .edge::after { content: ""; position: absolute; left: 50%; top: 50%; width: 44px; height: 44px; transform: translate(-50%, -50%); }
    </style>
  </head>
  <body>
    <button type="button" class="edge">E</button>
    <div style="height: 3000px"></div>
    <button type="button" class="far">F</button>
    <button type="button" class="far-small" style="width: 20px; height: 20px">S</button>
  </body>
</html>`);
  // 左端に接した幅 20px のボタンは、::after で左右に 12px ずつ広げ、左へ広げた分は画面の外に出る。中心から左へ 21px の点は
  // 画面の外（x = -11）になるので、画面の内側（x = 0）に寄せて調べ、通る。下の 20px のボタンは送ってから調べて落ちる
  expect((await findTargetSizeViolations(page)).map((violation) => violation.target)).toEqual(['button.far-small']);
  // 調べた後は、元の位置に戻す
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('調べるために送った入れ物の中の位置も、調べた後に元へ戻す', async ({ page }) => {
  await page.setContent(`<!doctype html>
<html lang="en">
  <head><title>Inner scroll</title><style>body { margin: 0; } button { width: 44px; height: 44px; }</style></head>
  <body>
    <div class="pane" style="height: 200px; overflow-y: auto">
      <div style="height: 1000px"></div>
      <button type="button">B</button>
    </div>
  </body>
</html>`);
  expect(await findTargetSizeViolations(page)).toEqual([]);
  expect(await page.locator('.pane').evaluate((element) => element.scrollTop)).toBe(0);
});

test('横に送る設計の一覧に無い入れ物（縦にだけスクロールさせる箱）の中のはみ出しを、入れ物ごと拾う', async ({
  page,
}) => {
  // overflow-y を auto にすると、overflow-x の計算値も auto になる。引き出しや dialog の中のはみ出しが、ここで空振りしていた
  await page.setContent(`<!doctype html>
<html lang="en">
  <head><title>Pane</title><style>body { margin: 0; }</style></head>
  <body>
    <div class="pane" style="height: 200px; overflow-y: auto">
      <span style="display: inline-block; white-space: nowrap; width: 900px">Long line</span>
    </div>
  </body>
</html>`);
  expect((await findOverflowViolations(page)).map((violation) => `${violation.rule} ${violation.target}`)).toEqual([
    'overflow div.pane',
  ]);
});

test('前後に数文字しかない小さな単独のリンク（「キー: x」）は、文中のリンクと見ずに数えて落とす', async ({ page }) => {
  await page.setContent(`<!doctype html>
<html lang="en">
  <head><title>Key</title><style>body { margin: 0; padding: 40px; }</style></head>
  <body><p>キー: <a href="#k">x</a></p></body>
</html>`);
  expect((await findTargetSizeViolations(page)).map((violation) => violation.target)).toEqual(['a']);
});

test('押せる要素も文字を持つ要素も1つも数えなかった組み合わせがあれば、入口が落ちる', async ({ page }) => {
  // 画面が描けていないまま測ると、違反が0件で通ってしまう
  await page.setContent(
    `<!doctype html><html lang="en"><head><title>Empty</title></head><body><div></div></body></html>`,
  );
  const check = createLayoutCheck('today', []);
  await check.inThemes(page, 'ゲーム');
  expect(() => check.finish()).toThrow(
    /\[today\] 押せる要素を 1 つも数えなかった組み合わせがある: simple_light・ゲーム、medieval・ゲーム、modern・ゲーム/,
  );
  expect(() => check.finish()).toThrow(/文字を持つ要素を 1 つも数えなかった組み合わせがある: simple_light・ゲーム、/);
});

test('selectorOf は、html に当たったとき html を返す', async ({ page }) => {
  // body を画面の高さより低くし、下の余白（html だけがある所）に 20px のボタンの 44px 四方の点を出す
  await page.setContent(`<!doctype html>
<html lang="en">
  <head><title>Root</title><style>html { height: 100%; } body { margin: 0; height: 40px; } button { width: 20px; height: 20px; margin: 20px; padding: 0; border: 0; }</style></head>
  <body><button type="button">B</button></body>
</html>`);
  const [violation] = await findTargetSizeViolations(page);
  expect(violation!.detail).toContain('下（30, 51）は html');
});

test('除外は、その種類の当たった要素だけを外し、当たらなかった除外を拾う', async ({ page }) => {
  await page.setContent(BROKEN);
  const violations = [...(await findOverflowViolations(page)), ...(await findTargetSizeViolations(page))];
  const hit: UiExclusion = { check: 'target-44', selector: '.small', screen: 'today', reason: '確かめ', issue: 1 };
  // 同じ要素でも種類が違う除外は外さない
  const otherCheck: UiExclusion = {
    check: 'overflow',
    selector: '.small',
    screen: 'today',
    reason: '確かめ',
    issue: 1,
  };
  // どの要素にも当たらない除外
  const missing: UiExclusion = { check: 'overflow', selector: '.gone', screen: 'today', reason: '確かめ', issue: 1 };
  const list = [hit, otherCheck, missing];
  const { remaining, used } = await excludeKnownViolations(page, violations, list);
  expect(remaining.map((violation) => `${violation.rule} ${violation.target}`)).toEqual([
    'overflow html',
    'overflow div.wide',
  ]);
  expect([...used]).toEqual([hit]);
  expect(staleExclusions('today', isLayoutCheck, used, list)).toEqual([otherCheck, missing]);
});

test('画面のテストの入口は、テーマと言葉の組み合わせで出た違反をまとめて落ち、当たらなくなった除外だけでも落ちる', async ({
  page,
}) => {
  await page.setContent(BROKEN);
  // 除外が無ければ、3つの違反を出た組み合わせとともに並べて落ちる
  const bare = createLayoutCheck('today', []);
  await bare.inThemes(page, 'ゲーム');
  await bare.inThemes(page, 'スクラム');
  expect(() => bare.finish()).toThrow(
    /\[today\] 狭い幅（390px）の違反が 3 件ある[\s\S]*- target-44: button\.small（simple_light・ゲーム、medieval・ゲーム、modern・ゲーム、simple_light・スクラム、medieval・スクラム、modern・スクラム）\n {2}見た目の箱は 30×30px/,
  );
  expect(() => bare.finish()).toThrow(/- overflow: div\.wide（simple_light・ゲーム、/);
  // 違反をすべて除外で外せば通る
  const covering: UiExclusion[] = [
    { check: 'overflow', selector: 'html', screen: 'today', reason: '確かめ', issue: 1 },
    { check: 'overflow', selector: '.wide', screen: 'today', reason: '確かめ', issue: 1 },
    { check: 'target-44', selector: '.small', screen: 'today', reason: '確かめ', issue: 1 },
  ];
  const covered = createLayoutCheck('today', covering);
  await covered.inThemes(page, 'ゲーム');
  covered.finish();
  // どれにも当たらない除外が残れば落ちる
  const missing: UiExclusion = { check: 'target-44', selector: '.gone', screen: 'today', reason: '確かめ', issue: 1 };
  const stale = createLayoutCheck('today', [...covering, missing]);
  await stale.inThemes(page, 'ゲーム');
  expect(() => stale.finish()).toThrow(/当たらなくなった除外が 1 件ある。[\s\S]*- today target-44 \.gone/);
});
