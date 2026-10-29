// クリア報酬の段階の色（銅、銀、金）のコントラストを、トークンの値から計算して守る。
// 段階の印は地を持たず、地になりうる色の上に直に乗る（docs/design.md の「報酬の段階の色」）。
// e2e の axe は、現代風の面のグラデーションの上の文字を保留にして見ないので、描画に頼らずここで確かめる。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const read = (file: string) => readFileSync(new URL(`../design/${file}`, import.meta.url), 'utf8');

// コメントに残した旧い値や旧いブロックを、読まないよう先に空にする
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const tokens = stripComments(read('tokens.css'));
const components = stripComments(read('components.css'));

const tierNames = ['small', 'medium', 'large'] as const;
const groundNames = ['bg', 'surface', 'sunken', 'rule', 'accent-soft'] as const;
const minimumRatio = 4.5;

// 開き括弧の後ろから、対応する閉じ括弧までの中身を返す
function bodyAfter(source: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(openIndex + 1, i);
  }
  throw new Error('design/tokens.css の波括弧が閉じていない');
}

// セレクタのブロックの中身を返す。:root は共通の値のブロックとシンプル（ライト）の2つがあるので、何番目かを index で選ぶ。
// 数が想定と違えば落とす（CSS は後ろが効くので、重ねて書かれたまま読むと読み間違える）
function readBlock(selector: string, index = 0, expected = 1): string {
  const found: number[] = [];
  for (let at = tokens.indexOf(`${selector} {`); at >= 0; at = tokens.indexOf(`${selector} {`, at + 1)) found.push(at);
  assert.equal(
    found.length,
    expected,
    `design/tokens.css の ${selector} のブロックが ${found.length} 個ある（想定は ${expected} 個。書き方を変えたら、このテストの取り出し方も直す）`,
  );
  return bodyAfter(tokens, found[index] + selector.length + 1);
}

const blocks = {
  'シンプル（ライト）': readBlock(':root', 1, 2),
  'シンプル（ダーク）': readBlock(':root[data-theme="simple_dark"]'),
  中世風: readBlock(':root[data-theme="medieval"]'),
  現代風: readBlock(':root[data-theme="modern"]'),
};

// シンプル（自動）の prefers-color-scheme の側。simple_dark と同じ値を二重に持つ
const autoDarkBlock = (() => {
  const media = tokens.indexOf('@media (prefers-color-scheme: dark)');
  assert.ok(media >= 0, 'design/tokens.css に prefers-color-scheme: dark の @media が見つからない');
  assert.equal(
    tokens.indexOf('@media (prefers-color-scheme: dark)', media + 1),
    -1,
    'design/tokens.css に prefers-color-scheme: dark の @media が2つある。1つにまとめる',
  );
  const inner = bodyAfter(tokens, tokens.indexOf('{', media));
  const selector = ':root:not([data-theme]), :root[data-theme="simple"]';
  const at = inner.indexOf(`${selector} {`);
  assert.ok(at >= 0, `@media (prefers-color-scheme: dark) の中に ${selector} が見つからない`);
  assert.equal(
    inner.indexOf(`${selector} {`, at + 1),
    -1,
    `@media (prefers-color-scheme: dark) の中に ${selector} が2つある。1つにまとめる`,
  );
  return bodyAfter(inner, at + selector.length + 1);
})();

const hex = /^#[0-9a-fA-F]{6}$/;

// トークンの値を文字列のまま返す。同じ変数が重ねて書かれていたら、CSS で効く後ろの値を返す。無ければ落とす
function readValue(block: string, theme: string, name: string): string {
  const values = [...block.matchAll(new RegExp(`--color-${name}:\\s*([^;]+);`, 'g'))];
  const value = values.at(-1)?.[1].trim();
  assert.ok(value, `${theme} に --color-${name} が見つからない`);
  return value;
}

// 6桁の hex だけを数にする。var() や color-mix() が来たら、計算できないので直し先を書いて落とす
function readColor(block: string, theme: string, name: string): string {
  const value = readValue(block, theme, name);
  assert.match(
    value,
    hex,
    `${theme} の --color-${name} が 6桁の hex でない（${value}）。段階の色と地の色は、テストが計算できるよう hex で書くか、このテスト（scripts/design-contrast.test.ts）に値の解き方を足す`,
  );
  return value.toLowerCase();
}

// WCAG 2 の相対輝度
function luminance(color: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const channel = parseInt(color.slice(i, i + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

describe('クリア報酬の段階の色のコントラスト', () => {
  for (const [theme, block] of Object.entries(blocks)) {
    test(`${theme}: 段階 3色 × 地 5色 のすべてが ${minimumRatio}:1 以上`, () => {
      const failures: string[] = [];
      for (const tier of tierNames) {
        const color = readColor(block, theme, `tier-${tier}`);
        for (const ground of groundNames) {
          const ratio = contrast(color, readColor(block, theme, ground));
          if (ratio < minimumRatio) {
            failures.push(`${theme} の --color-tier-${tier}（${color}）と --color-${ground} は ${ratio.toFixed(2)}:1`);
          }
        }
      }
      assert.deepEqual(failures, [], `${minimumRatio}:1 を割る組がある`);
    });
  }

  test('シンプル（自動）の prefers-color-scheme の側は、simple_dark と同じ段階と地の値', () => {
    const dark = blocks['シンプル（ダーク）'];
    for (const name of [...tierNames.map((tier) => `tier-${tier}`), ...groundNames]) {
      assert.equal(
        readValue(autoDarkBlock, 'シンプル（自動）のダークの側', name).toLowerCase(),
        readValue(dark, 'シンプル（ダーク）', name).toLowerCase(),
        `--color-${name} が simple_dark と食い違う`,
      );
    }
  });
});

describe('.tier の色の対応', () => {
  // 波括弧を入れ子にしない規則だけを、セレクタと宣言の組にする
  const rules = [...components.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector.trim(),
    colors: [...body.matchAll(/(?:^|[;\s])color:\s*([^;]+?)\s*(?:;|$)/g)].map(([, value]) => value),
  }));

  for (const tier of tierNames) {
    test(`.tier.is-${tier} は --color-tier-${tier} を color に使う`, () => {
      const own = rules.filter((rule) => rule.selector === `.tier.is-${tier}`);
      assert.equal(
        own.length,
        1,
        `design/components.css の .tier.is-${tier} の規則が ${own.length} 個ある（1つにする）`,
      );
      assert.deepEqual(
        own[0].colors,
        [`var(--color-tier-${tier})`],
        `.tier.is-${tier} の color が var(--color-tier-${tier}) でない`,
      );
    });
  }

  test('.tier.is-* を含む別の規則（テーマごとの上書きなど）は、段階の色を変えない', () => {
    const overrides = rules.filter(
      (rule) =>
        /\.tier(?![\w-])/.test(rule.selector) &&
        !/^\.tier\.is-(small|medium|large)$/.test(rule.selector) &&
        rule.colors.length > 0,
    );
    assert.deepEqual(
      overrides.map((rule) => `${rule.selector} { color: ${rule.colors.join(', ')} }`),
      [],
      '.tier の color を上書きする規則がある。段階の色は --color-tier-* だけで決める（コントラストを tokens.css で守っているため）',
    );
  });
});
