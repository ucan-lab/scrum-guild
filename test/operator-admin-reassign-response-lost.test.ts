// 運用者による管理者の指名し直し（organization-admin-reassign、Issue #217）で、新しい行を入れる batch() が
// 書き込みを終えた後に応答だけ失われたときを確かめる。自分が採番した行が今あれば、競合（409）にせず成功として返す
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { orgDb } from '../src/server/db/index.ts';
import {
  envWithD1Hooks,
  reassignOrganizationAdminForTest,
  verifiedOrganizationForTest,
} from '../src/server/db/testing.ts';
import { createOrganization } from './factories.ts';
import { OPERATOR_LOGIN_ID } from './operations/world.ts';

async function userIdsOf(organizationId: string) {
  const db = orgDb(env, verifiedOrganizationForTest(organizationId));
  const rows = await db.rows(
    db.statement((q) => q.selectFrom('users').select('id').where('organization_id', '=', organizationId)),
  );
  return rows.map((row) => row.id);
}

// batch() の書き込みは済み、応答だけが届かない
const responseLost = envWithD1Hooks(env, {
  afterBatch: () => {
    throw new Error('応答が届かなかった');
  },
});

describe('新しい行の書き込みの後に応答が失われる', () => {
  test('GitHub の指名は、自分が入れた行があれば created で返す', async () => {
    const organization = await createOrganization();
    const result = await reassignOrganizationAdminForTest(responseLost, organization.id, {
      operator: OPERATOR_LOGIN_ID,
      nominee: { provider: 'github', subject: '8430101', name: 'tsubaki-dev', accountId: null },
      now: new Date(),
    });
    expect(result).not.toBe('conflict');
    if (result === 'conflict') return;
    expect(result.outcome).toBe('created');
    expect(await userIdsOf(organization.id)).toEqual([result.userId]);
  });

  test('Google の指名も、自分が入れた待つ行があれば created で返す', async () => {
    const organization = await createOrganization();
    const result = await reassignOrganizationAdminForTest(responseLost, organization.id, {
      operator: OPERATOR_LOGIN_ID,
      nominee: {
        provider: 'google',
        waiting: {
          email: 'aoi@example.com',
          claimTokenHash: 'a'.repeat(64),
          claimExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
        name: 'aoi@example.com',
        accountId: null,
      },
      now: new Date(),
    });
    expect(result).not.toBe('conflict');
    if (result === 'conflict') return;
    expect(result.outcome).toBe('created');
    expect(await userIdsOf(organization.id)).toEqual([result.userId]);
  });
});
