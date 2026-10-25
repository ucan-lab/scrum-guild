// 見本（design/）と本番（src/）の二重持ちを突き合わせる。アイコンと言葉の辞書は見本が先に決まるので、
// 見本だけ、または本番だけを直すとここで落ちる。照合するのは見本にあるキーだけで、本番の辞書は画面の文言を足して大きくなってよい。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import vm from 'node:vm';
import { iconViewBox, icons } from '../src/lib/icons.ts';
import { dictionary } from '../src/shared/vocabulary.ts';

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

describe('見本との照合', () => {
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

  test('本番の辞書は、どのキーもゲームとスクラムの言葉が空でない', () => {
    for (const [key, entry] of Object.entries(dictionary)) {
      assert.notEqual(entry.game, '', `${key} の game`);
      assert.notEqual(entry.scrum, '', `${key} の scrum`);
    }
  });
});
