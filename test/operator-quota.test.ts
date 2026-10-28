// 運用者の組織の人数と添付ファイルの上限の変更（organization-quota-update）の結合テスト。
// 組織の分離と権限の一覧のテスト（test/operation-registry.test.ts）は、この操作も回す。
// ここでは、上限の変更に固有の振る舞い（同じ値、競合の 409、範囲の外の 400、attachment_quota_warned_at の戻し方、
// 履歴の行、履歴を書けなくても成功すること）を確かめる
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb, insertOrganization, orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks, verifiedOrganizationForTest } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import {
  ATTACHMENT_QUOTA_MAX_BYTES,
  listOrganizations,
  MEMBER_LIMIT_MAX,
  organizationQuotaUpdate,
  quotaTiers,
} from '../src/shared/operations/operator/index.ts';
import { organizationHistory } from '../src/shared/operations/organization/organization-history.ts';
import { createOrganization } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import {
  admitElsewhere,
  createPerson,
  createTarget,
  getOperator,
  OPERATOR_LOGIN_ID,
  testEnv,
  withNewSession,
} from './operations/world.ts';

const app = createApp(implementedOperations);

afterEach(() => {
  vi.restoreAllMocks();
});

const GIB = 1024 ** 3;
const SMALL = { member_limit: 15, attachment_quota_bytes: 30 * GIB };
const STANDARD = { member_limit: 50, attachment_quota_bytes: 100 * GIB };
const WARNED_AT = '2026-10-20T00:00:00.000Z';

const operatorToken = async () => (await withNewSession(await getOperator())).token;

async function organizationRow(id: string) {
  const db = commonDb(env);
  return db.first(db.statement((q) => q.selectFrom('organizations').selectAll().where('id', '=', id)));
}

async function changeLogsOf(organizationId: string) {
  const db = orgDb(env, verifiedOrganizationForTest(organizationId));
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('entity_type', '=', 'organization')
        .orderBy('created_at'),
    ),
  );
}

type Quota = { member_limit: number; attachment_quota_bytes: number };

// slug の組織の今の上限。無い slug は小さい組織の値
async function currentQuotaOf(slug: string): Promise<Quota> {
  const db = commonDb(env);
  const row = await db.first(
    db.statement((q) =>
      q.selectFrom('organizations').select(['member_limit', 'attachment_quota_bytes']).where('slug', '=', slug),
    ),
  );
  return row ?? SMALL;
}

// expected（画面が見ていた前の値）を渡さなければ、呼ぶ前の今の値を渡す（画面が最新の一覧から開いたときと同じ）
async function changeQuotaBy(token: string, slug: string, quota: Quota, options: { expected?: Quota; env?: Env } = {}) {
  const expected = options.expected ?? (await currentQuotaOf(slug));
  return post(app, organizationQuotaUpdate, { token, body: { slug, ...quota, expected }, env: options.env });
}

describe('値段の段階', () => {
  test('小さい組織は 15 人と 30 GB、標準は 50 人と 100 GB。小さい組織は列の既定と同じ', () => {
    expect(
      quotaTiers.map(({ member_limit, attachment_quota_bytes }) => ({ member_limit, attachment_quota_bytes })),
    ).toEqual([SMALL, STANDARD]);
    expect(SMALL.attachment_quota_bytes).toBe(32212254720);
  });
});

describe('上限の変更', () => {
  test('人数と添付ファイルの上限を書き換え、一覧の上限も変わる', async () => {
    const organization = await createOrganization();
    const token = await operatorToken();
    const res = await changeQuotaBy(token, organization.slug, STANDARD);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: organization.slug, ...STANDARD });
    const row = await organizationRow(organization.id);
    expect(row).toMatchObject(STANDARD);
    expect(row?.updated_at).not.toBe(organization.updated_at);

    const listed = (await (await post(app, listOrganizations, { token })).json()) as {
      organizations: { slug: string; seats: { limit: number }; attachment_quota_bytes: number }[];
    };
    const item = listed.organizations.find((entry) => entry.slug === organization.slug);
    expect(item?.seats.limit).toBe(50);
    expect(item?.attachment_quota_bytes).toBe(100 * GIB);
  });

  test('段階に無い値（51 人以上）も入れられ、停止中の組織も変えられる', async () => {
    const organization = await createOrganization({ suspended_at: WARNED_AT });
    const res = await changeQuotaBy(await operatorToken(), organization.slug, {
      member_limit: 120,
      attachment_quota_bytes: 250 * GIB,
    });
    expect(res.status).toBe(200);
    expect(await organizationRow(organization.id)).toMatchObject({
      member_limit: 120,
      attachment_quota_bytes: 250 * GIB,
      suspended_at: WARNED_AT,
    });
  });

  test('人数を今の人数より小さくしてもよい（今いる人は残る）', async () => {
    const target = await createTarget();
    const res = await changeQuotaBy(await operatorToken(), target.slug, {
      member_limit: 1,
      attachment_quota_bytes: 30 * GIB,
    });
    expect(res.status).toBe(200);
    expect((await organizationRow(target.organization.id))?.member_limit).toBe(1);
  });

  test('今と同じ値なら何も書かず、履歴も残さず、今の値を返す', async () => {
    const organization = await createOrganization({ attachment_quota_warned_at: WARNED_AT });
    const res = await changeQuotaBy(await operatorToken(), organization.slug, SMALL);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: organization.slug, ...SMALL });
    expect(await organizationRow(organization.id)).toMatchObject({
      updated_at: organization.updated_at,
      attachment_quota_warned_at: WARNED_AT,
    });
    expect(await changeLogsOf(organization.id)).toEqual([]);
  });

  test('0 以下、小数、上限を超える値は 400 の invalid_input で、書き換えない', async () => {
    const organization = await createOrganization();
    const token = await operatorToken();
    for (const quota of [
      { member_limit: 0, attachment_quota_bytes: 30 * GIB },
      { member_limit: -1, attachment_quota_bytes: 30 * GIB },
      { member_limit: 15, attachment_quota_bytes: 0 },
      { member_limit: 15, attachment_quota_bytes: -GIB },
      { member_limit: 1.5, attachment_quota_bytes: 30 * GIB },
      { member_limit: MEMBER_LIMIT_MAX + 1, attachment_quota_bytes: 30 * GIB },
      { member_limit: 15, attachment_quota_bytes: ATTACHMENT_QUOTA_MAX_BYTES + 1 },
    ]) {
      const res = await changeQuotaBy(token, organization.slug, quota);
      expect(res.status, JSON.stringify(quota)).toBe(400);
      expect(await errorCodeOf(res)).toBe('invalid_input');
    }
    // 画面が見ていた前の値（expected）も同じ範囲で検証する。無ければ断る
    for (const expected of [
      { member_limit: 0, attachment_quota_bytes: 30 * GIB },
      { member_limit: 15, attachment_quota_bytes: 0 },
    ]) {
      const res = await changeQuotaBy(token, organization.slug, STANDARD, { expected });
      expect(res.status, JSON.stringify(expected)).toBe(400);
      expect(await errorCodeOf(res)).toBe('invalid_input');
    }
    const missing = await post(app, organizationQuotaUpdate, {
      token,
      body: { slug: organization.slug, ...STANDARD },
    });
    expect(missing.status).toBe(400);
    expect(await organizationRow(organization.id)).toMatchObject(SMALL);
    expect(await changeLogsOf(organization.id)).toEqual([]);
  });

  test('範囲の両端（1 と上限）は受け付ける', async () => {
    const organization = await createOrganization();
    const token = await operatorToken();
    expect((await changeQuotaBy(token, organization.slug, { member_limit: 1, attachment_quota_bytes: 1 })).status).toBe(
      200,
    );
    const top = { member_limit: MEMBER_LIMIT_MAX, attachment_quota_bytes: ATTACHMENT_QUOTA_MAX_BYTES };
    expect((await changeQuotaBy(token, organization.slug, top)).status).toBe(200);
    expect(await organizationRow(organization.id)).toMatchObject(top);
  });

  test('無い slug は 404 の not_found', async () => {
    const res = await changeQuotaBy(await operatorToken(), 'no-such-organization', STANDARD);
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe('not_found');
  });

  test('運用者でない人は 403 で、書き換えない', async () => {
    const target = await createTarget();
    const stayer = await admitElsewhere(target.admin);
    const outsider = await admitElsewhere(await createPerson());
    for (const person of [stayer, outsider]) {
      const res = await changeQuotaBy(person.token, target.slug, STANDARD);
      expect(res.status).toBe(403);
      expect(await errorCodeOf(res)).toBe('forbidden');
    }
    expect(await organizationRow(target.organization.id)).toMatchObject(SMALL);
  });

  test('読んだ後に別の運用者が先に変えていれば 409 で、先の変更を書き換えない', async () => {
    const organization = await createOrganization();
    let armed = true;
    const racing = envWithD1Hooks(testEnv, {
      // 上限を読んだ直後に、別の運用者が変える
      afterQuery: async (sql) => {
        if (!armed || !sql.includes('from "organizations"') || !sql.includes('"attachment_quota_warned_at"')) return;
        armed = false;
        const db = commonDb(env);
        await db.batch([
          db.statement((q) =>
            q.updateTable('organizations').set({ member_limit: 30 }).where('id', '=', organization.id),
          ),
        ]);
      },
    });
    const res = await changeQuotaBy(await operatorToken(), organization.slug, STANDARD, { env: racing });
    expect(armed).toBe(false);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('conflict');
    expect(await organizationRow(organization.id)).toMatchObject({
      member_limit: 30,
      attachment_quota_bytes: 30 * GIB,
    });
    expect(await changeLogsOf(organization.id)).toEqual([]);
  });

  test('画面が見ていた前の値（expected）と今の値が違えば 409 で、先の変更を書き換えない', async () => {
    // ダイアログを開いた後に、別の運用者が 30 人へ変えていた
    const organization = await createOrganization({ member_limit: 30 });
    const res = await changeQuotaBy(await operatorToken(), organization.slug, STANDARD, { expected: SMALL });
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('conflict');
    expect(await organizationRow(organization.id)).toMatchObject({
      member_limit: 30,
      attachment_quota_bytes: 30 * GIB,
      updated_at: organization.updated_at,
    });
    expect(await changeLogsOf(organization.id)).toEqual([]);
  });

  test('前の値が違っても、今の値が送った値と同じなら何も書かずに今の値を返す', async () => {
    const organization = await createOrganization(STANDARD);
    const res = await changeQuotaBy(await operatorToken(), organization.slug, STANDARD, { expected: SMALL });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: organization.slug, ...STANDARD });
    expect((await organizationRow(organization.id))?.updated_at).toBe(organization.updated_at);
    expect(await changeLogsOf(organization.id)).toEqual([]);
  });

  test('上げるときに、読んだ後で 80% の通知の日時が変わっていれば 409 で、履歴を残さない', async () => {
    const organization = await createOrganization();
    let armed = true;
    const racing = envWithD1Hooks(testEnv, {
      // 上限を読んだ直後に、合計が 80% を超えて通知の日時が入る
      afterQuery: async (sql) => {
        if (!armed || !sql.includes('from "organizations"') || !sql.includes('"attachment_quota_warned_at"')) return;
        armed = false;
        const db = commonDb(env);
        await db.batch([
          db.statement((q) =>
            q
              .updateTable('organizations')
              .set({ attachment_quota_warned_at: WARNED_AT })
              .where('id', '=', organization.id),
          ),
        ]);
      },
    });
    const res = await changeQuotaBy(await operatorToken(), organization.slug, STANDARD, { env: racing });
    expect(armed).toBe(false);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('conflict');
    expect(await organizationRow(organization.id)).toMatchObject({ ...SMALL, attachment_quota_warned_at: WARNED_AT });
    expect(await changeLogsOf(organization.id)).toEqual([]);
  });

  test('片方の組織の上限を変えても、もう片方の組織の列と履歴は変わらない', async () => {
    const changed = await createOrganization();
    const other = await createOrganization({ attachment_quota_warned_at: WARNED_AT });
    const otherBefore = await organizationRow(other.id);
    expect((await changeQuotaBy(await operatorToken(), changed.slug, STANDARD)).status).toBe(200);
    expect(await organizationRow(changed.id)).toMatchObject(STANDARD);
    expect(await organizationRow(other.id)).toEqual(otherBefore);
    expect(await changeLogsOf(other.id)).toEqual([]);
    expect(await changeLogsOf(changed.id)).toHaveLength(1);
  });
});

describe('作成の既定', () => {
  test('実際の組織の作成で入る上限は、段階の小さい組織の値と同じ', async () => {
    const slug = `quota-${crypto.randomUUID().slice(0, 8)}`;
    const created = await insertOrganization(testEnv, {
      slug,
      name: '既定の上限の組織',
      createdByOperator: OPERATOR_LOGIN_ID,
      now: new Date(),
    });
    expect(created).not.toBe('slug_taken');
    const small = quotaTiers.find((tier) => tier.id === 'small')!;
    expect(await currentQuotaOf(slug)).toEqual({
      member_limit: small.member_limit,
      attachment_quota_bytes: small.attachment_quota_bytes,
    });
  });
});

describe('80% の通知の日時', () => {
  test('添付ファイルの上限を上げたら空に戻す', async () => {
    const organization = await createOrganization({ attachment_quota_warned_at: WARNED_AT });
    expect((await changeQuotaBy(await operatorToken(), organization.slug, STANDARD)).status).toBe(200);
    expect((await organizationRow(organization.id))?.attachment_quota_warned_at).toBeNull();
  });

  test('添付ファイルの上限を下げたときと、人数だけを変えたときは触らない', async () => {
    const lowered = await createOrganization({ attachment_quota_warned_at: WARNED_AT });
    const seatsOnly = await createOrganization({ attachment_quota_warned_at: WARNED_AT });
    const token = await operatorToken();
    expect(
      (await changeQuotaBy(token, lowered.slug, { member_limit: 15, attachment_quota_bytes: 10 * GIB })).status,
    ).toBe(200);
    expect(
      (await changeQuotaBy(token, seatsOnly.slug, { member_limit: 50, attachment_quota_bytes: 30 * GIB })).status,
    ).toBe(200);
    expect((await organizationRow(lowered.id))?.attachment_quota_warned_at).toBe(WARNED_AT);
    expect((await organizationRow(seatsOnly.id))?.attachment_quota_warned_at).toBe(WARNED_AT);
  });
});

describe('変更の履歴', () => {
  test('運用者の操作として organization の update の行を残し、changes_json は変わった列だけ', async () => {
    const organization = await createOrganization({ attachment_quota_warned_at: WARNED_AT });
    const token = await operatorToken();
    expect((await changeQuotaBy(token, organization.slug, STANDARD)).status).toBe(200);
    // 人数だけを変える。通知の日時はもう空なので入れない
    expect(
      (await changeQuotaBy(token, organization.slug, { member_limit: 60, attachment_quota_bytes: 100 * GIB })).status,
    ).toBe(200);
    // 添付ファイルの上限だけを上げる。通知の日時が空のままなら入れない
    expect(
      (await changeQuotaBy(token, organization.slug, { member_limit: 60, attachment_quota_bytes: 200 * GIB })).status,
    ).toBe(200);

    const [both, seatsOnly, quotaOnly] = await changeLogsOf(organization.id);
    expect(both).toMatchObject({
      organization_id: organization.id,
      workspace_id: null,
      actor_user_id: null,
      operator: OPERATOR_LOGIN_ID,
      entity_type: 'organization',
      entity_id: organization.id,
      action: 'update',
    });
    expect(JSON.parse(both!.changes_json)).toEqual({
      member_limit: [15, 50],
      attachment_quota_bytes: [30 * GIB, 100 * GIB],
      attachment_quota_warned_at: [WARNED_AT, null],
    });
    expect(seatsOnly?.action).toBe('update');
    expect(JSON.parse(seatsOnly!.changes_json)).toEqual({ member_limit: [50, 60] });
    expect(JSON.parse(quotaOnly!.changes_json)).toEqual({ attachment_quota_bytes: [100 * GIB, 200 * GIB] });
  });

  test('組織の変更の履歴（organization-history）に、運用者の操作として1件出る', async () => {
    const target = await createTarget();
    const read = async () =>
      (
        (await (await post(app, organizationHistory, { slug: target.slug, token: target.admin.token })).json()) as {
          entries: { actor: { kind: string }; event: { kind: string } }[];
        }
      ).entries;
    const before = await read();
    expect((await changeQuotaBy(await operatorToken(), target.slug, STANDARD)).status).toBe(200);
    const after = await read();
    expect(after).toHaveLength(before.length + 1);
    // 新しい順なので先頭。上限の変更は専用の種類を持たず、知らない組と同じ other で出す
    expect(after[0]).toMatchObject({ actor: { kind: 'operator' }, event: { kind: 'other' } });
  });

  test('履歴を書けなくても変更は成功し、ログに組織の ID、前後の値、日時、例外の名前だけを残す', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const organization = await createOrganization();
    const failing = envWithD1Hooks(testEnv, {
      beforeBatch: (sqls) => {
        if (sqls.some((sql) => sql.startsWith('insert into "change_logs"'))) throw new Error('secret SQL detail');
      },
    });
    const res = await changeQuotaBy(await operatorToken(), organization.slug, STANDARD, { env: failing });
    expect(res.status).toBe(200);
    expect(await organizationRow(organization.id)).toMatchObject(STANDARD);
    expect(await changeLogsOf(organization.id)).toEqual([]);

    const logged = errorLog.mock.calls.map((call) => String(call[0]));
    expect(logged).toHaveLength(1);
    const line = JSON.parse(logged[0]!) as Record<string, unknown>;
    expect(line).toMatchObject({
      operation: 'organization-quota-update',
      action: 'update',
      organizationId: organization.id,
      error: 'Error',
      changes: { member_limit: [15, 50], attachment_quota_bytes: [30 * GIB, 100 * GIB] },
    });
    expect(Number.isNaN(Date.parse(String(line.at)))).toBe(false);
    expect(logged[0]).not.toContain('secret SQL detail');
  });
});
