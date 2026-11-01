import { afterEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { listOrganizations } from '../src/shared/operations/operator/index.ts';
import { organizationInfo } from '../src/shared/operations/organization/index.ts';
import type { OutputOf } from '../src/shared/operations/define.ts';
import { createOrganization, createSessionWithToken, createWorkspace } from './factories.ts';
import { post } from './operations/harness.ts';
import { createPerson, getOperator } from './operations/world.ts';

const app = createApp(implementedOperations);

// 時計を 2028 年に進めても、フィクスチャのセッション（期限 2026-11-19）が切れないようにする
const LONG_SESSION = { expires_at: '2030-01-01T00:00:00.000Z' };

afterEach(() => vi.useRealTimers());

function at(value: string): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(value));
}

async function read(slug: string, token: string) {
  const response = await post(app, organizationInfo, { slug, token });
  expect(response.status).toBe(200);
  return (await response.json()) as OutputOf<typeof organizationInfo>;
}

describe('organization のお試しの期限', () => {
  test.each([
    ['2028-02-28T23:59:59.999Z', '2028-03-01', 2],
    ['2028-02-29T00:00:00.000Z', '2028-03-01', 1],
    ['2028-03-01T00:00:00.000Z', '2028-03-01', 0],
    ['2028-03-01T23:59:59.999Z', '2028-03-01', 0],
    ['2028-03-02T00:00:00.000Z', '2028-03-01', -1],
    ['2026-12-31T23:30:00-02:00', '2027-01-02', 1],
  ])('管理者には UTC の日付差を返す（%s）', async (instant, endsOn, daysLeft) => {
    at(instant);
    const organization = await createOrganization({ trial_ends_on: endsOn });
    const admin = await createPerson({ organization, admin: true, sessionOverrides: LONG_SESSION });
    expect((await read(organization.slug, admin.token)).trial).toEqual({ ends_on: endsOn, days_left: daysLeft });
  });

  test('メンバーには期限の値を返さない', async () => {
    const organization = await createOrganization({ trial_ends_on: '2026-11-30' });
    const admin = await createPerson({ organization, admin: true });
    const workspace = await createWorkspace(organization, admin.userId!);
    const member = await createPerson({ organization, membership: { workspaceId: workspace.id, role: 'member' } });
    const result = await read(organization.slug, member.token);
    expect(result.trial).toBeNull();
    expect(JSON.stringify(result)).not.toContain('2026-11-30');
  });

  test('期限のない組織の管理者には null を返す', async () => {
    const organization = await createOrganization();
    const admin = await createPerson({ organization, admin: true });
    expect((await read(organization.slug, admin.token)).trial).toBeNull();
  });

  test('別の組織に入れない管理者には、その組織の期限を返さない', async () => {
    const trial = await createOrganization({ trial_ends_on: '2026-11-30' });
    const other = await createOrganization();
    const admin = await createPerson({ organization: trial, admin: true });
    const response = await post(app, organizationInfo, { slug: other.slug, token: admin.token });
    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain('2026-11-30');
  });
});

describe('list-organizations のお試しの期限', () => {
  test.each(['2028-03-01T00:00:00.000Z', '2028-03-01T23:59:59.999Z'])(
    'UTC の当日は期限切れにせず、今日より前だけを期限切れにする（%s）',
    async (instant) => {
      at(instant);
      const dates = [null, '2028-02-29', '2028-03-01', '2028-03-02'];
      const organizations = await Promise.all(dates.map((trial_ends_on) => createOrganization({ trial_ends_on })));
      const token = (await createSessionWithToken((await getOperator()).accountId, LONG_SESSION)).token;
      const response = await post(app, listOrganizations, { token });
      expect(response.status).toBe(200);
      const result = (await response.json()) as OutputOf<typeof listOrganizations>;
      expect(organizations.map((org) => result.organizations.find((row) => row.slug === org.slug))).toEqual(
        dates.map((date) => expect.objectContaining({ trial_ends_on: date, trial_expired: date === '2028-02-29' })),
      );
    },
  );
});
