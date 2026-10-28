import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Locator, type Page, type Response } from '@playwright/test';
import { SEED_SESSIONS } from '../seed/sessions.ts';
import { organizationInfo } from '../src/shared/operations/organization/organization.ts';
import { workspaceInfo } from '../src/shared/operations/workspace/workspace.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { word, type DictionaryKey, type TemplateParams, type Vocabulary } from '../src/shared/vocabulary.ts';
import { rewriteOperation } from './operations.ts';
import {
  exclusionsFor,
  formatStaleExclusions,
  isAxeCheck,
  isLayoutCheck,
  type UiExclusion,
  type UiScreen,
} from './ui-exclusions.ts';

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

// 違反のうち、除外の一覧の要素に当たるものを外す。used は、実際に要素を外した除外。
// axe の違反と、狭い幅の検査（44px の押せる範囲、はみ出し）の違反の両方に使う
export async function excludeKnownViolations<V extends { rule: string; target: string }>(
  page: Page,
  violations: readonly V[],
  exclusions: readonly UiExclusion[],
): Promise<{ remaining: V[]; used: Set<UiExclusion> }> {
  const used = new Set<UiExclusion>();
  const remaining: V[] = [];
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

// ---- 狭い幅の検査（#336）。44px の押せる範囲と、横のはみ出し ----

// 狭い幅の検査の違反。rule は検査の種類（除外の一覧の check と同じ）、target は要素の短く一意なセレクタ、
// detail は何が起きたか（当たった別の要素、右端の位置など）
export interface LayoutViolation {
  rule: 'target-44' | 'overflow';
  target: string;
  detail: string;
}

// 押せる範囲の一辺。docs/design.md の「押せる範囲」。760px 以下か pointer: coarse で効く
export const TARGET_SIZE = 44;

// 幅 390px の画面。高さは、よくあるスマホの縦置きの値にする
export const NARROW_VIEWPORT = { width: 390, height: 844 };

// 見えている押せる要素について、中心と、中心から上下左右と斜めに 21px の点を document.elementFromPoint で調べ、
// 要素自身か子孫（入力欄は結び付いた label も）に当たることを確かめる。見た目を小さく保ち ::before と ::after で
// 押せる範囲を広げた部品は、疑似要素に当たると要素自身が返るので通る。
// 数えないもの: inert の中（引き出しの後ろの画面）、見えないもの（checkVisibility が偽、幅か高さが 0）、文中のリンク
// （下の inSentence）。disabled と aria-disabled は数える。折り返した inline の要素は、行の箱のうち一番大きいものの中心から調べる。
// 点が画面の外に出るときは画面の内側に寄せる（画面の端より外は押せない）。画面の外の要素は scrollIntoView で中央へ入れ、
// 調べた後は、動かした window と祖先の入れ物の位置を元に戻す
export async function findTargetSizeViolations(page: Page): Promise<LayoutViolation[]> {
  return (await measureLayout(page, 'target-44')).violations;
}

// ページ全体が横に動かない（scrollWidth が画面の幅以下）ことと、文字を持つ要素（文字のノードを直に持つ要素と入力欄）の
// 右端が画面の右端を越えないことを確かめる。横に送る設計の入れ物（LAYOUT_SCROLL_CONTAINERS）の中は、中で横に送れるので許す。
// ほかの入れ物（overflow-x が hidden、clip、auto、scroll）の中は、入れ物の右端で切った位置で見る。そのうちスクロールする入れ物
// （auto、scroll）は、入れ物そのものが横にはみ出している（scrollWidth が clientWidth を越える）ことも違反にする。
// overflow-y を auto にした箱は overflow-x の計算値も auto になるので、縦にだけスクロールさせる引き出しや dialog もここに入る。
// inert の中と見えないものは数えない
export async function findOverflowViolations(page: Page): Promise<LayoutViolation[]> {
  return (await measureLayout(page, 'overflow')).violations;
}

// 横に送る設計の入れ物。design/components.css で overflow-x: auto を明示しているもの。中の要素が画面の右端を越えても、
// 入れ物の中で横に送れるので許す（組織の管理のワークスペースの表、狭い幅の上の帯のメニュー、Markdown の本文の表とコードなど）。
// 部品を足して横に送る入れ物を作ったら、ここにも足す
export const LAYOUT_SCROLL_CONTAINERS = [
  '.table-wrap',
  '.board-wrap',
  '.nav',
  '.doc-box',
  '.doc-box pre',
  '.doc-table',
];

// 2つの検査は、要素のセレクタの作り方を共有するので、1つの evaluate にまとめる。counted は調べた要素の数
// （押せる要素か、文字を持つ要素）。0 件なら画面が描けていないまま測ったことになる（createLayoutCheck が落とす）
async function measureLayout(
  page: Page,
  rule: LayoutViolation['rule'],
): Promise<{ violations: LayoutViolation[]; counted: number }> {
  return page.evaluate(
    ({ rule, size, scrollContainers }) => {
      const root = document.documentElement;
      // 短く一意なセレクタ。id、なければ class（Svelte の svelte- は除く）と、要るときだけ :nth-of-type を、一意になるまで上へ足す
      // $props.id() の作る id（c12、c12-due など）は、描く順で変わるので使わない
      const generatedId = /^c\d+(-|$)/;
      const selectorOf = (element: Element): string => {
        const parts: string[] = [];
        for (let node: Element | null = element; node !== null && node !== root; node = node.parentElement) {
          if (
            node.id !== '' &&
            !generatedId.test(node.id) &&
            document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1
          ) {
            parts.unshift(`#${CSS.escape(node.id)}`);
            return parts.join(' > ');
          }
          let part =
            node.localName +
            [...node.classList]
              .filter((name) => !name.startsWith('svelte-'))
              .map((name) => `.${CSS.escape(name)}`)
              .join('');
          const parent = node.parentElement;
          if (parent !== null) {
            const current = part;
            const siblings = [...parent.children].filter((child) => child.matches(current));
            if (siblings.length > 1) {
              const sameTag = [...parent.children].filter((child) => child.localName === node!.localName);
              part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
            }
          }
          parts.unshift(part);
          const candidate = parts.join(' > ');
          if (document.querySelectorAll(candidate).length === 1) return candidate;
        }
        // html そのもの（body の外の余白に当たったときなど）は、上の繰り返しに入らない
        return parts.length === 0 ? 'html' : parts.join(' > ');
      };
      const visible = (element: Element): boolean => {
        if (element.closest('[inert]') !== null) return false;
        if (!element.checkVisibility({ visibilityProperty: true })) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const viewportWidth = root.clientWidth;
      const viewportHeight = root.clientHeight;
      const round = (value: number): number => Math.round(value * 10) / 10;
      const violations: { rule: typeof rule; target: string; detail: string }[] = [];

      if (rule === 'overflow') {
        if (root.scrollWidth > viewportWidth) {
          violations.push({
            rule,
            target: 'html',
            detail: `ページの幅 ${root.scrollWidth}px が画面の幅 ${viewportWidth}px を越え、横に動く`,
          });
        }
        // 祖先の overflow-x を一度だけ読む
        const overflowOf = new Map<Element, string>();
        const overflowX = (element: Element): string => {
          let value = overflowOf.get(element);
          if (value === undefined) {
            value = getComputedStyle(element).overflowX;
            overflowOf.set(element, value);
          }
          return value;
        };
        const allowed = scrollContainers.join(', ');
        let counted = 0;
        for (const element of document.body.querySelectorAll('*')) {
          if (!visible(element)) continue;
          // 横に送る設計に無いスクロールする入れ物は、入れ物そのものが横にはみ出していれば違反にする（小数の丸めの差は見ない）
          const own = overflowX(element);
          if ((own === 'auto' || own === 'scroll') && !element.matches(allowed)) {
            if (element.scrollWidth > element.clientWidth + 0.5) {
              violations.push({
                rule,
                target: selectorOf(element),
                detail: `中身の幅 ${element.scrollWidth}px が入れ物の幅 ${element.clientWidth}px を越え、中で横に送れる（横に送る設計なら LAYOUT_SCROLL_CONTAINERS に足す）`,
              });
            }
          }
          const textual =
            element.matches('input:not([type="hidden"]), select, textarea') ||
            [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim() !== '');
          if (!textual) continue;
          counted++;
          let right = element.getBoundingClientRect().right;
          let scrolls = false;
          for (
            let ancestor = element.parentElement;
            ancestor !== null && ancestor !== root;
            ancestor = ancestor.parentElement
          ) {
            const value = overflowX(ancestor);
            if (value === 'visible') continue;
            if ((value === 'auto' || value === 'scroll') && ancestor.matches(allowed)) {
              scrolls = true;
              break;
            }
            right = Math.min(right, ancestor.getBoundingClientRect().right);
          }
          // 小数の丸めの差は見ない
          if (!scrolls && right > viewportWidth + 0.5) {
            violations.push({
              rule,
              target: selectorOf(element),
              detail: `右端 ${round(right)}px が画面の右端 ${viewportWidth}px を越える（「${(element.textContent ?? '').trim().slice(0, 20)}」）`,
            });
          }
        }
        return { violations, counted };
      }

      const scrollX = window.scrollX;
      const scrollY = window.scrollY;
      const candidates = document.querySelectorAll(
        [
          'button',
          'a[href]',
          'input:not([type="hidden"])',
          'select',
          'textarea',
          'summary',
          '[role="button"]',
          '[role="link"]',
          '[role="checkbox"]',
          '[role="radio"]',
          '[role="switch"]',
          '[role="tab"]',
          '[role="menuitem"]',
        ].join(', '),
      );
      // 文中のリンク（WCAG 2.5.8 の例外）。Markdown の本文（.doc-box）の中のリンクと、inline のリンクのうち、文の入れ物
      // （p、li、dd、td、label）の中にあって、入れ物の自分以外の文字が 5 文字以上あるもの。「キー: x」のように前後に数文字しか
      // 無い単独のリンクや、文の入れ物の外（div の直下など）のリンクは、文中と見ずに数える。
      // 数える文字は、自分を含めて入れ物の中のリンクとボタンの文字を除いたもの（リンクだけが並ぶ li を文と見ないため）
      const sentenceMinimum = 5;
      const inSentence = (element: Element): boolean => {
        if (!element.matches('a, [role="link"]')) return false;
        if (element.closest('.doc-box') !== null) return true;
        if (getComputedStyle(element).display !== 'inline') return false;
        const container = element.parentElement?.closest('p, li, dd, td, label');
        if (container === null || container === undefined) return false;
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        let others = '';
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          if (node.parentElement?.closest('a, button, [role="link"], [role="button"]') === null)
            others += node.textContent ?? '';
        }
        return [...others.replace(/\s/g, '')].length >= sentenceMinimum;
      };
      // 調べる箱。入力欄を包む label は、全体が押せる範囲なので label の箱にする（区切りのボタン .segmented の選択肢は、
      // 見えない input が既定の余白の分だけ label より小さく、中心もずれる）。折り返した inline の要素は、外接の箱の中心が
      // 行の間に落ちるので、行の箱（getClientRects）のうち一番大きいものにする
      const boxOf = (element: Element, labels: readonly HTMLLabelElement[]): DOMRect => {
        const target = labels.find((label) => label.contains(element)) ?? element;
        const rects = [...target.getClientRects()];
        if (rects.length < 2) return target.getBoundingClientRect();
        return rects.reduce((largest, rect) =>
          rect.width * rect.height > largest.width * largest.height ? rect : largest,
        );
      };
      // scrollIntoView で動いた入れ物を、調べた後に元へ戻すため、祖先の入れ物の位置を初めて見たときに控える
      const scrolled = new Map<Element, [number, number]>();
      const remember = (element: Element): void => {
        for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
          if (ancestor === root || ancestor === document.body || scrolled.has(ancestor)) continue;
          scrolled.set(ancestor, [ancestor.scrollLeft, ancestor.scrollTop]);
        }
      };
      // 四隅は、44px の円の上（中心から斜めに reach）の点にする。角を丸めた 44px のボタンは、箱の角の点では丸みの外に出て
      // 外れるため。縦と横の大きさは、上下左右の点で確かめる（reach が 21px なので、43px 前後の箱は通る）
      const d = Math.SQRT1_2;
      const offsets: [string, number, number][] = [
        ['中心', 0, 0],
        ['左上', -d, -d],
        ['上', 0, -1],
        ['右上', d, -d],
        ['左', -1, 0],
        ['右', 1, 0],
        ['左下', -d, d],
        ['下', 0, 1],
        ['右下', d, d],
      ];
      const clamp = (value: number, max: number): number => Math.min(Math.max(value, 0), max - 1);
      let counted = 0;
      for (const element of candidates) {
        if (!visible(element) || inSentence(element)) continue;
        counted++;
        const labels = [...((element as HTMLInputElement).labels ?? [])];
        remember(element);
        (labels.find((label) => label.contains(element)) ?? element).scrollIntoView({
          block: 'center',
          inline: 'nearest',
          behavior: 'instant',
        });
        const rect = boxOf(element, labels);
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const misses: string[] = [];
        // 44px 四方の端の線の上の点は、ちょうど 44px の箱の外になるので、内側へ 1px 入れた点を調べる
        const reach = size / 2 - 1;
        for (const [name, dx, dy] of offsets) {
          const x = clamp(centerX + dx * reach, viewportWidth);
          const y = clamp(centerY + dy * reach, viewportHeight);
          const hit = document.elementFromPoint(x, y);
          if (hit !== null && (element.contains(hit) || labels.some((label) => label.contains(hit)))) continue;
          misses.push(`${name}（${round(x)}, ${round(y)}）は ${hit === null ? '何もない' : selectorOf(hit)}`);
        }
        if (misses.length > 0) {
          violations.push({
            rule,
            target: selectorOf(element),
            detail: `見た目の箱は ${round(rect.width)}×${round(rect.height)}px。${size}px 四方のうち ${misses.join('、')}`,
          });
        }
      }
      for (const [element, [left, top]] of scrolled) element.scrollTo({ left, top, behavior: 'instant' });
      window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' });
      return { violations, counted };
    },
    { rule, size: TARGET_SIZE, scrollContainers: LAYOUT_SCROLL_CONTAINERS },
  );
}

// 狭い幅の検査で回すテーマ。崩れ方は書体（字幅と行の高さ）で変わり、色では変わらないので、書体の違う3つにする。
// シンプルのダークはライトと書体が同じなので回さない（docs/design.md の「狭い幅と押せる範囲を機械で確かめる」）
export const LAYOUT_THEMES = ['simple_light', 'medieval', 'modern'] as const;

// 言葉づかい。文言の長さで折り返しとはみ出しが変わるので、両方を回す
export const LAYOUT_VOCABULARIES = ['game', 'scrum'] as const satisfies readonly Vocabulary[];
const VOCABULARY_LABEL: Record<Vocabulary, string> = { game: 'ゲーム', scrum: 'スクラム' };

type LayoutFound = LayoutViolation & { combinations: string[] };

// 1つの画面の狭い幅の検査。テーマと言葉の組み合わせを重ねて測り、最後に finish で、残った違反と当たらなくなった除外で落とす。
// 同じ要素の同じ違反は、出た組み合わせをまとめて1件にする。exclusions は、壊した HTML で確かめるときだけ差し替える
export function createLayoutCheck(
  screen: UiScreen,
  exclusions: readonly UiExclusion[] = exclusionsFor(screen, isLayoutCheck),
): { inThemes: (page: Page, label: string) => Promise<void>; finish: () => void } {
  const used = new Set<UiExclusion>();
  const found = new Map<string, LayoutFound>();
  // 押せる要素か文字を持つ要素を1つも数えなかった組み合わせ。画面が描けていないまま測ると、違反が0件で通ってしまう
  const noTargets: string[] = [];
  const noText: string[] = [];
  return {
    // 落ち着いた画面に3つのテーマを順に当て、はみ出しと 44px を測る。label は言葉づかいの名前（落ちたときの文に出す）
    async inThemes(page, label) {
      for (const theme of LAYOUT_THEMES) {
        await applyTheme(page, theme);
        const overflow = await measureLayout(page, 'overflow');
        const targets = await measureLayout(page, 'target-44');
        const violations = [...overflow.violations, ...targets.violations];
        if (overflow.counted === 0) noText.push(`${theme}・${label}`);
        if (targets.counted === 0) noTargets.push(`${theme}・${label}`);
        // 画面の読み直し（組織の枠の applyOrganization）で DB のテーマに戻っていたら、別のテーマを測ったことになる
        const applied = await page.evaluate(() => document.documentElement.dataset.theme);
        if (applied !== theme)
          throw new Error(`[${screen}] テーマ ${theme} を当てたが、狭い幅の検査の後に ${applied} になっていた`);
        const result = await excludeKnownViolations(page, violations, exclusions);
        for (const exclusion of result.used) used.add(exclusion);
        for (const violation of result.remaining) {
          const key = `${violation.rule} ${violation.target}`;
          const combination = `${theme}・${label}`;
          const known = found.get(key);
          if (known) known.combinations.push(combination);
          else found.set(key, { ...violation, combinations: [combination] });
        }
      }
    },
    finish() {
      const failures: string[] = [];
      if (noTargets.length > 0)
        failures.push(`[${screen}] 押せる要素を 1 つも数えなかった組み合わせがある: ${noTargets.join('、')}`);
      if (noText.length > 0)
        failures.push(`[${screen}] 文字を持つ要素を 1 つも数えなかった組み合わせがある: ${noText.join('、')}`);
      if (found.size > 0) failures.push(`[${screen}] ${formatLayoutViolations([...found.values()])}`);
      const stale = exclusions.filter((exclusion) => !used.has(exclusion));
      if (stale.length > 0) failures.push(formatStaleExclusions(stale));
      if (failures.length > 0) throw new Error(failures.join('\n\n'));
    },
  };
}

// 落ちたときに出す文。検査の種類、要素、どの組み合わせで出たか、何が起きたか（最初に出た組み合わせのもの）を並べる
export function formatLayoutViolations(violations: readonly (LayoutViolation & { combinations?: string[] })[]): string {
  return [
    `狭い幅（${NARROW_VIEWPORT.width}px）の違反が ${violations.length} 件ある（直せないものは e2e/ui-exclusions.ts に理由と Issue の番号つきで置く）:`,
    ...violations.map((violation) =>
      [
        `- ${violation.rule}: ${violation.target}${violation.combinations ? `（${violation.combinations.join('、')}）` : ''}`,
        `  ${violation.detail}`,
      ].join('\n'),
    ),
  ].join('\n');
}

// 組織とワークスペースの言葉づかいを、organization と workspace の操作の応答の書き換えで当てる（DB は書き換えない。
// ほかのファイルと並べて走るため）。張った route を外す関数を返す。画面を開く前に呼ぶ
export async function useVocabulary(page: Page, slug: string, vocabulary: Vocabulary): Promise<() => Promise<void>> {
  const unrouteOrganization = await rewriteOperation(page, organizationInfo, { slug }, (output) => ({
    ...output,
    organization: { ...output.organization, vocabulary },
  }));
  const unrouteWorkspace = await rewriteOperation(page, workspaceInfo, { slug }, (output) => ({
    ...output,
    vocabulary,
  }));
  return async () => {
    await unrouteOrganization();
    await unrouteWorkspace();
  };
}

// 狭い幅の検査で開く組織（seed のあおば開発）。主な画面はどれもこの組織の中にある
const NARROW_LAYOUT_SLUG = 'aoba';

// 主な画面を幅 390px で、言葉2つ × テーマ3つの組み合わせで開き、横のはみ出しと 44px の押せる範囲を確かめる。
// open は画面を開き、落ち着いたとみなす要素を待つ。w はその言葉づかいの辞書の文言（見出しの名前などに使う）。
// 開いた後、要求が止み、見えている所の読み込みが終わり、上の帯の組織の言葉が当てた言葉づかいになってから測る
export async function expectNarrowLayout(
  page: Page,
  screen: UiScreen,
  open: (w: (key: DictionaryKey, params?: TemplateParams) => string) => Promise<void>,
): Promise<void> {
  await page.setViewportSize(NARROW_VIEWPORT);
  const check = createLayoutCheck(screen);
  for (const vocabulary of LAYOUT_VOCABULARIES) {
    const unroute = await useVocabulary(page, NARROW_LAYOUT_SLUG, vocabulary);
    const vocabularies = { workspace: vocabulary, organization: vocabulary };
    await open((key, params) => word(key, vocabularies, params));
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0);
    // 書き換えが効かずにゲームの言葉のまま測ると、スクラムの言葉を測ったことにならない
    await expect(page.locator('.org-menu-label')).toHaveText(word('organization', vocabularies));
    await check.inThemes(page, VOCABULARY_LABEL[vocabulary]);
    await unroute();
  }
  check.finish();
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

// 開いた画面の読み込みが終わるまで待つ。読み込みで行が動いている間に押すと、Playwright は押し直す前に画面をスクロールするので、
// 撮る画像のスクロールの位置が実行ごとに変わる（#354）。テストの終わりに背景の画面が写るとき（ダイアログを開くなど）は、押す前に呼ぶ
export async function waitForSettled(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0);
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

// ダイアログと引き出しのフォーカスの決まりを確かめる。opener を押すと modal が開いて中にフォーカスが入り、Esc で閉じ、
// 閉じたらフォーカスが returnTo（無ければ opener）にあり、2回描画した後も留まる。空振りしないよう、開く前に modal が見えていないことから確かめ、
// 最後の留まる確かめを除き、どの段も待ってから確かめる（e2e/modal-focus.test.ts が、壊れたダイアログでそれぞれの段が落ちることを確かめる）。
// 2回の描画より長く留まってから外れるフォーカスは捕まえない。
// press を渡すと、opener にフォーカスを置いてそのキーで開く（キーボードだけで開く確かめ）。
// whileOpen は、開いている間に足して確かめるもの。timeout は各段の待ち（既定は expect の既定）
export async function expectModalFocus(
  page: Page,
  {
    opener,
    modal,
    returnTo,
    press,
    whileOpen,
    timeout,
  }: {
    opener: Locator;
    modal: Locator;
    returnTo?: Locator;
    press?: string;
    whileOpen?: () => Promise<void>;
    timeout?: number;
  },
): Promise<void> {
  await expect(modal, '開く前からモーダルが見えている').toBeHidden({ timeout });
  if (press === undefined) {
    await opener.click({ timeout });
  } else {
    await opener.focus({ timeout });
    await page.keyboard.press(press);
  }
  await expect(modal, 'モーダルが開かない').toBeVisible({ timeout });
  await expect
    .poll(() => modal.evaluate((element) => element.contains(document.activeElement)), {
      message: 'モーダルの中にフォーカスが入らない',
      timeout,
    })
    .toBe(true);
  await whileOpen?.();
  await page.keyboard.press('Escape');
  await expect(modal, 'Esc で閉じない').toBeHidden({ timeout });
  const target = returnTo ?? opener;
  await expect(target, '閉じたらフォーカスが戻らない').toBeFocused({ timeout });
  // Chromium の <dialog> は close() の中で開いたボタンへフォーカスを戻し、close イベントは後のタスクで出す。
  // close イベントで別の場所へ移すダイアログでも、その前の一瞬は戻る先にフォーカスがあり、上の確かめが通ってしまう。
  // 2回描画を待った後に、まだ戻る先にあることを待たずに確かめる。描画が止まったページで待ち続けないよう、
  // timeout（無ければ expect の既定と同じ 5 秒）で待ちを切る
  await page.evaluate(
    (limit) =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
        setTimeout(resolve, limit);
      }),
    timeout ?? 5000,
  );
  expect(
    await target.evaluate((element) => element === document.activeElement, undefined, { timeout }),
    '閉じたらフォーカスが戻らない（一瞬戻ってすぐ外れる）',
  ).toBe(true);
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

// path（'/task-move' など）で終わる要求の応答が、仕掛けてから count 件目に返るまで待つ。書き込む操作の前に呼んで（ここで await しない）、
// 返った promise を読み直す前に await する。
// waitForLoadState('networkidle') は、画面の読み込みの後に飛んだ要求を待たずに返るので、書き込みの後の読み直しには使わない。
// 並べ替えと親の移動は前の応答の後に次を送る（src/lib/move-queue.ts）ので、続けて動かしたときは件数で最後の応答を待つ
export function waitForResponses(page: Page, path: string, count = 1): Promise<Response> {
  let seen = 0;
  const pending = page.waitForResponse(
    (response) => new URL(response.url()).pathname.endsWith(path) && ++seen === count,
  );
  // await より前でテストが落ちると、画面を閉じたときにこの待ちが reject し、元の失敗に別のエラーが重なる。
  // await したときは、この catch と関わりなく失敗が伝わる
  void pending.catch(() => {});
  return pending;
}
