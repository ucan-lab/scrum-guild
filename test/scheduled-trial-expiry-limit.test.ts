// 1回に止める組織の件数の上限（suspendExpiredTrials の limit）。期限の古い順に止め、残りは次の回に回る
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { commonDb, SUSPEND_EXPIRED_TRIALS_LIMIT, suspendExpiredTrials } from '../src/server/db/index.ts';
import { createOrganization } from './factories.ts';

const AT = new Date('2026-11-10T00:00:00.000Z');

describe('1回に止める件数の上限', () => {
  test('上限までを期限の古い順に止め、次の回で残りを止める', async () => {
    const a = await createOrganization({ trial_ends_on: '2026-11-03' });
    const b = await createOrganization({ trial_ends_on: '2026-11-01' });
    const c = await createOrganization({ trial_ends_on: '2026-11-02' });

    const first = await suspendExpiredTrials(env, '2026-11-10', AT, 2);
    expect(first.map((row) => row.id).sort()).toEqual([b.id, c.id].sort());

    const second = await suspendExpiredTrials(env, '2026-11-10', AT, 2);
    expect(second.map((row) => row.id)).toEqual([a.id]);

    expect(await suspendExpiredTrials(env, '2026-11-10', AT, 2)).toEqual([]);
    const db = commonDb(env);
    const row = await db.first(
      db.statement((q) => q.selectFrom('organizations').select('suspended_at').where('id', '=', a.id)),
    );
    expect(row?.suspended_at).toBe(AT.toISOString());
  });

  test('同じ期限の組織が上限の境目をまたいでも、2回で重複も取りこぼしも無い', async () => {
    const ids = [
      (await createOrganization({ trial_ends_on: '2026-11-01' })).id,
      (await createOrganization({ trial_ends_on: '2026-11-01' })).id,
      (await createOrganization({ trial_ends_on: '2026-11-01' })).id,
    ];
    const first = await suspendExpiredTrials(env, '2026-11-10', AT, 2);
    const second = await suspendExpiredTrials(env, '2026-11-10', AT, 2);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);
    expect([...first, ...second].map((row) => row.id).sort()).toEqual([...ids].sort());
  });

  test('定期処理が使う既定の上限は 200 件', () => {
    expect(SUSPEND_EXPIRED_TRIALS_LIMIT).toBe(200);
  });
});
