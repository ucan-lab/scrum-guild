import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { SEED_SESSIONS } from '../seed/sessions.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { exclusionsFor, formatStaleExclusions, isAxeCheck, type UiExclusion, type UiScreen } from './ui-exclusions.ts';

// axe で確かめる規則。WCAG 2.2 の A と AA（文字のコントラストを含む）。best-practice は入れない（#320）
export const A11Y_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

export interface A11yViolation {
  rule: string;
  // axe が出す要素のセレクタ
  target: string;
  // 規則の要約（axe の help）と、その要素で何が足りないか（axe の failureSummary）
  help: string;
  summary: string;
  helpUrl: string;
}

// 今の画面に axe を走らせ、違反を要素ごとに並べて返す
export async function findA11yViolations(page: Page): Promise<A11yViolation[]> {
  return (await runA11y(page)).violations;
}

// undecided は、axe が判定を保留した（incomplete の）文字のコントラストの要素の数。
// 地のグラデーションの上の文字などで、違反に数えないので別に返す
async function runA11y(page: Page): Promise<{ violations: A11yViolation[]; undecided: number }> {
  const results = await new AxeBuilder({ page }).withTags(A11Y_TAGS).analyze();
  const undecided = results.incomplete
    .filter((result) => result.id === 'color-contrast')
    .reduce((sum, result) => sum + result.nodes.length, 0);
  const violations = results.violations.flatMap((violation) =>
    violation.nodes.map((node) => ({
      rule: violation.id,
      target: node.target.map((part) => (Array.isArray(part) ? part.join(' >>> ') : part)).join(' '),
      help: violation.help,
      summary: node.failureSummary ?? '',
      helpUrl: violation.helpUrl,
    })),
  );
  return { violations, undecided };
}

// 違反のうち、除外の一覧の要素に当たるものを外す。used は、実際に要素を外した除外
export async function excludeKnownViolations(
  page: Page,
  violations: readonly A11yViolation[],
  exclusions: readonly UiExclusion[],
): Promise<{ remaining: A11yViolation[]; used: Set<UiExclusion> }> {
  const used = new Set<UiExclusion>();
  const remaining: A11yViolation[] = [];
  for (const violation of violations) {
    const candidates = exclusions.filter((exclusion) => exclusion.check === violation.rule);
    const matched = await page.evaluate(
      ({ target, selectors }) => {
        const element = document.querySelector(target);
        return selectors.map((selector) => element !== null && element.matches(selector));
      },
      { target: violation.target, selectors: candidates.map((exclusion) => exclusion.selector) },
    );
    const hits = candidates.filter((_, index) => matched[index]);
    for (const hit of hits) used.add(hit);
    if (hits.length === 0) remaining.push(violation);
  }
  return { remaining, used };
}

// 落ちたときに出す文。規則、要素、どのテーマで出たか、何が足りないかを並べ、直す所を探しやすくする
export function formatA11yViolations(violations: readonly (A11yViolation & { themes?: string[] })[]): string {
  return [
    `axe の違反が ${violations.length} 件ある（直せないものは e2e/ui-exclusions.ts に理由と Issue の番号つきで置く）:`,
    ...violations.map((violation) =>
      [
        `- ${violation.rule}: ${violation.target}${violation.themes ? `（${violation.themes.join('、')}）` : ''}`,
        `  ${violation.help}`,
        `  ${violation.summary.replaceAll('\n', '\n  ')}`,
        `  ${violation.helpUrl}`,
      ].join('\n'),
    ),
  ].join('\n');
}

// 今の画面に axe を走らせ、その画面の除外の要素を外した違反と、実際に要素を外した除外を返す
export async function checkA11y(
  page: Page,
  screen: UiScreen,
): Promise<{ remaining: A11yViolation[]; used: Set<UiExclusion> }> {
  return excludeKnownViolations(page, await findA11yViolations(page), exclusionsFor(screen, isAxeCheck));
}

// 今の画面に axe を走らせ、その画面の除外を外して違反が0件であることを確かめる
export async function expectNoA11yViolations(page: Page, screen: UiScreen): Promise<void> {
  const { remaining } = await checkA11y(page, screen);
  if (remaining.length > 0) throw new Error(formatA11yViolations(remaining));
}

// axe で確かめるテーマ。コントラストはテーマで変わり、言葉ではほぼ変わらないので、言葉はゲームの言葉だけにする（docs/design.md）
export const A11Y_THEMES = ['simple_light', 'simple_dark', 'medieval', 'modern'] as const;

// 落ち着いた画面に4つのテーマを順に当てて axe を走らせ、違反の無いことと、その画面の除外がどれかのテーマで当たったことを確かめる。
// 同じ要素の同じ違反は、出たテーマをまとめて1件にする。exclusions は、壊した HTML で確かめるときだけ差し替える。
// axe が判定を保留した文字のコントラストの数は、テーマごとにテストの annotation に出す（保留が増えても違反にならないため、見えるようにする）
export async function expectNoA11yViolationsInThemes(
  page: Page,
  screen: UiScreen,
  exclusions: readonly UiExclusion[] = exclusionsFor(screen, isAxeCheck),
): Promise<void> {
  const used = new Set<UiExclusion>();
  const found = new Map<string, A11yViolation & { themes: string[] }>();
  const undecided: string[] = [];
  for (const theme of A11Y_THEMES) {
    await applyTheme(page, theme);
    const run = await runA11y(page);
    // 画面の読み直し（組織の枠の applyOrganization）で DB のテーマに戻っていたら、別のテーマを測ったことになる
    const applied = await page.evaluate(() => document.documentElement.dataset.theme);
    if (applied !== theme)
      throw new Error(`[${screen}] テーマ ${theme} を当てたが、axe の後に ${applied} になっていた`);
    undecided.push(`${theme} ${run.undecided}`);
    const result = await excludeKnownViolations(page, run.violations, exclusions);
    for (const exclusion of result.used) used.add(exclusion);
    for (const violation of result.remaining) {
      const key = `${violation.rule} ${violation.target}`;
      const known = found.get(key);
      if (known) known.themes.push(theme);
      else found.set(key, { ...violation, themes: [theme] });
    }
  }
  test
    .info()
    .annotations.push({ type: 'axe の保留（color-contrast）', description: `${screen}: ${undecided.join('、')}` });
  const failures: string[] = [];
  if (found.size > 0) failures.push(`[${screen}] ${formatA11yViolations([...found.values()])}`);
  const stale = exclusions.filter((exclusion) => !used.has(exclusion));
  if (stale.length > 0) failures.push(formatStaleExclusions(stale));
  if (failures.length > 0) throw new Error(failures.join('\n\n'));
}

// テーマを html の data-theme で当てる（DB は書き換えない。ほかのファイルと並べて走るため）。
// 色の切り替えの transition と書体の読み込みを待ってから返す（途中の色でコントラストを測らないため）
export async function applyTheme(page: Page, theme: string): Promise<void> {
  await page.evaluate(async (value) => {
    document.documentElement.dataset.theme = value;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const finite = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
    await document.fonts.ready;
  }, theme);
}

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
