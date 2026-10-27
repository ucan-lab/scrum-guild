// axe の検査の関数（e2e/helpers.ts）と除外の一覧（e2e/ui-exclusions.ts）が空振りしないことを確かめる（#334）。
// 壊した小さな HTML を page.setContent で置き、違反を拾って落ちることを見る。
// 日本語の文字を測れる環境かは、本物の画面（seed のセッションで読むだけ）で確かめる
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures.ts';
import {
  excludeKnownViolations,
  expectNoA11yViolations,
  expectNoA11yViolationsInThemes,
  findA11yViolations,
  signIn,
} from './helpers.ts';
import {
  isAxeCheck,
  nonAxeChecks,
  staleExclusions,
  uiExclusions,
  uiScreens,
  type UiExclusion,
} from './ui-exclusions.ts';

// aria-label の無いアイコンだけのボタンと、背景との差が足りない文字（#999 と #aaa）。
// 文字は英字にする。この HTML は画面の書体を持たないので、日本語の書体の無い環境（CI のランナー）では日本語が描けず、
// axe がコントラストを測らない（日本語を測れることは、下の本物の画面のテストが確かめる）
const BROKEN = `<!doctype html>
<html lang="en">
  <head><title>Broken</title></head>
  <body>
    <main>
      <h1>Broken</h1>
      <button type="button" class="icon-only"><svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6" /></svg></button>
      <p class="faint" style="color: #999; background: #aaa">Faint text</p>
    </main>
  </body>
</html>`;

test('アイコンだけのボタンとコントラストの足りない文字を、違反として拾い、落ちる', async ({ page }) => {
  await page.setContent(BROKEN);
  const violations = await findA11yViolations(page);
  // 要素のセレクタは、axe がその画面で一意に決まる短いものを選ぶ
  expect(violations.map((violation) => `${violation.rule} ${violation.target}`).sort()).toEqual([
    'button-name button',
    'color-contrast p',
  ]);
  // 落ちたときの文は、規則、要素、要約を出す
  await expect(expectNoA11yViolations(page, 'today')).rejects.toThrow(/- button-name: button\n {2}Buttons must/);
  await expect(expectNoA11yViolations(page, 'today')).rejects.toThrow(/- color-contrast: p\n {2}Elements must/);
});

// 日本語の書体が無い環境では、axe は日本語の文字のコントラストを測らずに通す。本物の画面の日本語の見出しが
// color-contrast の判定（合格、違反、保留のどれか）に入ることを確かめ、測れていない環境で走らせたことに気づく
test('本物の画面の日本語の見出しを、axe が文字のコントラストの判定にかける', async ({ page, context, baseURL }) => {
  await signIn(context, baseURL, 'admin');
  await page.goto('/aoba');
  await expect(page.getByRole('heading', { level: 1, name: '自分の今日' })).toBeVisible();
  const results = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
  const judged = [...results.passes, ...results.violations, ...results.incomplete]
    .filter((result) => result.id === 'color-contrast')
    .flatMap((result) => result.nodes.map((node) => node.html));
  expect(
    judged.some((html) => html.startsWith('<h1') && html.includes('自分の今日')),
    judged.join('\n'),
  ).toBe(true);
});

test('除外は、その規則の当たった要素だけを外し、当たらなかった除外を拾う', async ({ page }) => {
  await page.setContent(BROKEN);
  const violations = await findA11yViolations(page);
  const hit: UiExclusion = {
    check: 'button-name',
    selector: '.icon-only',
    screen: 'today',
    reason: '確かめ',
    issue: 1,
  };
  // 同じ要素でも規則が違う除外は外さない
  const otherRule: UiExclusion = {
    check: 'image-alt',
    selector: '.icon-only',
    screen: 'today',
    reason: '確かめ',
    issue: 1,
  };
  // どの要素にも当たらない除外
  const missing: UiExclusion = {
    check: 'color-contrast',
    selector: '.gone',
    screen: 'today',
    reason: '確かめ',
    issue: 1,
  };
  const list = [hit, otherRule, missing];
  const { remaining, used } = await excludeKnownViolations(page, violations, list);
  expect(remaining.map((violation) => violation.rule)).toEqual(['color-contrast']);
  expect([...used]).toEqual([hit]);
  expect(staleExclusions('today', isAxeCheck, used, list)).toEqual([otherRule, missing]);
});

test('画面のテストの入口は、4つのテーマで出た違反をまとめて落ち、当たらなくなった除外だけでも落ちる', async ({
  page,
}) => {
  await page.setContent(BROKEN);
  // 除外が無ければ、2つの違反を出たテーマとともに並べて落ちる
  await expect(expectNoA11yViolationsInThemes(page, 'today', [])).rejects.toThrow(
    /- button-name: button（simple_light、simple_dark、medieval、modern）/,
  );
  await expect(expectNoA11yViolationsInThemes(page, 'today', [])).rejects.toThrow(/- color-contrast: p（/);
  // 違反をすべて除外で外しても、どれにも当たらない除外が残れば落ちる
  const covering: UiExclusion[] = [
    { check: 'button-name', selector: '.icon-only', screen: 'today', reason: '確かめ', issue: 1 },
    { check: 'color-contrast', selector: '.faint', screen: 'today', reason: '確かめ', issue: 1 },
  ];
  await expectNoA11yViolationsInThemes(page, 'today', covering);
  const missing: UiExclusion = {
    check: 'color-contrast',
    selector: '.gone',
    screen: 'today',
    reason: '確かめ',
    issue: 1,
  };
  await expect(expectNoA11yViolationsInThemes(page, 'today', [...covering, missing])).rejects.toThrow(
    /当たらなくなった除外が 1 件ある。[\s\S]*- today color-contrast \.gone/,
  );
});

test('除外の一覧の検査の種類は、axe の規則の ID か target-44 か overflow で、理由と Issue の番号がある', async ({
  page,
}) => {
  // axe を差し込んだ後で、axe の規則の一覧を読む
  await page.setContent(BROKEN);
  await findA11yViolations(page);
  const ruleIds = await page.evaluate(() =>
    (window as unknown as { axe: { getRules: () => { ruleId: string }[] } }).axe.getRules().map((rule) => rule.ruleId),
  );
  for (const exclusion of uiExclusions) {
    expect([...ruleIds, ...nonAxeChecks], `${exclusion.screen} ${exclusion.selector}`).toContain(exclusion.check);
    expect(uiScreens).toContain(exclusion.screen);
    expect(exclusion.reason.trim()).not.toBe('');
    expect(exclusion.issue).toBeGreaterThan(0);
  }
});

// 理由か Issue の番号の無い除外は、型の検査（pnpm check）で落ちる
// @ts-expect-error reason が無い
const withoutReason: UiExclusion = { check: 'button-name', selector: '.x', screen: 'today', issue: 1 };
// @ts-expect-error issue が無い
const withoutIssue: UiExclusion = { check: 'button-name', selector: '.x', screen: 'today', reason: '確かめ' };
void [withoutReason, withoutIssue];
