import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// acceptance-video で、セッションが受け入れ動画を撮る前に手順書と字幕の区間を確かめるスクリプト
const skillDir = fileURLToPath(new URL('../.claude/skills/acceptance-video/', import.meta.url));

function inTempDir<T>(files: Record<string, unknown>, run: (path: (name: string) => string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'acceptance-video-'));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(content));
    return run((name) => join(dir, name));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('record.mjs --check', () => {
  const check = (plan: unknown) =>
    inTempDir({ 'steps.json': plan }, (path) => {
      const result = spawnSync(process.execPath, [join(skillDir, 'record.mjs'), '--check', path('steps.json')], {
        encoding: 'utf8',
      });
      assert.ifError(result.error);
      return result;
    });

  test('見本の手順書は通り、待ちの合計を出す', () => {
    const result = spawnSync(
      process.execPath,
      [join(skillDir, 'record.mjs'), '--check', join(skillDir, 'example-574.json')],
      {
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /場面 8、待ちの合計 25\.1 秒/);
  });

  test('操作が1つの動詞に決まらない手順書は、場所を添えて断る', () => {
    const result = check({ steps: [{ actions: [{ click: { css: 'a' }, check: { css: 'b' } }] }] });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /steps\[0\]\.actions\[0\]/);
  });

  test('role を指すのに name が無い要素は断る', () => {
    const result = check({ steps: [{ mark: { role: 'button' } }] });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /steps\[0\]\.mark: role には name も指定する/);
  });

  test('字幕が帯に収まらない長さなら断る', () => {
    const result = check({ steps: [{ caption: 'あ'.repeat(39) }] });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /caption が 38 文字を超える/);
  });

  test('38 文字ちょうどの字幕は通る', () => {
    assert.equal(check({ steps: [{ caption: 'あ'.repeat(38) }] }).status, 0);
  });

  test('待ちの合計が長すぎる手順書は断る', () => {
    const result = check({ steps: Array.from({ length: 10 }, () => ({ caption: 'あ' })) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /26 秒を超える/);
  });

  test('見える操作が続くときだけ、操作の間に1秒を数える', () => {
    // check → click は 1 秒、click → wait は 0 秒。始まりの 0.5 秒と合わせて 1.5 秒
    const result = check({
      steps: [
        {
          actions: [{ check: { css: 'a' } }, { click: { css: 'b' } }, { wait: { css: 'c' } }],
          hold: 0,
        },
      ],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /待ちの合計 1\.5 秒/);
  });
});

describe('compose.py --spans', () => {
  const spans = (cues: unknown) =>
    inTempDir({ 'cues.json': cues }, (path) => {
      const result = spawnSync('python3', ['-I', join(skillDir, 'compose.py'), '--spans', path('cues.json')], {
        encoding: 'utf8',
      });
      assert.ifError(result.error);
      return result;
    });

  test('字幕は次の字幕の時刻まで出し、空の字幕は帯を空にする', () => {
    const result = spans([
      { t: 0.5, text: '一つ目' },
      { t: 4.5, text: '二つ目' },
      { t: 8, text: '' },
      { t: 9, text: '三つ目' },
      { t: 12, text: '' },
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      { text: '一つ目', start: 0.5, end: 4.5 },
      { text: '二つ目', start: 4.5, end: 8 },
      { text: '三つ目', start: 9, end: 12 },
    ]);
  });

  test('最後が空の字幕でなければ、最後の字幕を閉じられないので断る', () => {
    const result = spans([{ t: 0, text: '閉じない' }]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /最後は、字幕を閉じる空の文/);
  });

  test('時刻が戻っている字幕は断る', () => {
    const result = spans([
      { t: 5, text: 'あ' },
      { t: 3, text: 'い' },
      { t: 6, text: '' },
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /時刻が戻っている/);
  });
});
