// token-create / token-list / token-revoke を崩す手口。test/api-token-settings.test.ts（正常系と基本の断り方）と重ならないものだけを置く:
// 名前の Unicode、期限ちょうど、同時の呼び出し、Authorization の書き方、入力の汚染、ログ、ログインできる条件を失った人
/* eslint-disable db-entry/guard -- sessions と api_tokens の行を、入口を通さず D1 に直に読んで確かめるため */
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { tokenCreate, tokenList, tokenRevoke } from '../src/shared/operations/session/index.ts';
import { createApp } from '../src/server/app.ts';
import { issueApiToken } from '../src/server/auth/api-token.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { insertApiToken, tokenRow, tokenRowsOf } from './operations/api-token.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { operatorPing, provisionalOperations, whoAmI } from './operations/provisional.ts';
import { createPerson, createLoginPerson, getOperator, testEnv, type Person } from './operations/world.ts';
import { createOrganization, createAccount } from './factories.ts';

const app = createApp([...implementedOperations, ...provisionalOperations]);
const DAY_MS = 24 * 60 * 60 * 1000;
const future = (days = 30) => new Date(Date.now() + days * DAY_MS).toISOString();

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const create = (person: Person, body: unknown) => post(app, tokenCreate, { token: person.token, body });
const list = (person: Person) => post(app, tokenList, { token: person.token });
const revoke = (person: Person, id: string) => post(app, tokenRevoke, { token: person.token, body: { id } });
const callWhoAmI = (bearer: string) => post(app, whoAmI, { bearer, origin: null });

async function listed(person: Person) {
  const res = await list(person);
  expect(res.status).toBe(200);
  return ((await res.json()) as { tokens: { id: string; name: string; expires_at: string }[] }).tokens;
}

async function sessionCount(accountId: string): Promise<number> {
  const row = await env.DB.prepare('select count(*) as n from sessions where account_id = ?')
    .bind(accountId)
    .first<{ n: number }>();
  return row!.n;
}

// Date だけを止める（D1 や setTimeout は実時間のまま）
function freezeNow(): Date {
  const now = new Date();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  return now;
}

describe('名前の Unicode', () => {
  test('全角空白、BOM、改行だけの名前は空と同じに 400。前後の全角空白は除く', async () => {
    const person = await createLoginPerson();
    for (const name of ['　', '　　', '﻿', ' ', '  ', ' 　\t ']) {
      const res = await create(person, { name, scope: 'read' });
      expect(res.status, JSON.stringify(name)).toBe(400);
    }
    const res = await create(person, { name: '　手元　', scope: 'read' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe('手元');
    expect(await tokenRowsOf(person.accountId)).toHaveLength(1);
  });

  test('日本語・結合文字・絵文字の名前が、発行の応答、DB、一覧で同じ文字列のまま往復する', async () => {
    const person = await createLoginPerson();
    const names = ['手元の端末 🖥️', 'é゙', '👨‍👩‍👧‍👦', 'a​b', 'line1\nline2', 'tab\there'];
    for (const name of names) {
      const res = await create(person, { name, scope: 'read' });
      expect(res.status, JSON.stringify(name)).toBe(200);
      const body = (await res.json()) as { id: string; name: string };
      expect(body.name).toBe(name);
      expect((await tokenRow(body.id))!.name).toBe(name);
    }
    expect((await listed(person)).map((token) => token.name).sort()).toEqual([...names].sort());
  });

  test('100文字の前後の長さでは、通った名前は DB の CHECK で落ちず（5xx にならず）200 か 400 になる', async () => {
    // 100 を挟んで、DB の length（コードポイント）で CHECK を通る長さなら 200、通らないなら 400 であり 500 ではない
    const person = await createLoginPerson();
    for (const name of [
      'é'.repeat(100),
      'é'.repeat(50),
      'é'.repeat(51),
      '😀'.repeat(50),
      '😀'.repeat(51),
      '😀'.repeat(100),
    ]) {
      const res = await create(person, { name, scope: 'read' });
      expect([200, 400], `${[...name].length} 文字 / ${name.length} 単位`).toContain(res.status);
    }
  });

  test('絵文字（サロゲートペア）51個は51文字なので100文字以内として通る', async () => {
    // 51個の絵文字は51文字（UTF-16 では102単位）。Issue の「1〜100文字」と DB の CHECK（コードポイント数）に合わせて通す
    const person = await createLoginPerson();
    const res = await create(person, { name: '😀'.repeat(51), scope: 'read' });
    expect(res.status).toBe(200);
  });

  test('対のないサロゲートの名前は、応答の name と DB・一覧の name が食い違わない（D1 は U+FFFD に変えて保存する）', async () => {
    const person = await createLoginPerson();
    // 対のないサロゲートの文字列は、そのまま比較すると失敗の表示で壊れるので、エスケープした形で比べる
    const res = await post(app, tokenCreate, {
      token: person.token,
      rawBody: '{"name":"bad\\ud800name","scope":"read"}',
    });
    expect(res.status).toBeLessThan(500);
    if (res.status === 200) {
      const body = (await res.json()) as { id: string; name: string };
      expect(JSON.stringify((await tokenRow(body.id))!.name)).toBe(JSON.stringify(body.name));
    } else {
      expect(res.status).toBe(400);
      expect(await tokenRowsOf(person.accountId)).toHaveLength(0);
    }
  });

  test('NUL 文字を含む名前は 5xx にならず、通るなら一覧まで往復する', async () => {
    const person = await createLoginPerson();
    const res = await create(person, { name: 'a\u0000b', scope: 'write' });
    expect(res.status).toBeLessThan(500);
    if (res.status === 200) expect((await listed(person))[0]!.name).toBe('a\u0000b');
  });
});

describe('期限ちょうどと並び', () => {
  test('expires_at が now ちょうどの行は、一覧に出ず、Bearer は 401 で、取消は成功する。1ms 後なら有効', async () => {
    const person = await createLoginPerson();
    const now = freezeNow();
    const atNow = await insertApiToken(person.accountId, { name: 'ちょうど', expiresAt: now.toISOString() });
    const later = await insertApiToken(person.accountId, {
      name: '1ms後',
      expiresAt: new Date(now.getTime() + 1).toISOString(),
    });
    expect((await listed(person)).map((token) => token.id)).toEqual([later.hash]);
    expect((await callWhoAmI(atNow.raw)).status).toBe(401);
    expect((await callWhoAmI(later.raw)).status).toBe(200);
    expect((await revoke(person, atNow.hash)).status).toBe(200);
    expect((await tokenRow(atNow.hash))!.revoked_at).toBe(now.toISOString());
  });

  test('発行直後の expires_at は、固定した now の lifetime_days 日後ちょうど', async () => {
    const person = await createLoginPerson();
    const now = freezeNow();
    for (const days of [1, 90]) {
      const res = await create(person, { name: `d${days}`, scope: 'read', lifetime_days: days });
      expect(((await res.json()) as { expires_at: string }).expires_at).toBe(
        new Date(now.getTime() + days * DAY_MS).toISOString(),
      );
    }
  });

  test('created_at が同じ行が並んでも、一覧は全件を出し、呼ぶたびに同じ順', async () => {
    const person = await createLoginPerson();
    const hashes: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      hashes.push(
        (await insertApiToken(person.accountId, { name: `t${i}`, createdAt: '2026-10-20T00:00:00.000Z' })).hash,
      );
    }
    const first = (await listed(person)).map((token) => token.id);
    const second = (await listed(person)).map((token) => token.id);
    expect(first.sort()).toEqual([...hashes].sort());
    expect((await listed(person)).map((token) => token.id)).toEqual(second);
    expect(new Set(second).size).toBe(8);
  });

  test('created_at が違えば、行を足した順によらず新しい方が先', async () => {
    const person = await createLoginPerson();
    const newest = await insertApiToken(person.accountId, { createdAt: '2026-10-25T00:00:00.000Z' });
    const oldest = await insertApiToken(person.accountId, { createdAt: '2026-10-01T00:00:00.000Z' });
    const middle = await insertApiToken(person.accountId, { createdAt: '2026-10-10T00:00:00.000Z' });
    expect((await listed(person)).map((token) => token.id)).toEqual([newest.hash, middle.hash, oldest.hash]);
  });

  test('使っても expires_at は延びず、last_used_at だけが進む', async () => {
    const person = await createLoginPerson();
    const { raw, hash } = await insertApiToken(person.accountId, { expiresAt: future(3), lastUsedAt: null });
    const before = (await tokenRow(hash))!;
    for (let i = 0; i < 3; i += 1) expect((await callWhoAmI(raw)).status).toBe(200);
    const after = (await tokenRow(hash))!;
    expect(after.expires_at).toBe(before.expires_at);
    expect(after.created_at).toBe(before.created_at);
    expect(after.last_used_at).not.toBeNull();
    const [row] = await listed(person);
    expect(row!.expires_at).toBe(before.expires_at);
  });
});

describe('並行と再送', () => {
  test('同時の token-create 20件は、20行・別々の生の値と id になり、行ごとの値が応答と一致する', async () => {
    const person = await createLoginPerson();
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) => create(person, { name: `n${i}`, scope: i % 2 === 0 ? 'read' : 'write' })),
    );
    const bodies = await Promise.all(
      responses.map(async (res) => {
        expect(res.status).toBe(200);
        return (await res.json()) as { id: string; name: string; scope: string; token: string };
      }),
    );
    expect(new Set(bodies.map((body) => body.id)).size).toBe(20);
    expect(new Set(bodies.map((body) => body.token)).size).toBe(20);
    const rows = await tokenRowsOf(person.accountId);
    expect(rows).toHaveLength(20);
    for (const body of bodies) {
      const row = rows.find((candidate) => candidate.token_hash === body.id);
      expect(row, body.name).toMatchObject({ name: body.name, scope: body.scope });
    }
  });

  test('同じ id への同時の token-revoke は、全部 200 で、revoked_at は1つの値のまま', async () => {
    const person = await createLoginPerson();
    const { hash } = await insertApiToken(person.accountId);
    const responses = await Promise.all(Array.from({ length: 10 }, () => revoke(person, hash)));
    for (const res of responses) expect(res.status).toBe(200);
    const row = (await tokenRow(hash))!;
    expect(row.revoked_at).not.toBeNull();
    // 再送しても書き換わらない
    await revoke(person, hash);
    expect((await tokenRow(hash))!.revoked_at).toBe(row.revoked_at);
  });

  test('取消と同時の API 呼び出しの後は、必ずそのトークンが 401', async () => {
    const person = await createLoginPerson();
    const { raw, hash } = await insertApiToken(person.accountId);
    const results = await Promise.all([callWhoAmI(raw), callWhoAmI(raw), revoke(person, hash), callWhoAmI(raw)]);
    expect(results[2]!.status).toBe(200);
    for (const res of [results[0]!, results[1]!, results[3]!]) expect([200, 401]).toContain(res.status);
    expect((await callWhoAmI(raw)).status).toBe(401);
    // 使われた記録が取消を巻き戻さない
    expect((await tokenRow(hash))!.revoked_at).not.toBeNull();
    expect(await listed(person)).toHaveLength(0);
  });

  test('発行と取消の同時実行: 取り消すのは指した行だけで、同時に発行した行は残る', async () => {
    const person = await createLoginPerson();
    const old = await insertApiToken(person.accountId);
    const [created, revoked] = await Promise.all([
      create(person, { name: '新', scope: 'read' }),
      revoke(person, old.hash),
    ]);
    expect(created.status).toBe(200);
    expect(revoked.status).toBe(200);
    const id = ((await created.json()) as { id: string }).id;
    expect((await listed(person)).map((token) => token.id)).toEqual([id]);
  });

  test('同時の token-create と別アカウントの token-list は、互いの行を見せない', async () => {
    const [a, b] = await Promise.all([createLoginPerson(), createLoginPerson()]);
    await Promise.all(Array.from({ length: 5 }, (_, i) => create(a, { name: `a${i}`, scope: 'read' })));
    const [listA, listB] = await Promise.all([listed(a), listed(b)]);
    expect(listA).toHaveLength(5);
    expect(listB).toHaveLength(0);
  });
});

describe('発行の途中失敗', () => {
  test('issueApiToken は範囲外の日数で例外を投げ、行を作らない', async () => {
    const person = await createLoginPerson();
    for (const lifetimeDays of [0, -1, 91, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        issueApiToken(testEnv, {
          accountId: person.accountId,
          name: 'x',
          scope: 'read',
          now: new Date(),
          lifetimeDays,
        }),
      ).rejects.toThrow();
    }
    expect(await tokenRowsOf(person.accountId)).toHaveLength(0);
  });

  test('存在しないアカウントへの発行は例外になり、行が残らない', async () => {
    const accountId = 'no-such-account';
    await expect(issueApiToken(testEnv, { accountId, name: 'x', scope: 'read', now: new Date() })).rejects.toThrow();
    expect(await tokenRowsOf(accountId)).toHaveLength(0);
  });
});

describe('越境', () => {
  test('他人の取り消し済み・期限切れの行の id も、存在しない id と同じ 404 で本文も同じ', async () => {
    const [me, other] = await Promise.all([createLoginPerson(), createLoginPerson()]);
    const revoked = await insertApiToken(other.accountId, { revokedAt: '2026-10-21T00:00:00.000Z' });
    const expired = await insertApiToken(other.accountId, { expiresAt: '2026-10-01T00:00:00.000Z' });
    const missing = await revoke(me, 'f'.repeat(64));
    const missingBody = await missing.text();
    for (const hash of [revoked.hash, expired.hash]) {
      const res = await revoke(me, hash);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(missingBody);
    }
    expect((await tokenRow(revoked.hash))!.revoked_at).toBe('2026-10-21T00:00:00.000Z');
    expect((await tokenRow(expired.hash))!.revoked_at).toBeNull();
  });

  test('id の前後の改行・NUL・% と _ のワイルドカードは 400 で、行は変わらない', async () => {
    const person = await createLoginPerson();
    const { hash } = await insertApiToken(person.accountId);
    const bad = [
      `${hash}\n`,
      `\n${hash}`,
      `${hash}\u0000`,
      '%'.repeat(64),
      '_'.repeat(64),
      `${hash.slice(0, 32)}%`,
      '0'.repeat(63) + '%',
    ];
    for (const id of bad) {
      const res = await revoke(person, id);
      expect(res.status, JSON.stringify(id)).toBe(400);
    }
    expect((await tokenRow(hash))!.revoked_at).toBeNull();
  });

  test('取消は、他のアカウントの行・自分の他の行・セッションに触れない', async () => {
    const [me, other] = await Promise.all([createLoginPerson(), createLoginPerson()]);
    const target = await insertApiToken(me.accountId, { name: '対象' });
    const sibling = await insertApiToken(me.accountId, { name: '兄弟' });
    const foreign = await insertApiToken(other.accountId, { name: '他人' });
    const snapshot = async (hash: string) => JSON.stringify(await tokenRow(hash));
    const [siblingBefore, foreignBefore] = [await snapshot(sibling.hash), await snapshot(foreign.hash)];
    const sessionsBefore = [await sessionCount(me.accountId), await sessionCount(other.accountId)];
    expect((await revoke(me, target.hash)).status).toBe(200);
    expect(await snapshot(sibling.hash)).toBe(siblingBefore);
    expect(await snapshot(foreign.hash)).toBe(foreignBefore);
    expect([await sessionCount(me.accountId), await sessionCount(other.accountId)]).toEqual(sessionsBefore);
    // 取り消した後も、Cookie のセッションは使える
    expect((await list(me)).status).toBe(200);
  });

  test('運用者の Cookie でも発行・一覧・取消ができ、その write トークンは運用者の操作を呼べない', async () => {
    const operator = await getOperator();
    const res = await create(operator, { name: '運用', scope: 'write' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; token: string };
    expect((await listed(operator)).map((token) => token.id)).toContain(body.id);
    const ping = await post(app, operatorPing, { bearer: body.token, origin: null });
    expect(ping.status).toBe(403);
    expect(await errorCodeOf(ping)).toBe('forbidden');
    expect((await revoke(operator, body.id)).status).toBe(200);
  });

  test('運用者の一覧に他のアカウントのトークンは出ない', async () => {
    const [operator, person] = await Promise.all([getOperator(), createLoginPerson()]);
    const mine = await insertApiToken(person.accountId, { expiresAt: future() });
    expect((await listed(operator)).map((token) => token.id)).not.toContain(mine.hash);
  });
});

// #639: 入れる組織を失ってもアカウントがあればログインできるので、トークンの画面の操作（組織の外）も使える
describe('入れる組織を失った人', () => {
  async function strandedPerson(): Promise<Person> {
    // どの組織にも入れない（組織の人が無効）。セッションの行は残っている
    return createPerson({ organization: await createOrganization(), admin: true, disabled: true });
  }

  test('セッションの Cookie で、発行・一覧・取消のどれも 200 で、行が足され、取り消される', async () => {
    const person = await strandedPerson();
    const existing = await insertApiToken(person.accountId, { expiresAt: future() });
    const created = await create(person, { name: 'x', scope: 'read' });
    expect(created.status).toBe(200);
    expect((await list(person)).status).toBe(200);
    expect((await revoke(person, existing.hash)).status).toBe(200);
    const rows = await tokenRowsOf(person.accountId);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.token_hash === existing.hash)?.revoked_at).not.toBeNull();
  });

  test('同じ人のトークンの Bearer も 200', async () => {
    const person = await strandedPerson();
    const { raw } = await insertApiToken(person.accountId, { expiresAt: future() });
    expect((await callWhoAmI(raw)).status).toBe(200);
  });

  test('組織を1つも持たない（users の行が無い）アカウントも Cookie の token-create は 200', async () => {
    const account = await createAccount();
    const { createSessionWithToken } = await import('./factories.ts');
    const { token } = await createSessionWithToken(account.id);
    const res = await post(app, tokenCreate, { token, body: { name: 'x', scope: 'read' } });
    expect(res.status).toBe(200);
    expect(await tokenRowsOf(account.id)).toHaveLength(1);
  });
});

describe('Authorization の書き方と Origin', () => {
  const calls = [
    ['token-create', tokenCreate, { name: 'a', scope: 'read' }],
    ['token-list', tokenList, {}],
  ] as const;

  test('空の Bearer は、有効な Cookie と Origin があっても 401 で、Cookie に落とさない', async () => {
    const person = await createLoginPerson();
    for (const header of ['Bearer', 'Bearer ', 'Bearer  \t']) {
      for (const [name, definition, body] of calls) {
        const res = await post(app, definition, { token: person.token, headers: { Authorization: header }, body });
        expect(res.status, `${name} ${JSON.stringify(header)}`).toBe(401);
      }
      const res = await post(app, tokenRevoke, {
        token: person.token,
        headers: { Authorization: header },
        body: { id: 'a'.repeat(64) },
      });
      expect(res.status).toBe(401);
    }
    expect(await tokenRowsOf(person.accountId)).toHaveLength(0);
  });

  test('Bearer の前後に空白が多くても、有効なトークンは 403 の扱い（Cookie の呼び出しとして通らない）', async () => {
    const person = await createLoginPerson();
    const { raw } = await insertApiToken(person.accountId, { scope: 'write', expiresAt: future() });
    for (const bearer of [` ${raw}`, `${raw} `, ` ${raw} `]) {
      const res = await post(app, tokenCreate, { bearer, origin: null, body: { name: 'a', scope: 'read' } });
      expect([401, 403], JSON.stringify(bearer)).toContain(res.status);
    }
    expect(await tokenRowsOf(person.accountId)).toHaveLength(1);
  });

  test('Bearer の綴りが違う（bearer、BEARER）有効なトークンだけでは、token-create は成功しない', async () => {
    const person = await createLoginPerson();
    const { raw } = await insertApiToken(person.accountId, { scope: 'write', expiresAt: future() });
    for (const scheme of ['bearer', 'BEARER', 'Token', 'Basic']) {
      const res = await post(app, tokenCreate, {
        headers: { Authorization: `${scheme} ${raw}` },
        body: { name: 'a', scope: 'read' },
      });
      expect(res.status, scheme).toBe(401);
    }
    expect(await tokenRowsOf(person.accountId)).toHaveLength(1);
  });

  test('Cookie の呼び出しで Origin が似て非なる値（サフィックス、末尾のスラッシュ、"null"、大文字）だと 403', async () => {
    const person = await createLoginPerson();
    const origin = testEnv.PUBLIC_ORIGIN;
    for (const bad of [
      `${origin}.evil.example`,
      `${origin}/`,
      'null',
      origin.toUpperCase(),
      `${origin}:444`,
      `x${origin}`,
    ]) {
      const res = await post(app, tokenCreate, {
        token: person.token,
        origin: bad,
        body: { name: 'a', scope: 'read' },
      });
      expect(res.status, bad).toBe(403);
    }
    expect(await tokenRowsOf(person.accountId)).toHaveLength(0);
  });

  test('Cookie が別の人のセッション、Bearer が自分のトークンのとき、Bearer の持ち主が優先され 403', async () => {
    const [a, b] = await Promise.all([createLoginPerson(), createLoginPerson()]);
    const bearer = await insertApiToken(a.accountId, { scope: 'write', expiresAt: future() });
    const res = await post(app, tokenCreate, {
      token: b.token,
      bearer: bearer.raw,
      body: { name: 'a', scope: 'read' },
    });
    expect(res.status).toBe(403);
    expect(await tokenRowsOf(b.accountId)).toHaveLength(0);
    expect(await tokenRowsOf(a.accountId)).toHaveLength(1);
  });
});

describe('入力のスキーマ', () => {
  test('__proto__ と constructor のキーは効かず、scope と名前は渡した値のまま', async () => {
    const person = await createLoginPerson();
    const res = await post(app, tokenCreate, {
      token: person.token,
      rawBody:
        '{"name":"p","scope":"read","__proto__":{"scope":"write","lifetime_days":1},"constructor":{"prototype":{"polluted":true}}}',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; scope: string; expires_at: string };
    expect(body.scope).toBe('read');
    expect(Date.parse(body.expires_at)).toBeGreaterThan(Date.now() + 80 * DAY_MS);
    expect((await tokenRow(body.id))!.scope).toBe('read');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).scope).toBeUndefined();
  });

  test('token-revoke の __proto__ は id を差し替えられない', async () => {
    const person = await createLoginPerson();
    const { hash } = await insertApiToken(person.accountId);
    const res = await post(app, tokenRevoke, {
      token: person.token,
      rawBody: `{"id":"${'a'.repeat(64)}","__proto__":{"id":"${hash}"}}`,
    });
    expect(res.status).toBe(404);
    expect((await tokenRow(hash))!.revoked_at).toBeNull();
  });

  test('本文が配列、null、文字列、数値、空は 400（3操作のうち入力を読む2つ）', async () => {
    const person = await createLoginPerson();
    for (const rawBody of ['[]', 'null', '"x"', '1', '', '[{"name":"a","scope":"read"}]', 'true']) {
      for (const definition of [tokenCreate, tokenRevoke]) {
        const res = await post(app, definition, { token: person.token, rawBody });
        expect(res.status, `${definition.name} ${rawBody}`).toBe(400);
      }
    }
    expect(await tokenRowsOf(person.accountId)).toHaveLength(0);
  });

  test('1MB の名前と 5MB の本文は 5xx にならず、行が増えない', async () => {
    const person = await createLoginPerson();
    const huge = await create(person, { name: 'a'.repeat(1_000_000), scope: 'read' });
    expect(huge.status).toBe(400);
    const bigBody = await post(app, tokenCreate, {
      token: person.token,
      rawBody: JSON.stringify({ name: 'a', scope: 'read', pad: 'x'.repeat(5_000_000) }),
    });
    expect(bigBody.status).toBeLessThan(500);
    expect(await tokenRowsOf(person.accountId)).toHaveLength(bigBody.status === 200 ? 1 : 0);
  });

  test('lifetime_days を指数表記で渡す: 1e0 は1日、9e1 は90日、1e2 と 1e400 は 400', async () => {
    const person = await createLoginPerson();
    const post_ = (days: string) =>
      post(app, tokenCreate, { token: person.token, rawBody: `{"name":"a","scope":"read","lifetime_days":${days}}` });
    expect((await post_('1e0')).status).toBe(200);
    expect((await post_('9e1')).status).toBe(200);
    expect((await post_('4.0')).status).toBe(200);
    for (const days of ['1e2', '1e400', '-0', '0.0', '9007199254740993', '90.000001']) {
      expect((await post_(days)).status, days).toBe(400);
    }
    expect(await tokenRowsOf(person.accountId)).toHaveLength(3);
  });

  test('scope や name の配列・オブジェクト・同名の重複キー（後勝ち）', async () => {
    const person = await createLoginPerson();
    for (const rawBody of [
      '{"name":["a"],"scope":"read"}',
      '{"name":{"a":1},"scope":"read"}',
      '{"name":"a","scope":{"toString":"read"}}',
      '{"name":"a","scope":["read","write"]}',
    ]) {
      expect((await post(app, tokenCreate, { token: person.token, rawBody })).status, rawBody).toBe(400);
    }
    // 後に書いた scope が採用される。write が混ざっても read を超えない確認ではなく、重複を許す JSON の挙動を固定する
    const res = await post(app, tokenCreate, {
      token: person.token,
      rawBody: '{"name":"a","scope":"write","scope":"read"}',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { scope: string }).scope).toBe('read');
  });
});

describe('生の値の漏れ', () => {
  const secretName = 'SECRET-NAME-5f3a';

  test('エラー応答（400・401・403・404）の本文に、送った名前・id・Bearer の値が載らない', async () => {
    const person = await createLoginPerson();
    const bearer = await insertApiToken(person.accountId, { scope: 'write', expiresAt: future() });
    const missingId = 'b'.repeat(64);
    const responses = [
      await create(person, { name: secretName, scope: 'admin' }),
      await post(app, tokenRevoke, { token: person.token, body: { id: `${missingId}Z` } }),
      await revoke(person, missingId),
      await post(app, tokenCreate, { bearer: bearer.raw, origin: null, body: { name: secretName, scope: 'read' } }),
      await post(app, tokenCreate, { bearer: `sgp_${'Q'.repeat(43)}`, body: { name: secretName, scope: 'read' } }),
    ];
    for (const res of responses) {
      const text = await res.text();
      expect(text).not.toContain(secretName);
      expect(text).not.toContain(missingId);
      expect(text).not.toContain(bearer.raw);
      expect(text).not.toContain(bearer.raw.slice(4));
      expect(text).not.toContain(bearer.hash);
      expect(text).not.toContain('Q'.repeat(43));
    }
  });

  test('取消の応答は {} だけで、取り消した id も値も返さない。取消済みの再取消も同じ', async () => {
    const person = await createLoginPerson();
    const { raw, hash } = await insertApiToken(person.accountId);
    for (let i = 0; i < 2; i += 1) {
      const text = await (await revoke(person, hash)).text();
      expect(JSON.parse(text)).toEqual({});
      expect(text).not.toContain(hash);
      expect(text).not.toContain(raw);
    }
  });

  test('失敗した呼び出しのログにも、名前・id・Bearer の値・ハッシュが出ない', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const person = await createLoginPerson();
    const bearer = await insertApiToken(person.accountId, { scope: 'write', expiresAt: future() });
    const missingId = 'c'.repeat(64);
    await create(person, { name: secretName, scope: 'admin' });
    await revoke(person, missingId);
    await post(app, tokenRevoke, { token: person.token, body: { id: `${missingId}!` } });
    await post(app, tokenCreate, { bearer: bearer.raw, origin: null, body: { name: secretName, scope: 'read' } });
    await post(app, tokenList, { bearer: `sgp_${'R'.repeat(43)}` });
    await callWhoAmI(bearer.raw);
    const output = [...log.mock.calls, ...error.mock.calls, ...warn.mock.calls].flat().map(String).join('\n');
    expect(output).toContain('token-revoke');
    for (const secret of [secretName, missingId, bearer.raw, bearer.raw.slice(4), bearer.hash, 'R'.repeat(43)]) {
      expect(output).not.toContain(secret);
    }
  });

  test('一覧は何度呼んでも、行のキーが6つだけで、値・ハッシュ・account_id・revoked_at を含まない', async () => {
    const person = await createLoginPerson();
    const issued = await create(person, { name: 'k', scope: 'write' });
    const { token } = (await issued.json()) as { token: string };
    const text = await (await list(person)).text();
    expect(text).not.toContain(token);
    expect(text).not.toContain(token.slice(4));
    for (const key of ['token_hash', 'account_id', 'revoked_at', '"token"']) expect(text).not.toContain(key);
    const [row] = (JSON.parse(text) as { tokens: Record<string, unknown>[] }).tokens;
    expect(Object.keys(row!).sort()).toEqual(['created_at', 'expires_at', 'id', 'last_used_at', 'name', 'scope']);
  });
});
