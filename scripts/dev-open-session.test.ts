import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SEED_SESSIONS } from '../seed/sessions.ts';
import { checkDevOpenSession } from './dev-open-session.ts';
import { resolveDevOpenTarget, type DevOpenTarget } from './dev-open-target.ts';

function target(argv: string[]): DevOpenTarget {
  const resolved = resolveDevOpenTarget(argv, {});
  assert.ok(resolved.ok);
  return resolved;
}

type Call = { url: string; init: RequestInit | undefined };

function respond(status: number, calls: Call[] = []): typeof fetch {
  return async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(null, { status });
  };
}

function fail(error: Error): typeof fetch {
  return async () => {
    throw error;
  };
}

function reasonOf(result: { ok: boolean; reason?: string }): string {
  assert.equal(result.ok, false);
  return result.reason ?? '';
}

describe('checkDevOpenSession', () => {
  test('200 なら進む。me に Cookie と Origin を付け、リダイレクトは辿らない', async () => {
    const calls: Call[] = [];
    assert.deepEqual(await checkDevOpenSession(target(['admin']), {}, respond(200, calls)), { ok: true });
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url, 'http://localhost:5173/api/me');
    assert.equal(call.init?.method, 'POST');
    assert.equal(call.init?.redirect, 'manual');
    const headers = new Headers(call.init?.headers);
    assert.equal(headers.get('Origin'), 'http://localhost:5173');
    assert.equal(headers.get('Cookie'), `sg_session=${SEED_SESSIONS.admin.token}`);
  });

  test('401 は pnpm db:seed を案内する。運用者には .dev.vars も案内する', async () => {
    const admin = reasonOf(await checkDevOpenSession(target(['admin']), {}, respond(401)));
    assert.match(admin, /pnpm db:seed/);
    assert.doesNotMatch(admin, /\.dev\.vars/);
    assert.match(reasonOf(await checkDevOpenSession(target(['operator']), {}, respond(401))), /\.dev\.vars/);
  });

  test('3xx と 5xx は状態コードを出して止める', async () => {
    for (const status of [302, 307, 403, 500]) {
      assert.match(reasonOf(await checkDevOpenSession(target([]), {}, respond(status))), new RegExp(String(status)));
    }
  });

  test('pnpm dev の 5xx は、wrangler dev の立て直しも案内する', async () => {
    assert.match(
      reasonOf(await checkDevOpenSession(target([]), {}, respond(502))),
      /wrangler dev が止まっていれば pnpm dev/,
    );
    assert.doesNotMatch(reasonOf(await checkDevOpenSession(target([]), {}, respond(403))), /wrangler dev/);
    assert.doesNotMatch(reasonOf(await checkDevOpenSession(target(['--preview']), {}, respond(500))), /wrangler dev/);
  });

  test('時間切れは、立てる案内でなく答えないことを伝える', async () => {
    const reason = reasonOf(
      await checkDevOpenSession(target([]), {}, fail(new DOMException('timeout', 'TimeoutError'))),
    );
    assert.match(reason, /答えない/);
    assert.doesNotMatch(reason, /立てて/);
  });

  test('つながらないときは、同じ DEV_PORT_OFFSET で立てる案内を出す', async () => {
    const refused = fail(new TypeError('fetch failed'));
    assert.match(reasonOf(await checkDevOpenSession(target([]), {}, refused)), /別の端末で pnpm dev を立てて/);
    assert.match(
      reasonOf(await checkDevOpenSession(target(['--preview']), { DEV_PORT_OFFSET: '10' }, refused)),
      /DEV_PORT_OFFSET=10 pnpm preview/,
    );
  });
});
