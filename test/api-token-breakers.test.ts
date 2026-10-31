// API トークンの認証を崩す手口（#580）。test/api-token-operations.test.ts と重ならないものだけ:
// Authorization の書き方の揺れ、Bearer と Cookie の両方、Origin の検査の漏れ、Bearer を受けないルート、
// 停止中の組織、Set-Cookie、ログ、last_used_at と掃除の失敗、マイグレーションの CHECK
/* eslint-disable db-entry/guard -- 制約と掃除の失敗を起こすトリガーと、制約に反する行を、入口を通さず D1 に直に当てるため */
import { createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { defineOperation } from '../src/shared/operations/define.ts';
import { createApp } from '../src/server/app.ts';
import { readApiToken, revokeApiTokensOf } from '../src/server/auth/api-token.ts';
import { commonDb } from '../src/server/db/index.ts';
import { implement } from '../src/server/operations/implement.ts';
import worker from '../src/server/index.ts';
import { createAccount, createSession, hash64, uuidv7 } from './factories.ts';
import { insertApiToken, rawApiToken, tokenRow } from './operations/api-token.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { organizationProfile, provisionalOperations, whoAmI } from './operations/provisional.ts';
import { admitElsewhere, createLoginPerson, createPerson, createTarget, testEnv } from './operations/world.ts';

const app = createApp(provisionalOperations);
const DAY_MS = 24 * 60 * 60 * 1000;
const future = () => new Date(Date.now() + 30 * DAY_MS).toISOString();

afterEach(() => {
  vi.restoreAllMocks();
});

async function loginWithToken() {
  const person = await createLoginPerson();
  const { raw, hash } = await insertApiToken(person.accountId, { scope: 'write', expiresAt: future() });
  return { person, raw, hash };
}

function whoAmIRequest(headers: Headers | Record<string, string>): Promise<Response> {
  return Promise.resolve(app.request('/api/who-am-i', { method: 'POST', headers, body: '{}' }, testEnv));
}

describe('Authorization の書き方の揺れ', () => {
  test('Bearer の後の複数空白と、値の前後の空白は、同じトークンとして通る', async () => {
    const { person, raw } = await loginWithToken();
    for (const header of [`Bearer   ${raw}`, `Bearer ${raw}   `, `Bearer \t${raw}`]) {
      const res = await post(app, whoAmI, { headers: { Authorization: header }, origin: null });
      expect(res.status, JSON.stringify(header)).toBe(200);
      expect(await res.json()).toEqual({ account_id: person.accountId });
    }
  });

  test('トークンの後ろに別の語や2本目の Bearer が続くと 401（先頭の有効な値で通さない）', async () => {
    const { raw } = await loginWithToken();
    const other = rawApiToken();
    for (const header of [`Bearer ${raw} extra`, `Bearer ${raw}, Bearer ${other}`, `Bearer ${raw},${other}`]) {
      const res = await post(app, whoAmI, { headers: { Authorization: header }, origin: null });
      expect(res.status, header).toBe(401);
    }
  });

  test('Authorization が2本あると連結されて 401（片方が有効でも通さない）', async () => {
    const { raw } = await loginWithToken();
    const headers = new Headers({ 'Content-Type': 'application/json' });
    headers.append('Authorization', `Bearer ${raw}`);
    headers.append('Authorization', `Bearer ${rawApiToken()}`);
    expect((await whoAmIRequest(headers)).status).toBe(401);
  });

  test('Basic など Bearer 以外の書き方は Cookie の呼び出しとして扱い、Origin が要る', async () => {
    const { person, raw } = await loginWithToken();
    const basic = { Authorization: `Basic ${btoa(`user:${raw}`)}` };
    // Cookie が有効でも Origin が無ければ 403。Authorization があることで Origin の検査は飛ばない
    expect((await post(app, whoAmI, { token: person.token, headers: basic, origin: null })).status).toBe(403);
    expect((await post(app, whoAmI, { headers: basic, origin: null })).status).toBe(403);
    // Origin があれば Cookie で通る
    expect((await post(app, whoAmI, { token: person.token, headers: basic })).status).toBe(200);
  });

  test('小文字の bearer と Bearer: は、Origin の検査を飛ばさない', async () => {
    const { person, raw } = await loginWithToken();
    for (const header of [`bearer ${raw}`, `BEARER ${raw}`, `Bearer: ${raw}`, raw]) {
      expect((await post(app, whoAmI, { headers: { Authorization: header }, origin: null })).status, header).toBe(403);
      expect(
        (await post(app, whoAmI, { token: person.token, headers: { Authorization: header }, origin: null })).status,
      ).toBe(403);
    }
  });

  test('値の無い Bearer は、有効な Cookie と Origin があっても 401', async () => {
    const { person } = await loginWithToken();
    for (const header of ['Bearer', 'Bearer ', 'Bearer  ']) {
      const res = await post(app, whoAmI, { token: person.token, headers: { Authorization: header } });
      expect(res.status, JSON.stringify(header)).toBe(401);
    }
  });

  test('セッションの Cookie の値を Bearer に、API トークンの値を Cookie に入れても通らない', async () => {
    const { person, raw } = await loginWithToken();
    expect((await post(app, whoAmI, { bearer: person.token })).status).toBe(401);
    expect((await post(app, whoAmI, { token: raw })).status).toBe(401);
    expect((await post(app, whoAmI, { token: raw, origin: null })).status).toBe(403);
  });
});

describe('Bearer と Cookie の両方', () => {
  test('Bearer の持ち主で動く。Cookie の持ち主の行は見えない', async () => {
    const [a, b] = await Promise.all([loginWithToken(), createLoginPerson()]);
    const res = await post(app, whoAmI, { bearer: a.raw, token: b.token });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ account_id: a.person.accountId });
  });

  test('Bearer の持ち主が組織に入れなければ、Cookie の持ち主が入れても 404', async () => {
    const [target, outsider] = await Promise.all([createTarget(), loginWithToken()]);
    const res = await post(app, organizationProfile, {
      slug: target.slug,
      bearer: outsider.raw,
      token: target.admin.token,
    });
    expect(res.status).toBe(404);
  });

  test('無効な Bearer に有効な Cookie と Origin が付いても、Cookie のセッションは消えず延びもしない', async () => {
    const person = await createLoginPerson();
    const res = await post(app, whoAmI, { bearer: rawApiToken(), token: person.token });
    expect(res.status).toBe(401);
    // 失敗の応答に Cookie を付ける経路（延長と消去）を通らない
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect((await post(app, whoAmI, { token: person.token })).status).toBe(200);
  });
});

describe('Origin の検査の漏れ', () => {
  test('Cookie だけで Origin が無い呼び出しは、同じアカウントのトークンがあっても 403', async () => {
    const { person } = await loginWithToken();
    expect((await post(app, whoAmI, { token: person.token, origin: null })).status).toBe(403);
    expect((await post(app, whoAmI, { token: person.token, origin: 'https://evil.example' })).status).toBe(403);
  });

  test('Bearer で呼ぶときの Origin は何でもよい（付いていても検査しない）', async () => {
    const { raw } = await loginWithToken();
    for (const origin of [null, 'https://evil.example', 'null']) {
      expect((await post(app, whoAmI, { bearer: raw, origin })).status, String(origin)).toBe(200);
    }
  });
});

describe('Bearer を受けないルート', () => {
  test('GET では操作を呼べない（操作は POST だけ）', async () => {
    const { raw } = await loginWithToken();
    const res = await app.request(
      '/api/who-am-i',
      { method: 'GET', headers: { Authorization: `Bearer ${raw}` } },
      testEnv,
    );
    expect(res.status).toBe(404);
  });

  test('ログインの戻り先は Bearer を見ず、セッションを作らない', async () => {
    const { raw } = await loginWithToken();
    const res = await app.request(
      '/api/auth/github/callback?code=x&state=y',
      { method: 'GET', headers: { Authorization: `Bearer ${raw}` }, redirect: 'manual' },
      testEnv,
    );
    expect(res.headers.get('Set-Cookie') ?? '').not.toContain(sessionCookieName(testEnv.PUBLIC_ORIGIN));
    expect(res.status).not.toBe(200);
  });

  test('パスワードのログインは Bearer を見ず、資格情報が無ければ成功しない', async () => {
    const { raw } = await loginWithToken();
    // 口を閉じている既定（404）では確かめにならないので、開いたアプリで確かめる
    const openApp = createApp(provisionalOperations, { passwordLogin: true });
    const res = await openApp.request(
      '/api/auth/password/login',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${raw}`, 'Content-Type': 'application/json', Origin: testEnv.PUBLIC_ORIGIN },
        body: '{}',
      },
      testEnv,
    );
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe('invalid_input');
    expect(res.headers.get('Set-Cookie') ?? '').not.toContain(sessionCookieName(testEnv.PUBLIC_ORIGIN));
  });

  test('/api/health は Authorization があってもなくても同じ', async () => {
    const withGarbage = await app.request('/api/health', { headers: { Authorization: 'Bearer garbage' } }, testEnv);
    expect(withGarbage.status).toBe(200);
  });
});

describe('入れなかった組織', () => {
  // #639: 停止した組織にしか入れない人も、ほかに入れる人と同じ 403 で、トークンは取り消さない
  test('停止した組織にしか入れない人は、トークンで 403 の organization_suspended になり、取り消されず、Cookie は付かない', async () => {
    const target = await createTarget({ suspended: true });
    const { raw, hash } = await insertApiToken(target.member.accountId, { expiresAt: future() });
    const res = await post(app, organizationProfile, { slug: target.slug, bearer: raw, origin: null });
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('organization_suspended');
    expect((await tokenRow(hash))!.revoked_at).toBeNull();
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect((await post(app, whoAmI, { bearer: raw, origin: null })).status).toBe(200);
  });

  test('停止した組織のほかにも入れる人は、トークンで 403 の organization_suspended のまま、取り消されない', async () => {
    const target = await createTarget({ suspended: true });
    await admitElsewhere(target.member);
    const { raw, hash } = await insertApiToken(target.member.accountId, { expiresAt: future() });
    const res = await post(app, organizationProfile, { slug: target.slug, bearer: raw, origin: null });
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('organization_suspended');
    expect((await tokenRow(hash))!.revoked_at).toBeNull();
  });

  test('無効にされた（入れる組織を失った）人のトークンも Cookie も、組織の外の操作で 200 のまま', async () => {
    const organization = (await createTarget()).organization;
    const person = await createPerson({ organization, disabled: true });
    const { raw } = await insertApiToken(person.accountId, { expiresAt: future() });
    expect((await post(app, whoAmI, { bearer: raw })).status).toBe(200);
    expect((await post(app, whoAmI, { token: person.token })).status).toBe(200);
  });

  test('入れる組織を失った人の呼び出しは、トークンでも Cookie でも、Cookie を消す Set-Cookie を付けない', async () => {
    const organization = (await createTarget()).organization;
    const viaToken = await createPerson({ organization, disabled: true });
    const viaCookie = await createPerson({ organization, disabled: true });
    const { raw } = await insertApiToken(viaToken.accountId, { expiresAt: future() });
    const tokenRes = await post(app, whoAmI, { bearer: raw });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.headers.get('Set-Cookie')).toBeNull();
    const cookieRes = await post(app, whoAmI, { token: viaCookie.token });
    expect(cookieRes.status).toBe(200);
    expect(cookieRes.headers.get('Set-Cookie') ?? '').not.toContain('Max-Age=0');
  });
});

describe('回数の上限と範囲の順', () => {
  const limited = defineOperation({
    name: 'limited-write-ping',
    description: '回数の上限のある書き込み',
    mode: 'write',
    permission: 'login',
    input: z.object({}),
    output: z.object({ ok: z.literal(true) }),
    rateLimit: { max: 2, windowSeconds: 60 },
  });
  const limitedApp = createApp([implement(limited, async () => ({ ok: true as const }))]);

  test('範囲が足りずに 403 になった呼び出しは、回数の枠を使わない', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const person = await createLoginPerson();
    const { raw } = await insertApiToken(person.accountId, { scope: 'read', expiresAt: future() });
    for (let i = 0; i < 5; i++) expect((await post(limitedApp, limited, { bearer: raw })).status).toBe(403);
    expect((await post(limitedApp, limited, { token: person.token })).status).toBe(200);
    expect((await post(limitedApp, limited, { token: person.token })).status).toBe(200);
    expect((await post(limitedApp, limited, { token: person.token })).status).toBe(429);
  });

  test('別のアカウントのトークンは、枠を共有しない', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const [a, b] = await Promise.all([createLoginPerson(), createLoginPerson()]);
    const [ta, tb] = await Promise.all([
      insertApiToken(a.accountId, { expiresAt: future() }),
      insertApiToken(b.accountId, { expiresAt: future() }),
    ]);
    for (let i = 0; i < 2; i++) expect((await post(limitedApp, limited, { bearer: ta.raw })).status).toBe(200);
    expect((await post(limitedApp, limited, { bearer: ta.raw })).status).toBe(429);
    expect((await post(limitedApp, limited, { bearer: tb.raw })).status).toBe(200);
  });
});

describe('ログと応答にトークンが出ない', () => {
  test('処理が例外を投げる 500 でも、ログにも応答にも値とハッシュが出ない', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = defineOperation({
      name: 'boom-ping',
      description: '例外を投げる',
      mode: 'read',
      permission: 'login',
      input: z.object({}),
      output: z.object({ ok: z.literal(true) }),
    });
    const boomApp = createApp([
      implement(boom, async () => {
        throw new Error('boom');
      }),
    ]);
    const { raw, hash } = await loginWithToken();
    const res = await post(boomApp, boom, { bearer: raw });
    expect(res.status).toBe(500);
    const output = [await res.text(), ...[...log.mock.calls, ...error.mock.calls].flat().map(String)].join('\n');
    expect(output).not.toContain(raw);
    expect(output).not.toContain(raw.slice(4));
    expect(output).not.toContain(hash);
  });

  test('401 の応答の本文に、送られたトークンの値が出ない', async () => {
    const raw = rawApiToken();
    const res = await post(app, whoAmI, { bearer: raw });
    expect(await res.text()).not.toContain(raw.slice(4));
  });
});

describe('last_used_at の書き込みの失敗', () => {
  test('書き込みが失敗しても、有効なトークンの呼び出しは続く（セッションの書き直しと同じ）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { raw, hash } = await loginWithToken();
    await env.DB.exec(
      "CREATE TRIGGER fail_api_token_touch BEFORE UPDATE OF last_used_at ON api_tokens BEGIN SELECT RAISE(ABORT, 'touch failed'); END",
    );
    try {
      const res = await post(app, whoAmI, { bearer: raw });
      expect(res.status).toBe(200);
    } finally {
      await env.DB.exec('DROP TRIGGER fail_api_token_touch');
    }
    expect(await tokenRow(hash)).toBeDefined();
  });
});

describe('取消と使用の並行', () => {
  test('使用の書き込みは revoked_at を戻さず、取消の後は読めない', async () => {
    const person = await createLoginPerson();
    const { raw, hash } = await insertApiToken(person.accountId, {
      createdAt: '2026-10-01T00:00:00.000Z',
      expiresAt: future(),
    });
    const now = new Date();
    await Promise.all([
      readApiToken(env, raw, now),
      revokeApiTokensOf(commonDb(env), person.accountId, new Date(now.getTime() + 1000)),
      readApiToken(env, raw, now),
    ]);
    expect((await tokenRow(hash))!.revoked_at).not.toBeNull();
    expect(await readApiToken(env, raw, now)).toBeUndefined();
  });
});

describe('毎分の掃除は片方の失敗で止まらない', () => {
  const run = () => worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: '* * * * *' }), env);

  test('api_tokens の削除が失敗しても、期限切れのセッションは消え、cron は失敗として終わる', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const account = await createAccount();
    const expired = await createSession(account.id, { expires_at: '2020-01-01T00:00:00.000Z' });
    await insertApiToken(account.id, { expiresAt: '2020-01-01T00:00:00.000Z' });
    await env.DB.exec(
      "CREATE TRIGGER fail_api_token_sweep BEFORE DELETE ON api_tokens BEGIN SELECT RAISE(ABORT, 'sweep failed'); END",
    );
    try {
      await expect(run()).rejects.toThrow();
    } finally {
      await env.DB.exec('DROP TRIGGER fail_api_token_sweep');
    }
    const left = await env.DB.prepare('select count(*) as n from sessions where token_hash = ?')
      .bind(expired.token_hash)
      .first<{ n: number }>();
    expect(left!.n).toBe(0);
    await env.DB.exec("delete from api_tokens where expires_at = '2020-01-01T00:00:00.000Z'");
  });

  test('セッションなどの掃除が失敗しても、期限切れのトークンは消える', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const account = await createAccount();
    await createSession(account.id, { expires_at: '2020-01-01T00:00:00.000Z' });
    const { hash } = await insertApiToken(account.id, { expiresAt: '2020-01-01T00:00:00.000Z' });
    await env.DB.exec(
      "CREATE TRIGGER fail_session_sweep BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'sweep failed'); END",
    );
    try {
      await expect(run()).rejects.toThrow();
    } finally {
      await env.DB.exec('DROP TRIGGER fail_session_sweep');
    }
    expect(await tokenRow(hash)).toBeUndefined();
    await env.DB.exec("delete from sessions where expires_at = '2020-01-01T00:00:00.000Z'");
  });
});

describe('マイグレーションの制約', () => {
  async function insertRaw(overrides: Record<string, unknown>) {
    const account = await createAccount();
    const row = {
      token_hash: hash64(),
      account_id: account.id,
      name: 'x',
      scope: 'read',
      created_at: '2026-10-20T00:00:00.000Z',
      last_used_at: null,
      expires_at: '2026-11-20T00:00:00.000Z',
      revoked_at: null,
      ...overrides,
    };
    return env.DB.prepare(
      'insert into api_tokens (token_hash, account_id, name, scope, created_at, last_used_at, expires_at, revoked_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        row.token_hash,
        row.account_id,
        row.name,
        row.scope,
        row.created_at,
        row.last_used_at,
        row.expires_at,
        row.revoked_at,
      )
      .run();
  }

  test('正しい行は入る（対照）', async () => {
    await expect(insertRaw({})).resolves.toBeDefined();
    await expect(insertRaw({ name: 'a'.repeat(100), scope: 'write' })).resolves.toBeDefined();
  });

  test('scope は read と write だけ', async () => {
    for (const scope of ['admin', 'READ', '', 'read,write']) {
      await expect(insertRaw({ scope }), scope).rejects.toThrow();
    }
  });

  test('name は 1〜100 文字', async () => {
    for (const name of ['', 'a'.repeat(101)]) {
      await expect(insertRaw({ name }), String(name.length)).rejects.toThrow();
    }
  });

  test('token_hash は SHA-256 の小文字の16進64文字だけ（生の値や大文字は入らない）', async () => {
    for (const tokenHash of [rawApiToken(), 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), `${'a'.repeat(63)}g`]) {
      await expect(insertRaw({ token_hash: tokenHash }), tokenHash).rejects.toThrow();
    }
  });

  test('expires_at は NULL にできず、account_id は存在するアカウントだけ', async () => {
    await expect(insertRaw({ expires_at: null })).rejects.toThrow();
    await expect(insertRaw({ account_id: uuidv7() })).rejects.toThrow();
  });

  test('token_hash は重複できない', async () => {
    const duplicate = hash64();
    await insertRaw({ token_hash: duplicate });
    await expect(insertRaw({ token_hash: duplicate })).rejects.toThrow();
  });
});
