import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { dictionary, format, word } from '../src/shared/vocabulary.ts';

describe('言葉の辞書', () => {
  test('項目はキーごとに空でない文字列1つ', () => {
    for (const [key, text] of Object.entries(dictionary)) {
      assert.equal(typeof text, 'string', key);
      assert.notEqual(text, '', key);
    }
  });

  test('列の節の説明は、切り替えを前提にした「言葉づかい」を含まない', () => {
    assert.ok(!dictionary.columnsDesc.includes('言葉づかい'));
    assert.ok(dictionary.columnsDesc.includes('名前は付けたままで、訳しません。'));
  });

  test('format は名前を埋め、params に無い名前はそのまま残す', () => {
    assert.equal(format('{page} - {app}', { page: '自分の今日', app: 'Scrum Guild' }), '自分の今日 - Scrum Guild');
    assert.equal(format('API: {status}（版 {version}）', { status: 'ok' }), 'API: ok（版 {version}）');
    assert.equal(format('{count} 件', { count: 0 }), '0 件');
    assert.equal(format('置き換えなし'), '置き換えなし');
  });

  test('word はスクラムの言葉を引く', () => {
    assert.equal(word('task'), 'タスク');
    assert.equal(word('organization'), '組織');
  });

  test('題名の組み立ては辞書の1項目で、画面の既定の題名は辞書の名前と同じ', () => {
    const html = readFileSync(new URL('../src/app.html', import.meta.url), 'utf8');
    assert.equal(/<title>([^<]*)<\/title>/.exec(html)?.[1], dictionary.appName);
    assert.equal(word('pageTitle', { page: word('pageToday'), app: word('appName') }), '自分の今日 - Scrum Guild');
  });
});
