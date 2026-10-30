// 見本（design/）と本番（src/）の二重持ちを突き合わせる。アイコンと言葉の辞書は見本が先に決まるので、
// 見本だけ、または本番だけを直すとここで落ちる。照合するのは見本にあるキーだけで、本番の辞書は画面の文言を足して大きくなってよい。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import vm from 'node:vm';
import { iconViewBox, icons } from '../src/lib/icons.ts';
import { themeLabelKeys, themeNoteKeys, themes } from '../src/shared/theme.ts';
import { defaultVocabularies, dictionary } from '../src/shared/vocabulary.ts';

const read = (file: string) => readFileSync(new URL(`../design/${file}`, import.meta.url), 'utf8');

// design/icons.js は IIFE で window と document を触り、SVG のスプライトを body に差し込む。
// 偽の document に渡された文字列を受け取り、symbol を読み出す
function evaluateIcons(): { names: string[]; symbols: Map<string, { viewBox: string; body: string }> } {
  let sprite = '';
  const window: { SQ_ICONS?: string[] } = {};
  const document = {
    createElement: () => ({
      set innerHTML(html: string) {
        sprite = html;
      },
      firstChild: {},
    }),
    body: { prepend: () => {} },
  };
  vm.runInNewContext(read('icons.js'), { window, document });
  const symbols = new Map<string, { viewBox: string; body: string }>();
  for (const [, id, viewBox, body] of sprite.matchAll(/<symbol id="i-([^"]+)" viewBox="([^"]+)">(.*?)<\/symbol>/g)) {
    symbols.set(id, { viewBox, body });
  }
  // vm の中の配列は Array の実体が別なので、deepEqual の前に外の配列へ写す
  return { names: [...(window.SQ_ICONS ?? [])], symbols };
}

// design/kit.js の DICT は、全体が IIFE の中で window.SQ_DATA などを前提にするので、DICT のリテラルだけを取り出して評価する
function readKitDictionary(): Record<string, [string, string]> {
  const literal = /\n {2}const DICT = (\{[\s\S]*?\n {2}\});/.exec(read('kit.js'))?.[1];
  assert.ok(literal, 'design/kit.js に DICT が見つからない（書き方を変えたら、このテストの取り出し方も直す）');
  return vm.runInNewContext(`(${literal})`);
}

// SVG の要素の属性を、属性の並びによらずに比べられる形で取り出す
function readElements(source: string, tag: 'svg' | 'path'): Record<string, string>[] {
  return [...source.matchAll(new RegExp(`<${tag}\\b([^>]*?)\\/?>`, 'g'))].map(([, attrs]) =>
    Object.fromEntries([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]).sort()),
  );
}

const readPaths = (source: string) => readElements(source, 'path');
const readSvg = (source: string) => readElements(source, 'svg')[0];
// 要素のタグ名の並び。path の外に足した title（読み上げの二重読み）や g、circle を拾う
const readTags = (source: string) => [...source.matchAll(/<([a-zA-Z][\w-]*)\b/g)].map(([, tag]) => tag);

describe('見本との照合', () => {
  test('ロゴのマークは favicon、見本、本番で同じ形と色', () => {
    const faviconSource = readFileSync(new URL('../static/favicon.svg', import.meta.url), 'utf8');
    const favicon = readPaths(faviconSource);
    assert.equal(favicon.length, 2, 'favicon の path を読めなかった');
    const brandMark = /const brandMark = `([^`]*)`/.exec(read('kit.js'))?.[1];
    assert.ok(brandMark, 'design/kit.js に brandMark が見つからない（書き方を変えたら、このテストの取り出し方も直す）');
    const component = readFileSync(new URL('../src/lib/components/BrandMark.svelte', import.meta.url), 'utf8');
    for (const [label, source] of [
      ['見本の brandMark', brandMark],
      ['本番の BrandMark.svelte', component],
    ]) {
      assert.deepEqual(readTags(source), readTags(faviconSource), `${label} の要素`);
      assert.deepEqual(readPaths(source), favicon, `${label} の path`);
      // 名前は横の文字が読ませるので、マークは読み上げから外す。class は components.css の大きさの指定に要る
      assert.deepEqual(
        readSvg(source),
        { 'aria-hidden': 'true', class: 'brand-mark', viewBox: readSvg(faviconSource).viewBox },
        `${label} の svg`,
      );
    }
  });

  test('Google の G のロゴは見本と本番で同じ形と色。公式の4色の path を変えない', () => {
    const googleMark = /const googleMark = `([^`]*)`/.exec(read('kit.js'))?.[1];
    assert.ok(
      googleMark,
      'design/kit.js に googleMark が見つからない（書き方を変えたら、このテストの取り出し方も直す）',
    );
    const component = readFileSync(new URL('../src/lib/components/GoogleMark.svelte', import.meta.url), 'utf8');
    const official = [
      {
        d: 'M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z',
        fill: '#EA4335',
      },
      {
        d: 'M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z',
        fill: '#4285F4',
      },
      {
        d: 'M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z',
        fill: '#FBBC05',
      },
      {
        d: 'M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z',
        fill: '#34A853',
      },
      { d: 'M0 0h48v48H0z', fill: 'none' },
    ];
    for (const [label, source] of [
      ['見本の googleMark', googleMark],
      ['本番の GoogleMark.svelte', component],
    ]) {
      // svg と path ×5 だけ。title や g、circle を足して公式の形を崩さない
      assert.deepEqual(readTags(source), ['svg', 'path', 'path', 'path', 'path', 'path'], `${label} の要素`);
      assert.deepEqual(readPaths(source), official, `${label} の path`);
      assert.deepEqual(
        readSvg(source),
        { 'aria-hidden': 'true', class: 'google-mark', viewBox: '0 0 48 48' },
        `${label} の svg`,
      );
    }
  });

  test('アイコンは見本と同じ名前と中身を持つ', () => {
    const design = evaluateIcons();
    assert.ok(design.symbols.size > 0, '見本のアイコンを読めなかった');
    assert.deepEqual([...design.symbols.keys()].sort(), design.names.slice().sort());
    assert.deepEqual(Object.keys(icons).sort(), [...design.symbols.keys()].sort());
    for (const [name, symbol] of design.symbols) {
      assert.equal(symbol.viewBox, iconViewBox, `${name} の viewBox`);
      assert.equal(icons[name as keyof typeof icons], symbol.body, `${name} の中身`);
    }
  });

  test('言葉の辞書は、見本の DICT の全キーについて、ゲームとスクラムの言葉が同じ', () => {
    const design = readKitDictionary();
    const keys = Object.keys(design);
    assert.ok(keys.length > 0, '見本の DICT を読めなかった');
    const production: Record<string, { game: string; scrum: string } | undefined> = dictionary;
    for (const key of keys) {
      const entry = production[key];
      assert.ok(entry, `本番の辞書に ${key} が無い`);
      assert.deepEqual([entry.game, entry.scrum], [...design[key]], `${key} の中身`);
    }
  });

  test('テーマの名前と説明は、見本の THEME_LABEL と THEME_NOTE と同じ', () => {
    const readObject = (name: string): Record<string, string> => {
      const literal = new RegExp(`\\n {2}const ${name} = (\\{[\\s\\S]*?\\});`).exec(read('kit.js'))?.[1];
      assert.ok(literal, `design/kit.js に ${name} が見つからない（書き方を変えたら、このテストの取り出し方も直す）`);
      return vm.runInNewContext(`(${literal})`);
    };
    const labels = readObject('THEME_LABEL');
    const notes = readObject('THEME_NOTE');
    for (const theme of themes) {
      const label = dictionary[themeLabelKeys[theme]];
      const note = dictionary[themeNoteKeys[theme]];
      assert.deepEqual([label.game, label.scrum], [labels[theme], labels[theme]], `${theme} の名前`);
      assert.deepEqual([note.game, note.scrum], [notes[theme], notes[theme]], `${theme} の説明`);
    }
  });

  test('本番の辞書は、どのキーもゲームとスクラムの言葉が空でない', () => {
    for (const [key, entry] of Object.entries(dictionary)) {
      assert.notEqual(entry.game, '', `${key} の game`);
      assert.notEqual(entry.scrum, '', `${key} の scrum`);
    }
  });

  test('見本の初めの言葉づかいは、本番の既定と同じ（0 がゲームの言葉、1 がスクラムの言葉）', () => {
    const initial = /\n {2}let vocab = (\d);/.exec(read('kit.js'))?.[1];
    assert.ok(initial, 'design/kit.js に let vocab が見つからない（書き方を変えたら、このテストの取り出し方も直す）');
    const indexOf = { game: '0', scrum: '1' } as const;
    assert.equal(indexOf[defaultVocabularies.workspace], initial);
    assert.equal(indexOf[defaultVocabularies.organization], initial);
  });
});
