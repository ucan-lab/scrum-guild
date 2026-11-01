// お試しの期限切れの組織を一時停止にする定期処理（Issue #642）。cron の式 `0 * * * *` で起き、基準日時（scheduledTime）の UTC の日付で数える。
// 期限（organizations.trial_ends_on）の当日までは止まらず、翌日（UTC の 0 時）から止まる。止めた組織の change_logs に定期処理の操作として1行残す
import { createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { commonDb, orgDb, suspendExpiredTrials } from '../src/server/db/index.ts';
import { envWithD1Hooks, verifiedOrganizationForTest } from '../src/server/db/testing.ts';
import worker from '../src/server/index.ts';
import { suspendExpiredTrialsJob } from '../src/server/scheduled/suspend-expired-trials.ts';
import { createChangeLog, createOrganization } from './factories.ts';

const EVERY_HOUR = '0 * * * *';
const EVERY_MINUTE = '* * * * *';

afterEach(() => {
  vi.restoreAllMocks();
});

async function runScheduled(scheduledTime: string, cron = EVERY_HOUR, target: Env = env) {
  await worker.scheduled(createScheduledController({ scheduledTime: Date.parse(scheduledTime), cron }), target);
}

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
        .orderBy('created_at')
        .orderBy('id'),
    ),
  );
}

const suspendedAtOf = async (id: string) => (await organizationRow(id))?.suspended_at ?? null;

const SUSPEND_CHANGES = (at: string) => JSON.stringify({ suspended_at: [null, at], purge_on: [null, null] });

describe('境目（期限の当日と翌日、UTC の 0 時の前後）', () => {
  // [期限, 起きた時刻, 止まるか, 説明]
  const cases: [string, string, boolean, string][] = [
    ['2026-10-31', '2026-10-31T00:00:00.000Z', false, '期限の当日の 0 時'],
    ['2026-10-31', '2026-10-31T12:00:00.000Z', false, '期限の当日の昼'],
    ['2026-10-31', '2026-10-31T23:59:59.999Z', false, '期限の当日の最後の 1 ミリ秒（UTC の 0 時の直前）'],
    ['2026-10-31', '2026-11-01T00:00:00.000Z', true, '期限の翌日の 0 時ちょうど（UTC の 0 時の直後）'],
    ['2026-10-31', '2026-11-01T01:00:00.000Z', true, '期限の翌日の 1 時'],
    ['2026-10-31', '2026-11-05T00:00:00.000Z', true, '期限から何日も後'],
    ['2026-02-28', '2026-02-28T23:59:59.999Z', false, '月末（平年の 2 月）の当日の終わり'],
    ['2026-02-28', '2026-03-01T00:00:00.000Z', true, '月末（平年の 2 月）をまたいだ翌日'],
    ['2028-02-28', '2028-02-29T00:00:00.000Z', true, 'うるう年の 2/28 の翌日は 2/29'],
    ['2028-02-29', '2028-02-29T23:59:59.999Z', false, 'うるう日の当日の終わり'],
    ['2028-02-29', '2028-03-01T00:00:00.000Z', true, 'うるう日をまたいだ翌日'],
    ['2026-12-31', '2026-12-31T23:59:59.999Z', false, '年末の当日の終わり'],
    ['2026-12-31', '2027-01-01T00:00:00.000Z', true, '年末をまたいだ元日の 0 時'],
    ['2026-04-30', '2026-05-01T00:00:00.000Z', true, '30 日の月の末をまたぐ'],
  ];

  for (const [trialEndsOn, at, stops, name] of cases) {
    test(`${name}: 期限 ${trialEndsOn}、基準 ${at} で${stops ? '止まる' : '止まらない'}`, async () => {
      const organization = await createOrganization({ trial_ends_on: trialEndsOn });
      await runScheduled(at);
      const row = await organizationRow(organization.id);
      if (stops) {
        expect(row).toMatchObject({ suspended_at: at, purge_on: null, updated_at: at });
        expect(await changeLogsOf(organization.id)).toHaveLength(1);
      } else {
        expect(row).toMatchObject({
          suspended_at: null,
          purge_on: null,
          updated_at: organization.updated_at,
          trial_ends_on: trialEndsOn,
        });
        expect(await changeLogsOf(organization.id)).toEqual([]);
      }
    });
  }

  test('日本の日付と UTC の日付がずれる時刻でも UTC の日付で数える（日本時間では翌日の朝でも、UTC では期限の当日）', async () => {
    const organization = await createOrganization({ trial_ends_on: '2026-10-31' });
    // 日本時間では 2026-11-01 08:30
    await runScheduled('2026-10-31T23:30:00.000Z');
    expect(await suspendedAtOf(organization.id)).toBeNull();
  });
});

describe('期限切れの停止', () => {
  test('停止していない期限切れの組織が、基準日時で一時的な停止になる（suspended_at と updated_at が基準日時、purge_on は空）', async () => {
    const organization = await createOrganization({ trial_ends_on: '2026-10-31' });
    const at = '2026-11-01T00:00:00.000Z';
    await runScheduled(at);
    expect(await organizationRow(organization.id)).toMatchObject({
      suspended_at: at,
      purge_on: null,
      updated_at: at,
      // 期限の列はそのまま（再開で空になる）
      trial_ends_on: '2026-10-31',
    });
  });

  test('組織の change_logs に、定期処理の操作として停止の履歴が1行残る', async () => {
    const organization = await createOrganization({ trial_ends_on: '2026-10-31' });
    const at = '2026-11-01T03:00:00.000Z';
    await runScheduled(at);
    const logs = await changeLogsOf(organization.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      organization_id: organization.id,
      workspace_id: null,
      actor_user_id: null,
      operator: null,
      entity_type: 'organization',
      entity_id: organization.id,
      action: 'suspend',
      changes_json: SUSPEND_CHANGES(at),
      created_at: at,
    });
  });

  test('suspendExpiredTrialsJob を直に呼んでも同じ（基準日時を引数で渡す）', async () => {
    const organization = await createOrganization({ trial_ends_on: '2026-12-31' });
    const at = '2027-01-01T00:00:00.000Z';
    await suspendExpiredTrialsJob(env, new Date(at));
    expect(await organizationRow(organization.id)).toMatchObject({ suspended_at: at, purge_on: null, updated_at: at });
    expect((await changeLogsOf(organization.id))[0]).toMatchObject({ action: 'suspend', created_at: at });
  });

  test('suspendExpiredTrials は止めた組織の id と止める前の trial_ends_on を返し、止めなかった組織は返さない', async () => {
    const expired = await createOrganization({ trial_ends_on: '2026-10-30' });
    const dueToday = await createOrganization({ trial_ends_on: '2026-10-31' });
    const never = await createOrganization();
    const alreadySuspended = await createOrganization({
      trial_ends_on: '2026-10-01',
      suspended_at: '2026-10-10T00:00:00.000Z',
    });
    const at = new Date('2026-10-31T00:00:00.000Z');
    const stopped = await suspendExpiredTrials(env, '2026-10-31', at);
    const mine = [expired, dueToday, never, alreadySuspended].map((organization) => organization.id);
    expect(stopped.filter((row) => mine.includes(row.id))).toEqual([{ id: expired.id, trial_ends_on: '2026-10-30' }]);
    expect(await suspendedAtOf(expired.id)).toBe(at.toISOString());
    expect(await suspendedAtOf(dueToday.id)).toBeNull();
  });

  test('suspendExpiredTrials は期限の無い組織だけで空を返す', async () => {
    const never = await createOrganization();
    const stopped = await suspendExpiredTrials(env, '2999-01-01', new Date('2999-01-01T00:00:00.000Z'));
    expect(stopped.map((row) => row.id)).not.toContain(never.id);
  });
});

describe('触らない組織', () => {
  test('既に停止中の組織（運用者が先に止めた一時的な停止）は、状態も updated_at も change_logs も変わらない', async () => {
    const operatorSuspendedAt = '2026-10-20T00:00:00.000Z';
    const organization = await createOrganization({
      trial_ends_on: '2026-10-01',
      suspended_at: operatorSuspendedAt,
      updated_at: operatorSuspendedAt,
    });
    await runScheduled('2026-11-01T00:00:00.000Z');
    expect(await organizationRow(organization.id)).toMatchObject({
      suspended_at: operatorSuspendedAt,
      purge_on: null,
      updated_at: operatorSuspendedAt,
      trial_ends_on: '2026-10-01',
    });
    expect(await changeLogsOf(organization.id)).toEqual([]);
  });

  test('解約で停止中の組織（消す予定日あり）は、一時的な停止に書き換えず、履歴も足さない', async () => {
    const cancelledAt = '2026-10-20T00:00:00.000Z';
    const organization = await createOrganization({
      trial_ends_on: '2026-10-01',
      suspended_at: cancelledAt,
      purge_on: '2999-12-31',
      updated_at: cancelledAt,
    });
    const before = await createChangeLog(organization, { action: 'suspend', created_at: cancelledAt });
    await runScheduled('2026-11-01T00:00:00.000Z');
    expect(await organizationRow(organization.id)).toMatchObject({
      suspended_at: cancelledAt,
      purge_on: '2999-12-31',
      updated_at: cancelledAt,
    });
    expect((await changeLogsOf(organization.id)).map((log) => log.id)).toEqual([before.id]);
  });

  test('trial_ends_on が NULL の組織（運用者が作った）は、何年経っても止まらない', async () => {
    const organization = await createOrganization();
    expect(organization.trial_ends_on).toBeNull();
    await runScheduled('2099-01-01T00:00:00.000Z');
    expect(await organizationRow(organization.id)).toMatchObject({
      suspended_at: null,
      purge_on: null,
      updated_at: organization.updated_at,
      trial_ends_on: null,
    });
    expect(await changeLogsOf(organization.id)).toEqual([]);
  });

  test('止めた組織の既存の履歴は残り、新しい行は足されるだけ', async () => {
    const organization = await createOrganization({ trial_ends_on: '2026-10-31' });
    const older = await createChangeLog(organization, { created_at: '2026-10-25T00:00:00.000Z' });
    await runScheduled('2026-11-01T00:00:00.000Z');
    const logs = await changeLogsOf(organization.id);
    expect(logs.map((log) => log.id)).toContain(older.id);
    expect(logs).toHaveLength(2);
  });
});

describe('くり返しと複数の組織', () => {
  test('2回続けて起こしても二重に止めず、履歴を二重に書かず、updated_at も動かさない', async () => {
    const organization = await createOrganization({ trial_ends_on: '2026-10-31' });
    const first = '2026-11-01T00:00:00.000Z';
    await runScheduled(first);
    await runScheduled('2026-11-01T01:00:00.000Z');
    await runScheduled('2026-11-02T00:00:00.000Z');
    expect(await organizationRow(organization.id)).toMatchObject({ suspended_at: first, updated_at: first });
    const logs = await changeLogsOf(organization.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ created_at: first, changes_json: SUSPEND_CHANGES(first) });
  });

  test('同じ基準日時で続けて起こしても、2回目は何も返さず何も書かない', async () => {
    const organization = await createOrganization({ trial_ends_on: '2026-10-31' });
    const at = new Date('2026-11-01T00:00:00.000Z');
    const first = await suspendExpiredTrials(env, '2026-11-01', at);
    const second = await suspendExpiredTrials(env, '2026-11-01', at);
    expect(first.map((row) => row.id)).toContain(organization.id);
    expect(second.map((row) => row.id)).not.toContain(organization.id);
  });

  test('期限切れが複数の組織にあれば全部止まり、履歴はそれぞれの組織にだけ残る', async () => {
    const first = await createOrganization({ trial_ends_on: '2026-10-29' });
    const second = await createOrganization({ trial_ends_on: '2026-10-31' });
    const third = await createOrganization({ trial_ends_on: '2026-11-01' });
    const never = await createOrganization();
    const at = '2026-11-01T00:00:00.000Z';
    await runScheduled(at);

    expect(await suspendedAtOf(first.id)).toBe(at);
    expect(await suspendedAtOf(second.id)).toBe(at);
    expect(await suspendedAtOf(third.id)).toBeNull();
    expect(await suspendedAtOf(never.id)).toBeNull();

    for (const organization of [first, second]) {
      const logs = await changeLogsOf(organization.id);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ organization_id: organization.id, entity_id: organization.id });
    }
    expect(await changeLogsOf(third.id)).toEqual([]);
    expect(await changeLogsOf(never.id)).toEqual([]);
  });

  test('別の組織の change_logs に、止めた組織の履歴を書かない', async () => {
    const stopped = await createOrganization({ trial_ends_on: '2026-10-31' });
    const other = await createOrganization({ trial_ends_on: '2026-11-30' });
    await runScheduled('2026-11-01T00:00:00.000Z');
    const otherDb = orgDb(env, verifiedOrganizationForTest(other.id));
    const leaked = await otherDb.rows(
      otherDb.statement((q) => q.selectFrom('change_logs').selectAll().where('entity_id', '=', stopped.id)),
    );
    expect(leaked.filter((log) => log.organization_id !== stopped.id)).toEqual([]);
    expect(await changeLogsOf(other.id)).toEqual([]);
  });
});

describe('履歴の書き込みの失敗', () => {
  test('change_logs を書けなくても organizations の停止は残り、他の組織の処理を続け、ログは組織の ID と changes と時刻と例外の名前だけ', async () => {
    const first = await createOrganization({ trial_ends_on: '2026-10-30' });
    const second = await createOrganization({ trial_ends_on: '2026-10-31' });
    const at = '2026-11-01T00:00:00.000Z';
    const secret = '秘密の本文-まるごと出さない';
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let failed = false;
    const failing = envWithD1Hooks(env, {
      // 最初の履歴の書き込みだけを失敗させる
      beforeBatch: (sqls) => {
        if (failed || !sqls.some((sql) => sql.includes('change_logs'))) return;
        failed = true;
        throw new Error(secret);
      },
    });

    await expect(suspendExpiredTrialsJob(failing, new Date(at))).resolves.toBeUndefined();
    expect(failed).toBe(true);

    // 停止は残る
    expect(await suspendedAtOf(first.id)).toBe(at);
    expect(await suspendedAtOf(second.id)).toBe(at);
    // 失敗した1つだけ履歴が無く、もう1つには残る（他の組織の処理は続く）
    const counts = [(await changeLogsOf(first.id)).length, (await changeLogsOf(second.id)).length].sort();
    expect(counts).toEqual([0, 1]);
    const failedOrganization = (await changeLogsOf(first.id)).length === 0 ? first : second;

    const printed = errors.mock.calls.map((call) =>
      call.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '),
    );
    const mine = printed.filter((line) => line.includes(failedOrganization.id));
    expect(mine).toHaveLength(1);
    const line = mine[0] as string;
    expect(line).toContain('suspended_at');
    expect(line).toContain(at);
    expect(line).toContain('Error');
    // 例外の本文は出さない
    expect(line).not.toContain(secret);
    expect(printed.join('\n')).not.toContain(secret);
    // 履歴が残った組織の分はエラーにしない
    const succeeded = failedOrganization === first ? second : first;
    expect(printed.some((entry) => entry.includes(succeeded.id))).toBe(false);
  });
});

describe('定期処理の表', () => {
  test('cron の式 `0 * * * *` で期限切れの停止が起きる', async () => {
    const organization = await createOrganization({ trial_ends_on: '2026-10-31' });
    await expect(runScheduled('2026-11-01T00:00:00.000Z', EVERY_HOUR)).resolves.toBeUndefined();
    expect(await suspendedAtOf(organization.id)).toBe('2026-11-01T00:00:00.000Z');
  });

  test('`* * * * *` は従来どおり掃除で、期限切れの停止は起こさない', async () => {
    const organization = await createOrganization({ trial_ends_on: '2026-10-31' });
    await expect(runScheduled('2026-11-01T00:00:00.000Z', EVERY_MINUTE)).resolves.toBeUndefined();
    expect(await suspendedAtOf(organization.id)).toBeNull();
    expect(await changeLogsOf(organization.id)).toEqual([]);
  });

  test('表に無い式は従来どおり例外', async () => {
    await expect(runScheduled('2026-11-01T00:00:00.000Z', '30 * * * *')).rejects.toThrow(
      '定期処理の表に無い cron の式',
    );
    await expect(runScheduled('2026-11-01T00:00:00.000Z', '0 0 * * *')).rejects.toThrow('定期処理の表に無い cron の式');
  });
});
