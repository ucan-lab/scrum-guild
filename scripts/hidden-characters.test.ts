// 名前で断る文字の決まり（src/shared/hidden-characters.ts）。ワークスペースの名前、組織の表示名、GitHub の表示名が同じ判定を使う。
// 見えない文字は、ソースに直に書かず、コードポイントの数値で書く
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { hasHiddenCharacter, stripHiddenCharacters } from '../src/shared/hidden-characters.ts';
import { createOrganization } from '../src/shared/operations/operator/index.ts';
import { workspaceNameProblem } from '../src/shared/workspace.ts';

const chars = (...codePoints: number[]) => codePoints.map((codePoint) => String.fromCodePoint(codePoint));

// 断る文字: 制御文字、ゼロ幅のスペース、行と段落の区切り、向きを変える制御、見えない演算子、BOM
const REJECTED = chars(
  0x0,
  0x7,
  0xa,
  0x7f,
  0x200b,
  0x2028,
  0x2029,
  0x202a,
  0x202b,
  0x202c,
  0x202d,
  0x202e,
  0x2060,
  0x2061,
  0x2062,
  0x2063,
  0x2064,
  0x2066,
  0x2067,
  0x2068,
  0x2069,
  0xfeff,
);

// 通す文字: ZWNJ、ZWJ、方向の印（LRM、RLM、ALM）、旗のタグ文字
const KEPT = chars(0x200c, 0x200d, 0x200e, 0x200f, 0x61c, 0xe0020, 0xe0067, 0xe007f);

const organizationName = (name: string) => createOrganization.input.shape.name.safeParse(name).success;

describe('名前で断る文字', () => {
  test('断る文字を含めば true、取り除くと消える', () => {
    for (const character of REJECTED) {
      const name = `保守${character}チーム`;
      assert.equal(hasHiddenCharacter(name), true, `U+${character.codePointAt(0)!.toString(16)}`);
      assert.equal(stripHiddenCharacters(name), '保守チーム', `U+${character.codePointAt(0)!.toString(16)}`);
    }
  });

  test('ZWNJ、ZWJ、LRM、RLM、ALM、旗のタグ文字は、断らず、取り除かない', () => {
    for (const character of KEPT) {
      const name = `保守${character}チーム`;
      assert.equal(hasHiddenCharacter(name), false, `U+${character.codePointAt(0)!.toString(16)}`);
      assert.equal(stripHiddenCharacters(name), name, `U+${character.codePointAt(0)!.toString(16)}`);
    }
  });

  test('ZWJ でつないだ絵文字と旗は通る', () => {
    const family = chars(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467).join('');
    const flag = chars(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f).join('');
    for (const name of [family, flag]) assert.equal(hasHiddenCharacter(name), false);
  });

  test('ワークスペースの名前と組織の表示名は、同じ文字を断り、同じ文字を通す', () => {
    for (const character of REJECTED) {
      const name = `保守${character}チーム`;
      assert.equal(
        workspaceNameProblem(name),
        'invalid_character',
        `ワークスペース U+${character.codePointAt(0)!.toString(16)}`,
      );
      assert.equal(organizationName(name), false, `組織 U+${character.codePointAt(0)!.toString(16)}`);
    }
    for (const character of KEPT) {
      const name = `保守${character}チーム`;
      assert.equal(workspaceNameProblem(name), null, `ワークスペース U+${character.codePointAt(0)!.toString(16)}`);
      assert.equal(organizationName(name), true, `組織 U+${character.codePointAt(0)!.toString(16)}`);
    }
  });
});
