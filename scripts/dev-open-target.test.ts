import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SEED_SESSIONS } from '../seed/sessions.ts';
import { parseDevOpenArgs, resolveDevOpenTarget } from './dev-open-target.ts';

function failureReason(result: { ok: boolean; reason?: string }): string {
  assert.equal(result.ok, false);
  return result.reason ?? '';
}

describe('parseDevOpenArgs', () => {
  test('省略したときは admin と /', () => {
    assert.deepEqual(parseDevOpenArgs([]), { ok: true, preview: false, who: 'admin', path: '/' });
  });

  test('位置でなく形で見分ける（--preview、/ で始まる path、それ以外は who）', () => {
    const expected = { ok: true, preview: true, who: 'member', path: '/aoba' };
    assert.deepEqual(parseDevOpenArgs(['member', '/aoba', '--preview']), expected);
    assert.deepEqual(parseDevOpenArgs(['--preview', '/aoba', 'member']), expected);
    assert.deepEqual(parseDevOpenArgs(['/aoba', 'member', '--preview']), expected);
    assert.deepEqual(parseDevOpenArgs(['/aoba']), { ok: true, preview: false, who: 'admin', path: '/aoba' });
    assert.deepEqual(parseDevOpenArgs(['operator']), { ok: true, preview: false, who: 'operator', path: '/' });
  });

  test('同じ種類が2つ以上あれば理由を出して止める', () => {
    assert.match(failureReason(parseDevOpenArgs(['admin', 'member'])), /who が2つ/);
    assert.match(failureReason(parseDevOpenArgs(['/a', '/b'])), /path が2つ/);
  });

  test('--preview 以外の -- で始まるフラグは止める', () => {
    for (const flag of ['--help', '--previews', '--', '--preview=1']) {
      assert.match(failureReason(parseDevOpenArgs([flag])), /知らないフラグ/, flag);
    }
  });

  test('知らない who は、選べるキーと description を並べて止める', () => {
    const reason = failureReason(parseDevOpenArgs(['nobody']));
    assert.match(reason, /nobody/);
    for (const [key, session] of Object.entries(SEED_SESSIONS)) {
      assert.ok(reason.includes(`${key}: ${session.description}`), key);
    }
    // Object のプロパティ名も who にしない
    assert.match(failureReason(parseDevOpenArgs(['toString'])), /知らない who/);
    assert.match(failureReason(parseDevOpenArgs(['__proto__'])), /知らない who/);
  });
});

describe('resolveDevOpenTarget', () => {
  test('pnpm dev の画面の origin、Cookie の名前、seed のトークンで URL を組む', () => {
    assert.deepEqual(resolveDevOpenTarget(['admin', '/aoba'], {}), {
      ok: true,
      preview: false,
      who: 'admin',
      path: '/aoba',
      origin: 'http://localhost:5173',
      url: 'http://localhost:5173/aoba',
      cookieName: 'sg_session',
      token: SEED_SESSIONS.admin.token,
    });
  });

  test('--preview は wrangler dev の origin', () => {
    const target = resolveDevOpenTarget(['--preview', 'operator'], {});
    assert.ok(target.ok);
    assert.equal(target.origin, 'http://localhost:8787');
    assert.equal(target.url, 'http://localhost:8787/');
    assert.equal(target.token, SEED_SESSIONS.operator.token);
  });

  test('DEV_PORT_OFFSET で origin がずれる', () => {
    const dev = resolveDevOpenTarget(['/aoba'], { DEV_PORT_OFFSET: '10' });
    assert.ok(dev.ok);
    assert.equal(dev.url, 'http://localhost:5183/aoba');
    const preview = resolveDevOpenTarget(['--preview'], { DEV_PORT_OFFSET: '10' });
    assert.ok(preview.ok);
    assert.equal(preview.origin, 'http://localhost:8797');
  });

  test('DEV_PORT_OFFSET が不正なら止める', () => {
    assert.match(failureReason(resolveDevOpenTarget([], { DEV_PORT_OFFSET: 'x' })), /DEV_PORT_OFFSET/);
  });

  test('受け付けない path は、/ に直さず理由を出して止める', () => {
    for (const path of ['//evil.example', '/\\evil.example', '/.//evil.example', '/api/me', '/login']) {
      assert.match(failureReason(resolveDevOpenTarget(['admin', path], {})), /開けない/, path);
    }
    // `/` で始まらない値（相対パス、完全な URL）は path でなく who と読まれ、知らない who で止まる
    for (const value of ['aoba', 'http://localhost:5173/x']) {
      assert.match(failureReason(resolveDevOpenTarget([value], {})), /知らない who/, value);
    }
  });

  test('path は、クエリとフラグメントを含めてそのまま使う', () => {
    const target = resolveDevOpenTarget(['/aoba/board?tab=1#top'], {});
    assert.ok(target.ok);
    assert.equal(target.url, 'http://localhost:5173/aoba/board?tab=1#top');
  });

  test('引数で止まるときは origin を決めない（不正な DEV_PORT_OFFSET より引数の理由が先）', () => {
    assert.match(failureReason(resolveDevOpenTarget(['nobody'], { DEV_PORT_OFFSET: 'x' })), /知らない who/);
  });
});
