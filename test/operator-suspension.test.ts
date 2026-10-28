// 運用者の組織の停止と再開（organization-suspend、organization-resume）の結合テスト。
// 組織の分離と権限の一覧のテスト（test/operation-registry.test.ts）は、この2つの操作も回す。
// ここでは、停止と再開に固有の振る舞い（purge_on の値、競合の 409、消す予定日を過ぎた組織の 409 の purge_due、履歴の行、
// 履歴を書けなくても成功すること、停止中に入れる人と入れない人）を確かめる
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks, verifiedOrganizationForTest } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { setFixedNow } from '../src/shared/clock.ts';
import {
  listOrganizations,
  organizationResume,
  organizationSuspend,
  organizationSuspensionUpdate,
  purgeDateOf,
} from '../src/shared/operations/operator/index.ts';
import { myOrganizations, organizationInfo } from '../src/shared/operations/organization/index.ts';
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
  setFixedNow(undefined);
});

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

async function suspendBy(token: string, slug: string, kind: 'temporary' | 'cancellation', useEnv?: Env) {
  return post(app, organizationSuspend, { token, body: { slug, kind }, env: useEnv });
}

async function resumeBy(token: string, slug: string, useEnv?: Env) {
  return post(app, organizationResume, { token, body: { slug }, env: useEnv });
}

async function changeKindBy(token: string, slug: string, kind: 'temporary' | 'cancellation', useEnv?: Env) {
  return post(app, organizationSuspensionUpdate, { token, body: { slug, kind }, env: useEnv });
}

const SUSPENDED_AT = '2026-10-20T00:00:00.000Z';
// 消す予定日を過ぎていない解約の予定日。本物の時計で走るテストが、日が経っても予定日を過ぎないよう遠い先にする
const LATER_PURGE_ON = '2999-12-31';

// 開発用の時計（DEV_NOW）が使える、ループバックの公開 URL の環境。消す予定日の境目を、時計を止めて確かめる
function devEnv(devNow: string): Env {
  return Object.assign({}, testEnv, { PUBLIC_ORIGIN: 'http://localhost:8787', DEV_NOW: devNow });
}

describe('消す予定日', () => {
  test('停止した日時の UTC の日付の30日後。日本の日付と UTC の日付がずれる時刻でも UTC の日付で数える', () => {
    expect(purgeDateOf(new Date('2026-10-26T00:00:00.000Z'))).toBe('2026-11-25');
    // 日本時間では 10/27 の 08:30
    expect(purgeDateOf(new Date('2026-10-26T23:30:00.000Z'))).toBe('2026-11-25');
    expect(purgeDateOf(new Date('2026-01-31T12:00:00.000Z'))).toBe('2026-03-02');
  });
});

describe('組織の停止', () => {
  test('一時的な停止は、停止した日時を書き、消す予定日は空のまま', async () => {
    const organization = await createOrganization();
    const before = Date.now();
    const res = await suspendBy(await operatorToken(), organization.slug, 'temporary');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string; suspended_at: string; purge_on: string | null };
    expect(body.slug).toBe(organization.slug);
    expect(body.purge_on).toBeNull();
    expect(Date.parse(body.suspended_at)).toBeGreaterThanOrEqual(before);

    const row = await organizationRow(organization.id);
    expect(row).toMatchObject({ suspended_at: body.suspended_at, purge_on: null, updated_at: body.suspended_at });
  });

  test('解約は、停止した日時の UTC の日付の30日後を消す予定日にする。一覧にも出る', async () => {
    const organization = await createOrganization();
    const token = await operatorToken();
    const res = await suspendBy(token, organization.slug, 'cancellation');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { suspended_at: string; purge_on: string | null };
    expect(body.purge_on).toBe(purgeDateOf(new Date(body.suspended_at)));
    expect(await organizationRow(organization.id)).toMatchObject({ purge_on: body.purge_on });

    const listed = await post(app, listOrganizations, { token });
    const item = (
      (await listed.json()) as { organizations: { slug: string; purge_on: string | null }[] }
    ).organizations.find((entry) => entry.slug === organization.slug);
    expect(item?.purge_on).toBe(body.purge_on);
  });

  test('既に停止している組織は 409 の conflict で、書き換えない', async () => {
    const organization = await createOrganization({
      suspended_at: '2026-10-20T00:00:00.000Z',
      purge_on: LATER_PURGE_ON,
    });
    const res = await suspendBy(await operatorToken(), organization.slug, 'temporary');
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('conflict');
    expect(await organizationRow(organization.id)).toMatchObject({
      suspended_at: '2026-10-20T00:00:00.000Z',
      purge_on: LATER_PURGE_ON,
    });
    expect(await changeLogsOf(organization.id)).toEqual([]);
  });

  test('無い slug は 404 の not_found', async () => {
    const res = await suspendBy(await operatorToken(), 'no-such-organization', 'temporary');
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe('not_found');
  });

  test('停止の種類が temporary と cancellation でなければ 400 の invalid_input', async () => {
    const organization = await createOrganization();
    const res = await post(app, organizationSuspend, {
      token: await operatorToken(),
      body: { slug: organization.slug, kind: 'forever' },
    });
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe('invalid_input');
    expect((await organizationRow(organization.id))?.suspended_at).toBeNull();
  });

  test('運用者でない人は 403 で、停止しない', async () => {
    const target = await createTarget();
    const res = await suspendBy(target.admin.token, target.slug, 'temporary');
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('forbidden');
    expect((await organizationRow(target.organization.id))?.suspended_at).toBeNull();
  });

  test('読んだ後に別の運用者が先に停止していれば 409 で、先の停止を書き換えない', async () => {
    const organization = await createOrganization();
    let armed = true;
    const racing = envWithD1Hooks(testEnv, {
      // 停止の状態を読んだ直後に、別の運用者が停止する
      afterQuery: async (sql) => {
        if (!armed || !sql.includes('from "organizations"') || !sql.includes('"purge_on"')) return;
        armed = false;
        const db = commonDb(env);
        await db.batch([
          db.statement((q) =>
            q
              .updateTable('organizations')
              .set({ suspended_at: '2026-10-25T00:00:00.000Z', purge_on: null })
              .where('id', '=', organization.id),
          ),
        ]);
      },
    });
    const res = await suspendBy(await operatorToken(), organization.slug, 'cancellation', racing);
    expect(armed).toBe(false);
    expect(res.status).toBe(409);
    expect(await organizationRow(organization.id)).toMatchObject({
      suspended_at: '2026-10-25T00:00:00.000Z',
      purge_on: null,
    });
    expect(await changeLogsOf(organization.id)).toEqual([]);
  });
});

describe('組織の再開', () => {
  test('停止した日時と消す予定日を空に戻す', async () => {
    const organization = await createOrganization({
      suspended_at: '2026-01-01T00:00:00.000Z',
      purge_on: LATER_PURGE_ON,
    });
    const res = await resumeBy(await operatorToken(), organization.slug);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: organization.slug });
    const row = await organizationRow(organization.id);
    expect(row).toMatchObject({ suspended_at: null, purge_on: null });
    expect(row?.updated_at).not.toBe(organization.updated_at);
  });

  test('停止していない組織は 409 の conflict', async () => {
    const organization = await createOrganization();
    const res = await resumeBy(await operatorToken(), organization.slug);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('conflict');
    expect(await changeLogsOf(organization.id)).toEqual([]);
  });

  test('無い slug は 404 の not_found', async () => {
    const res = await resumeBy(await operatorToken(), 'no-such-organization');
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe('not_found');
  });

  test('運用者でない人は 403 で、再開しない', async () => {
    const stayer = await admitElsewhere(await createPerson());
    const suspended = await createOrganization({ suspended_at: '2026-10-20T00:00:00.000Z' });
    const res = await resumeBy(stayer.token, suspended.slug);
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe('forbidden');
    expect((await organizationRow(suspended.id))?.suspended_at).toBe('2026-10-20T00:00:00.000Z');
  });

  test('読んだ後に別の運用者が先に再開していれば 409', async () => {
    const organization = await createOrganization({ suspended_at: '2026-10-20T00:00:00.000Z' });
    let armed = true;
    const racing = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (!armed || !sql.includes('from "organizations"') || !sql.includes('"purge_on"')) return;
        armed = false;
        const db = commonDb(env);
        await db.batch([
          db.statement((q) =>
            q.updateTable('organizations').set({ suspended_at: null }).where('id', '=', organization.id),
          ),
        ]);
      },
    });
    const res = await resumeBy(await operatorToken(), organization.slug, racing);
    expect(armed).toBe(false);
    expect(res.status).toBe(409);
    expect(await changeLogsOf(organization.id)).toEqual([]);
  });
});

describe('停止の理由の切り替え', () => {
  test('一時的な停止から解約へ。停止した日時は変えず、消す予定日を切り替えた日の UTC の日付の30日後にする', async () => {
    const organization = await createOrganization({ suspended_at: SUSPENDED_AT });
    const before = Date.now();
    const res = await changeKindBy(await operatorToken(), organization.slug, 'cancellation');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string; purge_on: string };
    expect(body.slug).toBe(organization.slug);
    // 停止した日ではなく、切り替えた日から数える
    expect(body.purge_on).toBe(purgeDateOf(new Date(before)));
    const row = await organizationRow(organization.id);
    expect(row).toMatchObject({ suspended_at: SUSPENDED_AT, purge_on: body.purge_on });
    expect(row?.updated_at).not.toBe(organization.updated_at);
  });

  test('解約から一時的な停止へ。消す予定日を空にし、停止した日時は変えない', async () => {
    const organization = await createOrganization({ suspended_at: SUSPENDED_AT, purge_on: LATER_PURGE_ON });
    const res = await changeKindBy(await operatorToken(), organization.slug, 'temporary');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: organization.slug, purge_on: null });
    expect(await organizationRow(organization.id)).toMatchObject({ suspended_at: SUSPENDED_AT, purge_on: null });
  });

  test('一覧に切り替えた後の消す予定日が出る', async () => {
    const organization = await createOrganization({ suspended_at: SUSPENDED_AT });
    const token = await operatorToken();
    const { purge_on } = (await (await changeKindBy(token, organization.slug, 'cancellation')).json()) as {
      purge_on: string;
    };
    const listed = (await (await post(app, listOrganizations, { token })).json()) as {
      organizations: { slug: string; purge_on: string | null }[];
    };
    expect(listed.organizations.find((entry) => entry.slug === organization.slug)?.purge_on).toBe(purge_on);
  });

  test('今と同じ理由への切り替えは 409 の conflict で、書き換えない', async () => {
    const token = await operatorToken();
    const temporary = await createOrganization({ suspended_at: SUSPENDED_AT });
    const cancellation = await createOrganization({ suspended_at: SUSPENDED_AT, purge_on: LATER_PURGE_ON });
    for (const [organization, kind] of [
      [temporary, 'temporary'],
      [cancellation, 'cancellation'],
    ] as const) {
      const res = await changeKindBy(token, organization.slug, kind);
      expect(res.status, kind).toBe(409);
      expect(await errorCodeOf(res)).toBe('conflict');
      expect(await changeLogsOf(organization.id)).toEqual([]);
    }
    expect((await organizationRow(cancellation.id))?.purge_on).toBe(LATER_PURGE_ON);
    expect((await organizationRow(temporary.id))?.purge_on).toBeNull();
  });

  test('停止していない組織は 409 の conflict、無い slug は 404、種類が違えば 400、運用者でない人は 403', async () => {
    const token = await operatorToken();
    const running = await createOrganization();
    const notSuspended = await changeKindBy(token, running.slug, 'cancellation');
    expect(notSuspended.status).toBe(409);
    expect(await errorCodeOf(notSuspended)).toBe('conflict');
    expect((await organizationRow(running.id))?.purge_on).toBeNull();

    const missing = await changeKindBy(token, 'no-such-organization', 'cancellation');
    expect(missing.status).toBe(404);
    expect(await errorCodeOf(missing)).toBe('not_found');

    const suspended = await createOrganization({ suspended_at: SUSPENDED_AT });
    const invalid = await post(app, organizationSuspensionUpdate, {
      token,
      body: { slug: suspended.slug, kind: 'forever' },
    });
    expect(invalid.status).toBe(400);
    expect(await errorCodeOf(invalid)).toBe('invalid_input');

    const stayer = await admitElsewhere(await createPerson());
    const forbidden = await changeKindBy(stayer.token, suspended.slug, 'cancellation');
    expect(forbidden.status).toBe(403);
    expect(await errorCodeOf(forbidden)).toBe('forbidden');
    expect((await organizationRow(suspended.id))?.purge_on).toBeNull();
  });

  test('読んだ後に別の運用者が先に切り替えていれば 409 で、先の切り替えを書き換えない', async () => {
    const organization = await createOrganization({ suspended_at: SUSPENDED_AT });
    let armed = true;
    const racing = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (!armed || !sql.includes('from "organizations"') || !sql.includes('"purge_on"')) return;
        armed = false;
        const db = commonDb(env);
        await db.batch([
          db.statement((q) =>
            q.updateTable('organizations').set({ purge_on: LATER_PURGE_ON }).where('id', '=', organization.id),
          ),
        ]);
      },
    });
    const res = await changeKindBy(await operatorToken(), organization.slug, 'cancellation', racing);
    expect(armed).toBe(false);
    expect(res.status).toBe(409);
    expect((await organizationRow(organization.id))?.purge_on).toBe(LATER_PURGE_ON);
    expect(await changeLogsOf(organization.id)).toEqual([]);
  });

  test('履歴は action が update で、changes_json は purge_on の1行。書けなくても切り替えは成功する', async () => {
    const organization = await createOrganization({ suspended_at: SUSPENDED_AT });
    const token = await operatorToken();
    const { purge_on } = (await (await changeKindBy(token, organization.slug, 'cancellation')).json()) as {
      purge_on: string;
    };
    await changeKindBy(token, organization.slug, 'temporary');

    const [toCancellation, toTemporary] = await changeLogsOf(organization.id);
    expect(toCancellation).toMatchObject({
      workspace_id: null,
      actor_user_id: null,
      operator: OPERATOR_LOGIN_ID,
      entity_type: 'organization',
      entity_id: organization.id,
      action: 'update',
    });
    expect(JSON.parse(toCancellation!.changes_json)).toEqual({ purge_on: [null, purge_on] });
    expect(toTemporary?.action).toBe('update');
    expect(JSON.parse(toTemporary!.changes_json)).toEqual({ purge_on: [purge_on, null] });

    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = envWithD1Hooks(testEnv, {
      beforeBatch: (sqls) => {
        if (sqls.some((sql) => sql.startsWith('insert into "change_logs"'))) throw new Error('secret SQL detail');
      },
    });
    expect((await changeKindBy(token, organization.slug, 'cancellation', failing)).status).toBe(200);
    expect((await organizationRow(organization.id))?.purge_on).not.toBeNull();
    expect(await changeLogsOf(organization.id)).toHaveLength(2);
    const logged = errorLog.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain(organization.id);
    expect(logged).toContain('"action":"update"');
    expect(logged).not.toContain('secret SQL detail');
  });
});

describe('消す予定日を過ぎた解約の組織', () => {
  // 日本時間では 11/20 の 08:00 で、UTC の日付は 11/19。境目は UTC の日付で数える（消す SQL のガード purge_on < date('now') と同じ）。
  // UPDATE は D1 の date('now')（実際の時計）とも比べるので、どの日付も実際の今日より十分先に置く
  const NOW = '2999-11-20T08:00:00+09:00';
  const TODAY = '2999-11-19';
  const YESTERDAY = '2999-11-18';
  const TOMORROW = '2999-11-20';

  test('予定日が今日の UTC の日付より前なら、再開は 409 の purge_due で、書き換えず履歴も残さない', async () => {
    const organization = await createOrganization({ suspended_at: SUSPENDED_AT, purge_on: YESTERDAY });
    const res = await resumeBy(await operatorToken(), organization.slug, devEnv(NOW));
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('purge_due');
    expect(await organizationRow(organization.id)).toMatchObject({ suspended_at: SUSPENDED_AT, purge_on: YESTERDAY });
    expect(await changeLogsOf(organization.id)).toEqual([]);
  });

  test('予定日を過ぎたら、一時的な停止へ切り替えられない（purge_due）。解約から解約へは今どおり conflict', async () => {
    const organization = await createOrganization({ suspended_at: SUSPENDED_AT, purge_on: YESTERDAY });
    const token = await operatorToken();
    const toTemporary = await changeKindBy(token, organization.slug, 'temporary', devEnv(NOW));
    expect(toTemporary.status).toBe(409);
    expect(await errorCodeOf(toTemporary)).toBe('purge_due');
    const toCancellation = await changeKindBy(token, organization.slug, 'cancellation', devEnv(NOW));
    expect(toCancellation.status).toBe(409);
    expect(await errorCodeOf(toCancellation)).toBe('conflict');
    expect(await organizationRow(organization.id)).toMatchObject({ suspended_at: SUSPENDED_AT, purge_on: YESTERDAY });
    expect(await changeLogsOf(organization.id)).toEqual([]);
  });

  test('予定日の当日（日本の日付では翌日でも）と、未来の予定日は、再開も一時的な停止への切り替えもできる', async () => {
    const token = await operatorToken();
    for (const purgeOn of [TODAY, TOMORROW]) {
      const resumed = await createOrganization({ suspended_at: SUSPENDED_AT, purge_on: purgeOn });
      const resume = await resumeBy(token, resumed.slug, devEnv(NOW));
      expect(resume.status, purgeOn).toBe(200);
      expect(await organizationRow(resumed.id)).toMatchObject({ suspended_at: null, purge_on: null });

      const changed = await createOrganization({ suspended_at: SUSPENDED_AT, purge_on: purgeOn });
      const change = await changeKindBy(token, changed.slug, 'temporary', devEnv(NOW));
      expect(change.status, purgeOn).toBe(200);
      expect(await organizationRow(changed.id)).toMatchObject({ suspended_at: SUSPENDED_AT, purge_on: null });
    }
  });

  test('一時的な停止は、今どおり再開でき、解約へ切り替えられる', async () => {
    const token = await operatorToken();
    const resumed = await createOrganization({ suspended_at: SUSPENDED_AT });
    expect((await resumeBy(token, resumed.slug, devEnv(NOW))).status).toBe(200);
    const changed = await createOrganization({ suspended_at: SUSPENDED_AT });
    const change = await changeKindBy(token, changed.slug, 'cancellation', devEnv(NOW));
    expect(change.status).toBe(200);
    expect(await change.json()).toEqual({ slug: changed.slug, purge_on: '2999-12-19' });
  });

  test('読んだ後に予定日を過ぎても、UPDATE の条件で外れて 409 の purge_due', async () => {
    const organization = await createOrganization({ suspended_at: SUSPENDED_AT, purge_on: TODAY });
    let armed = true;
    const racing = envWithD1Hooks(devEnv(NOW), {
      // 停止の状態を読んだ直後に、予定日を前の日にずらす（読んだ後に日付が変わったのと同じく、予定日が今日より前になる）。
      // 停止した日時は変えないので、再開の UPDATE を外すのは予定日の条件だけ
      afterQuery: async (sql) => {
        if (!armed || !sql.includes('from "organizations"') || !sql.includes('"purge_on"')) return;
        armed = false;
        const db = commonDb(env);
        await db.batch([
          db.statement((q) =>
            q.updateTable('organizations').set({ purge_on: YESTERDAY }).where('id', '=', organization.id),
          ),
        ]);
      },
    });
    const res = await resumeBy(await operatorToken(), organization.slug, racing);
    expect(armed).toBe(false);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('purge_due');
    expect(await organizationRow(organization.id)).toMatchObject({ suspended_at: SUSPENDED_AT, purge_on: YESTERDAY });
    expect(await changeLogsOf(organization.id)).toEqual([]);
  });

  test("Worker の時計では過ぎていなくても、D1 の date('now') で過ぎていれば、UPDATE の条件で外れて 409 の purge_due", async () => {
    // Worker の時計（DEV_NOW）を実際の今日より前に止め、予定日をその日より後で実際の今日より前にする。
    // 事前の判定（Worker の日付）は通るが、消す SQL のガード（D1 の date('now')）では過ぎている。UTC の 0 時をまたいだときの隙間と同じ形
    const pastNow = '2020-01-01T00:00:00Z';
    const purgeOn = '2020-06-01';
    const token = await operatorToken();
    const resumed = await createOrganization({ suspended_at: SUSPENDED_AT, purge_on: purgeOn });
    const resume = await resumeBy(token, resumed.slug, devEnv(pastNow));
    expect(resume.status).toBe(409);
    expect(await errorCodeOf(resume)).toBe('purge_due');
    expect(await organizationRow(resumed.id)).toMatchObject({ suspended_at: SUSPENDED_AT, purge_on: purgeOn });
    expect(await changeLogsOf(resumed.id)).toEqual([]);

    const changed = await createOrganization({ suspended_at: SUSPENDED_AT, purge_on: purgeOn });
    const change = await changeKindBy(token, changed.slug, 'temporary', devEnv(pastNow));
    expect(change.status).toBe(409);
    expect(await errorCodeOf(change)).toBe('purge_due');
    expect(await organizationRow(changed.id)).toMatchObject({ suspended_at: SUSPENDED_AT, purge_on: purgeOn });
    expect(await changeLogsOf(changed.id)).toEqual([]);
  });

  test('一覧の purge_due は、予定日を過ぎた解約の組織だけが真', async () => {
    const token = await operatorToken();
    const due = await createOrganization({ suspended_at: SUSPENDED_AT, purge_on: YESTERDAY });
    const today = await createOrganization({ suspended_at: SUSPENDED_AT, purge_on: TODAY });
    const temporary = await createOrganization({ suspended_at: SUSPENDED_AT });
    const running = await createOrganization();
    const listed = (await (await post(app, listOrganizations, { token, env: devEnv(NOW) })).json()) as {
      organizations: { slug: string; purge_due: boolean }[];
    };
    const dueOf = (slug: string) => listed.organizations.find((entry) => entry.slug === slug)?.purge_due;
    expect(dueOf(due.slug)).toBe(true);
    expect(dueOf(today.slug)).toBe(false);
    expect(dueOf(temporary.slug)).toBe(false);
    expect(dueOf(running.slug)).toBe(false);
  });
});

describe('変更の履歴', () => {
  test('停止と再開が、運用者の操作として organization の履歴に残る', async () => {
    const organization = await createOrganization();
    const token = await operatorToken();
    const suspended = (await (await suspendBy(token, organization.slug, 'cancellation')).json()) as {
      suspended_at: string;
      purge_on: string;
    };
    expect(await resumeBy(token, organization.slug).then((res) => res.status)).toBe(200);

    const [suspend, resume] = await changeLogsOf(organization.id);
    expect(suspend).toMatchObject({
      organization_id: organization.id,
      workspace_id: null,
      actor_user_id: null,
      operator: OPERATOR_LOGIN_ID,
      entity_type: 'organization',
      entity_id: organization.id,
      action: 'suspend',
      created_at: suspended.suspended_at,
    });
    expect(JSON.parse(suspend!.changes_json)).toEqual({
      suspended_at: [null, suspended.suspended_at],
      purge_on: [null, suspended.purge_on],
    });
    expect(resume).toMatchObject({
      workspace_id: null,
      actor_user_id: null,
      operator: OPERATOR_LOGIN_ID,
      entity_type: 'organization',
      entity_id: organization.id,
      action: 'resume',
    });
    expect(JSON.parse(resume!.changes_json)).toEqual({
      suspended_at: [suspended.suspended_at, null],
      purge_on: [suspended.purge_on, null],
    });
  });

  test('履歴を書けなくても停止と再開は成功し、ログに組織の ID、前後の値、日時、例外の名前だけを残す', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const organization = await createOrganization();
    const failing = envWithD1Hooks(testEnv, {
      beforeBatch: (sqls) => {
        if (sqls.some((sql) => sql.startsWith('insert into "change_logs"'))) throw new Error('secret SQL detail');
      },
    });
    const token = await operatorToken();

    expect((await suspendBy(token, organization.slug, 'temporary', failing)).status).toBe(200);
    expect((await organizationRow(organization.id))?.suspended_at).not.toBeNull();
    expect(await changeLogsOf(organization.id)).toEqual([]);
    const suspendedAt = (await organizationRow(organization.id))?.suspended_at;

    expect((await resumeBy(token, organization.slug, failing)).status).toBe(200);
    expect((await organizationRow(organization.id))?.suspended_at).toBeNull();
    expect(await changeLogsOf(organization.id)).toEqual([]);

    const logged = errorLog.mock.calls.map((call) => String(call[0]));
    expect(logged).toHaveLength(2);
    for (const line of logged) {
      expect(line).toContain(organization.id);
      expect(line).toContain('"error":"Error"');
      expect(line).not.toContain('secret SQL detail');
    }
    // 再開で organizations から消えた停止の日時を、ログから補える
    const resumed = JSON.parse(logged[1]!) as { action: string; changes: unknown; at: string };
    expect(resumed.action).toBe('resume');
    expect(resumed.changes).toEqual({ suspended_at: [suspendedAt, null], purge_on: [null, null] });
    expect(Number.isNaN(Date.parse(resumed.at))).toBe(false);
  });
});

describe('停止中の組織に入る人', () => {
  test('入れたはずの人は 403 の organization_suspended、入れない人は 404。再開すれば入れる', async () => {
    const target = await createTarget();
    // 停止した組織にしか入れない人は、403 の前にセッションを消されて 401 になるので、ほかの組織にも入れる人にする
    const stayer = await admitElsewhere(target.admin);
    await admitElsewhere(target.member);
    await admitElsewhere(target.invitee);
    const outsider = await admitElsewhere(await createPerson());
    const token = await operatorToken();
    const enter = (person: { token: string }) =>
      post(app, organizationInfo, { slug: target.slug, token: person.token });

    expect((await enter(stayer)).status).toBe(200);
    expect((await suspendBy(token, target.slug, 'temporary')).status).toBe(200);

    for (const person of [stayer, target.member, target.invitee]) {
      const res = await enter(person);
      expect(res.status).toBe(403);
      expect(await errorCodeOf(res)).toBe('organization_suspended');
    }
    const hidden = await enter(outsider);
    expect(hidden.status).toBe(404);
    expect(await errorCodeOf(hidden)).toBe('not_found');

    expect((await resumeBy(token, target.slug)).status).toBe(200);
    expect((await enter(stayer)).status).toBe(200);
  });

  test('組織の選択には停止した組織を出さず、再開すれば出る', async () => {
    const target = await createTarget();
    const stayer = await admitElsewhere(target.admin);
    const token = await operatorToken();
    const slugsOf = async () =>
      (
        (await (await post(app, myOrganizations, { token: stayer.token })).json()) as {
          organizations: { slug: string }[];
        }
      ).organizations.map((organization) => organization.slug);

    expect(await slugsOf()).toContain(target.slug);
    await suspendBy(token, target.slug, 'temporary');
    expect(await slugsOf()).not.toContain(target.slug);
    await resumeBy(token, target.slug);
    expect(await slugsOf()).toContain(target.slug);
  });

  test('停止した組織にしか入れない人は、次の組織の外の操作で 401 になり、理由は suspended', async () => {
    const target = await createTarget();
    await suspendBy(await operatorToken(), target.slug, 'temporary');

    const res = await post(app, myOrganizations, { token: target.admin.token });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'unauthenticated', details: { reason: 'suspended' } } });
  });
});
