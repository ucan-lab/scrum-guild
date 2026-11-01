// 運用者の再開（organization-resume）でお試しが終わる（Issue #642）。同じ UPDATE で trial_ends_on が NULL になり、以後の定期処理で止まらない。
// 再開が 409 で断られたときと、停止、停止の理由の切り替えでは trial_ends_on を変えない
import { createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { commonDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import worker from '../src/server/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { setFixedNow } from '../src/shared/clock.ts';
import {
  organizationResume,
  organizationSuspend,
  organizationSuspensionUpdate,
} from '../src/shared/operations/operator/index.ts';
import { createOrganization } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { getOperator, testEnv, withNewSession } from './operations/world.ts';

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

const resumeBy = async (slug: string, useEnv?: Env) =>
  post(app, organizationResume, { token: await operatorToken(), body: { slug }, env: useEnv });

async function runHourly(scheduledTime: string) {
  await worker.scheduled(
    createScheduledController({ scheduledTime: Date.parse(scheduledTime), cron: '0 * * * *' }),
    env,
  );
}

const TRIAL_ENDS_ON = '2026-10-31';
const SUSPENDED_AT = '2026-11-01T00:00:00.000Z';
const LATER_PURGE_ON = '2999-12-31';

describe('再開でお試しが終わる', () => {
  test('再開すると、停止の解除と同じ UPDATE で trial_ends_on が NULL になる', async () => {
    const organization = await createOrganization({ trial_ends_on: TRIAL_ENDS_ON, suspended_at: SUSPENDED_AT });
    const res = await resumeBy(organization.slug);
    expect(res.status).toBe(200);
    const row = await organizationRow(organization.id);
    expect(row).toMatchObject({ suspended_at: null, purge_on: null, trial_ends_on: null });
    expect(row?.updated_at).not.toBe(organization.updated_at);
  });

  test('定期処理で止まった組織を再開すると、その後の定期処理（期限の何日も後）で止まらない', async () => {
    const organization = await createOrganization({ trial_ends_on: TRIAL_ENDS_ON });
    await runHourly('2026-11-01T00:00:00.000Z');
    expect((await organizationRow(organization.id))?.suspended_at).toBe('2026-11-01T00:00:00.000Z');

    expect((await resumeBy(organization.slug)).status).toBe(200);
    expect(await organizationRow(organization.id)).toMatchObject({ suspended_at: null, trial_ends_on: null });

    await runHourly('2026-11-01T01:00:00.000Z');
    await runHourly('2027-01-01T00:00:00.000Z');
    expect(await organizationRow(organization.id)).toMatchObject({
      suspended_at: null,
      purge_on: null,
      trial_ends_on: null,
    });
  });

  test('解約で止まった組織（予定日の当日まで）を再開しても trial_ends_on が NULL になる', async () => {
    const organization = await createOrganization({
      trial_ends_on: TRIAL_ENDS_ON,
      suspended_at: SUSPENDED_AT,
      purge_on: LATER_PURGE_ON,
    });
    expect((await resumeBy(organization.slug)).status).toBe(200);
    expect(await organizationRow(organization.id)).toMatchObject({
      suspended_at: null,
      purge_on: null,
      trial_ends_on: null,
    });
  });

  test('お試しの期限が無い組織（運用者が作った）を再開しても NULL のまま', async () => {
    const organization = await createOrganization({ suspended_at: SUSPENDED_AT });
    expect((await resumeBy(organization.slug)).status).toBe(200);
    expect((await organizationRow(organization.id))?.trial_ends_on).toBeNull();
  });

  test('再開は他の組織の trial_ends_on を変えない', async () => {
    const resumed = await createOrganization({ trial_ends_on: TRIAL_ENDS_ON, suspended_at: SUSPENDED_AT });
    const other = await createOrganization({ trial_ends_on: '2026-12-31', suspended_at: SUSPENDED_AT });
    await resumeBy(resumed.slug);
    expect(await organizationRow(other.id)).toMatchObject({ trial_ends_on: '2026-12-31', suspended_at: SUSPENDED_AT });
  });
});

describe('再開が 409 で断られたときは trial_ends_on を変えない', () => {
  test('停止していない組織の再開は 409 の conflict', async () => {
    const organization = await createOrganization({ trial_ends_on: '2999-01-01' });
    const res = await resumeBy(organization.slug);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('conflict');
    expect((await organizationRow(organization.id))?.trial_ends_on).toBe('2999-01-01');
  });

  test('消す予定日を過ぎた解約の再開は 409 の purge_due', async () => {
    const organization = await createOrganization({
      trial_ends_on: TRIAL_ENDS_ON,
      suspended_at: '2026-01-01T00:00:00.000Z',
      purge_on: '2026-01-31',
    });
    const res = await resumeBy(organization.slug);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('purge_due');
    expect(await organizationRow(organization.id)).toMatchObject({
      suspended_at: '2026-01-01T00:00:00.000Z',
      purge_on: '2026-01-31',
      trial_ends_on: TRIAL_ENDS_ON,
    });
  });

  test('読んだ後に別の運用者が先に再開していた 409 の conflict でも、先の状態のまま trial_ends_on を書き換えない', async () => {
    const organization = await createOrganization({ trial_ends_on: TRIAL_ENDS_ON, suspended_at: SUSPENDED_AT });
    let armed = true;
    const racing = envWithD1Hooks(testEnv, {
      afterQuery: async (sql) => {
        if (!armed || !sql.includes('from "organizations"') || !sql.includes('"purge_on"')) return;
        armed = false;
        const db = commonDb(env);
        // 別の運用者が先に再開した（この実装の前の状態: trial_ends_on は残っている）
        await db.batch([
          db.statement((q) =>
            q.updateTable('organizations').set({ suspended_at: null }).where('id', '=', organization.id),
          ),
        ]);
      },
    });
    const res = await resumeBy(organization.slug, racing);
    expect(armed).toBe(false);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('conflict');
    expect((await organizationRow(organization.id))?.trial_ends_on).toBe(TRIAL_ENDS_ON);
  });

  test('無い slug は 404 で、どの組織の trial_ends_on も変えない', async () => {
    const organization = await createOrganization({ trial_ends_on: TRIAL_ENDS_ON, suspended_at: SUSPENDED_AT });
    const res = await resumeBy('no-such-organization');
    expect(res.status).toBe(404);
    expect((await organizationRow(organization.id))?.trial_ends_on).toBe(TRIAL_ENDS_ON);
  });
});

describe('停止と理由の切り替えは trial_ends_on を変えない', () => {
  test('運用者の一時的な停止と解約', async () => {
    const token = await operatorToken();
    const temporary = await createOrganization({ trial_ends_on: '2999-01-01' });
    const cancellation = await createOrganization({ trial_ends_on: '2999-02-02' });
    expect(
      (await post(app, organizationSuspend, { token, body: { slug: temporary.slug, kind: 'temporary' } })).status,
    ).toBe(200);
    expect(
      (await post(app, organizationSuspend, { token, body: { slug: cancellation.slug, kind: 'cancellation' } })).status,
    ).toBe(200);
    expect((await organizationRow(temporary.id))?.trial_ends_on).toBe('2999-01-01');
    expect((await organizationRow(cancellation.id))?.trial_ends_on).toBe('2999-02-02');
  });

  test('一時的な停止から解約へ、解約から一時的な停止へ', async () => {
    const token = await operatorToken();
    const toCancellation = await createOrganization({ trial_ends_on: TRIAL_ENDS_ON, suspended_at: SUSPENDED_AT });
    const toTemporary = await createOrganization({
      trial_ends_on: TRIAL_ENDS_ON,
      suspended_at: SUSPENDED_AT,
      purge_on: LATER_PURGE_ON,
    });
    const a = await post(app, organizationSuspensionUpdate, {
      token,
      body: { slug: toCancellation.slug, kind: 'cancellation' },
    });
    const b = await post(app, organizationSuspensionUpdate, {
      token,
      body: { slug: toTemporary.slug, kind: 'temporary' },
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((await organizationRow(toCancellation.id))?.trial_ends_on).toBe(TRIAL_ENDS_ON);
    expect((await organizationRow(toTemporary.id))?.trial_ends_on).toBe(TRIAL_ENDS_ON);
  });
});
