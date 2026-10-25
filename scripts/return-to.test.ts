import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_RETURN_TO, resolvedReturnTo, safeReturnTo } from '../src/shared/return-to.ts';

describe('ログイン後に戻る画面のパス', () => {
  test('自分のサイトのパスはそのまま返す（クエリとフラグメントを含む）', () => {
    for (const value of ['/', '/aoba', '/aoba/board?tab=1#top', '/aoba/tasks/0196-x', '/login-help', '/apiary']) {
      assert.equal(safeReturnTo(value), value);
    }
  });

  test('値が無い、文字列でない、は /', () => {
    for (const value of [undefined, null, '', 42, {}, ['/a']]) assert.equal(safeReturnTo(value), DEFAULT_RETURN_TO);
  });

  test('別のサイトに移りうる値は /', () => {
    for (const value of [
      'https://evil.example/',
      '//evil.example',
      '///evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      'evil.example',
      // ブラウザは URL のタブと改行を取り除くので、/<タブ>/evil.example は //evil.example になる
      '/\t/evil.example',
      '/\n/evil.example',
      '/\r/evil.example',
      '/あおば',
      '/\u0000',
    ]) {
      assert.equal(safeReturnTo(value), DEFAULT_RETURN_TO, JSON.stringify(value));
    }
  });

  // 解決（URL の正規化）で `.` と `..` の区間が畳まれ、先頭が `//` のパスになって、別のサイトへ移る書き方
  const dotted = [
    '/.//evil.example',
    '/..//evil.example',
    '/a/..//evil.example',
    '/%2e//evil.example',
    '/%2E//evil.example',
    '/%2e%2e//evil.example',
    '/.%2e//evil.example',
    '/%2e./\\evil.example',
    '/./\\evil.example',
    '/.\\/evil.example',
    '/x/../\\\\evil.example',
    '/.',
    '/..',
    '/a/.',
    '/a/../',
    '/a/./b?x=1',
    '/api/../login',
    '/./api',
    '/%2e/login',
  ];

  test('`.` と `..` の区間（%2e を含む）とバックスラッシュを含む値は /', () => {
    for (const value of dotted) assert.equal(safeReturnTo(value), DEFAULT_RETURN_TO, value);
  });

  test('区間でない `.` は通す。クエリとフラグメントの中の `..` も区間ではない', () => {
    for (const value of ['/a.b', '/a./b', '/.hidden', '/a..b', '/a?next=/../x', '/a#/../x', '/v1.2/x']) {
      assert.equal(safeReturnTo(value), value, value);
    }
  });

  test('バックスラッシュを拒むのはパスだけ。クエリとフラグメントでは拒まない', () => {
    for (const value of ['/a?x=\\y', '/a?next=\\evil.example', '/a#\\x', '/a?x=1#\\']) {
      assert.equal(safeReturnTo(value), value, value);
      assert.equal(resolvedReturnTo(value, 'https://scrum-guild.example'), value, value);
    }
    for (const value of ['/a\\b', '/a\\b?x=1', '/\\evil.example', '/a/\\']) {
      assert.equal(safeReturnTo(value), DEFAULT_RETURN_TO, value);
    }
  });

  test('除外する最初の区間は、デコードしてから比べる。デコードできない値は /', () => {
    for (const value of ['/%61pi/x', '/%6cogin', '/%6CoGin?x=1', '/%41PI', '/l%6fgin#x', '/%2561pi/../x']) {
      assert.equal(safeReturnTo(value), DEFAULT_RETURN_TO, value);
    }
    for (const value of ['/%', '/%zz/x', '/%E3%81/x', '/a%/b']) {
      assert.equal(safeReturnTo(value), DEFAULT_RETURN_TO, value);
    }
    // 最初の区間だけを見る。2つ目以降の区間と、デコードしても api と login でない値は通す
    for (const value of ['/aoba/%61pi', '/%E3%81%82/x', '/%61pis', '/aoba/login']) {
      assert.equal(safeReturnTo(value), value, value);
    }
  });

  test('resolvedReturnTo は、safeReturnTo を通さずに単体で呼んでも、第2の検査として効く', () => {
    const origin = 'https://scrum-guild.example';
    // safeReturnTo が先に落とす値でも、resolvedReturnTo は自分で、解決した後の値を見て落とす
    for (const value of [
      '/.//evil.example',
      '/a/..//evil.example',
      '/%2e//evil.example',
      '/%61pi/x',
      '/%6cogin',
      '/api/x',
    ]) {
      assert.equal(resolvedReturnTo(value, origin), DEFAULT_RETURN_TO, value);
    }
    // 別のオリジンになる値
    assert.equal(resolvedReturnTo('https://evil.example/x', origin), DEFAULT_RETURN_TO);
    assert.equal(resolvedReturnTo('//evil.example/x', origin), DEFAULT_RETURN_TO);
  });

  test('解決した後の値でも検査する: 解決で別のサイトになる書き方、api と login の別名は /', () => {
    const origin = 'https://scrum-guild.example';
    for (const value of dotted) {
      const resolved = resolvedReturnTo(value, origin);
      // 別のサイトに移る書き方は、解決した後に `//` で始まるので `/` に落ちる。`/a/.` のように、解決で `/a/` になるだけの値は、
      // 自分のサイトのパスなので使ってよい
      if (value.includes('evil.example')) assert.equal(resolved, DEFAULT_RETURN_TO, value);
      // どの値も、最後は自分のオリジンのパスで、`//` で始まらない
      assert.equal(new URL(resolved, origin).origin, origin, value);
      assert.ok(!resolved.startsWith('//'), value);
      assert.equal(safeReturnTo(resolved), resolved, value);
    }
    // 検査を通る値は、そのまま
    for (const value of ['/', '/aoba', '/aoba/board?tab=1#top', '/a%20b', '/q?x=a%2Fb']) {
      assert.equal(resolvedReturnTo(value, origin), value, value);
    }
    // 解決でパーセントの符号化が付く値は、符号化した後の値で検査して使う
    assert.equal(resolvedReturnTo('/a b', origin), '/a%20b');
  });

  test('API とログインの画面そのものへは戻さない', () => {
    for (const value of ['/api', '/api/health', '/API/x', '/login', '/login?return_to=/x', '/login/', '/login#x']) {
      assert.equal(safeReturnTo(value), DEFAULT_RETURN_TO, value);
    }
  });

  test('長すぎる値は /', () => {
    assert.equal(safeReturnTo(`/${'a'.repeat(2000)}`), DEFAULT_RETURN_TO);
    assert.equal(safeReturnTo(`/${'a'.repeat(1999)}`), `/${'a'.repeat(1999)}`);
  });
});
