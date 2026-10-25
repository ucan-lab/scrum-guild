// 組織の休日の一覧、登録、削除の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { HOLIDAYS_PER_REQUEST } from '../src/shared/holiday.ts';
import {
  organizationHolidayAdd,
  organizationHolidayDelete,
  organizationHolidayList,
} from '../src/shared/operations/organization/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createOrganizationHoliday, type OrganizationFixture } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

type HolidayInput = { holiday_on: string; name: string | null };

function add(target: Target, holidays: HolidayInput[], token: string = target.admin.token) {
  return post(app, organizationHolidayAdd, { slug: target.slug, token, body: { holidays } });
}

async function list(target: Target): Promise<HolidayInput[]> {
  const res = await post(app, organizationHolidayList, { slug: target.slug, token: target.admin.token });
  expect(res.status).toBe(200);
  return ((await res.json()) as { holidays: HolidayInput[] }).holidays;
}

function remove(target: Target, holidayOn: string, token: string = target.admin.token) {
  return post(app, organizationHolidayDelete, { slug: target.slug, token, body: { holiday_on: holidayOn } });
}

async function readRows(organization: OrganizationFixture) {
  const db = orgDb(env, organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('organization_holidays')
        .selectAll()
        .where('organization_id', '=', organization.id)
        .orderBy('holiday_on'),
    ),
  );
}

async function countLogs(organization: OrganizationFixture): Promise<number> {
  const db = orgDb(env, organization.verified);
  const rows = await db.rows(
    db.statement((q) => q.selectFrom('change_logs').select('id').where('organization_id', '=', organization.id)),
  );
  return rows.length;
}

// 2030-01-01 から続く count 日
function days(count: number): HolidayInput[] {
  return Array.from({ length: count }, (_, i) => ({
    holiday_on: new Date(Date.UTC(2030, 0, 1 + i)).toISOString().slice(0, 10),
    name: `休み ${i + 1}`,
  }));
}

describe('organization-holiday-add と organization-holiday-list', () => {
  test('登録した休日が、日付の古い順に一覧に出る。作った人は呼んだ管理者で、変更の履歴には書かない', async () => {
    const target = await createTarget();
    const res = await add(target, [
      { holiday_on: '2026-11-23', name: '勤労感謝の日' },
      { holiday_on: '2026-11-03', name: '文化の日' },
      { holiday_on: '2026-12-29', name: null },
    ]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 3, skipped: 0 });

    expect(await list(target)).toEqual([
      { holiday_on: '2026-11-03', name: '文化の日' },
      { holiday_on: '2026-11-23', name: '勤労感謝の日' },
      { holiday_on: '2026-12-29', name: null },
    ]);
    const rows = await readRows(target.organization);
    expect(rows.map((row) => row.created_by)).toEqual(Array(3).fill(target.admin.userId));
    expect(await countLogs(target.organization)).toBe(0);
  });

  test('登録済みの日付は飛ばし、名前も書き換えない。入った日数と飛ばした日数を返す', async () => {
    const target = await createTarget();
    await add(target, [{ holiday_on: '2026-11-03', name: '文化の日' }]);

    const res = await add(target, [
      { holiday_on: '2026-11-03', name: '書き換えた名前' },
      { holiday_on: '2026-11-23', name: '勤労感謝の日' },
    ]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 1, skipped: 1 });
    expect(await list(target)).toEqual([
      { holiday_on: '2026-11-03', name: '文化の日' },
      { holiday_on: '2026-11-23', name: '勤労感謝の日' },
    ]);
  });

  test('名前は前後の空白を除き、空は null で入れる', async () => {
    const target = await createTarget();
    await add(target, [
      { holiday_on: '2026-11-03', name: '  文化の日\u{3000}' },
      { holiday_on: '2026-11-04', name: '   ' },
    ]);
    expect(await list(target)).toEqual([
      { holiday_on: '2026-11-03', name: '文化の日' },
      { holiday_on: '2026-11-04', name: null },
    ]);
  });

  test(`上限の ${HOLIDAYS_PER_REQUEST} 日を1回で登録でき（文を区切って送る）、もう一度送ると全部飛ばす`, async () => {
    const target = await createTarget();
    const holidays = days(HOLIDAYS_PER_REQUEST);
    const first = await add(target, holidays);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ added: HOLIDAYS_PER_REQUEST, skipped: 0 });
    expect(await list(target)).toEqual(holidays);

    const again = await add(target, holidays);
    expect(await again.json()).toEqual({ added: 0, skipped: HOLIDAYS_PER_REQUEST });
    expect(await readRows(target.organization)).toHaveLength(HOLIDAYS_PER_REQUEST);
  });

  test.each([
    ['上限を超える日数', days(HOLIDAYS_PER_REQUEST + 1)],
    ['0 日', []],
    [
      '同じ送信の中で重なる日付',
      [
        { holiday_on: '2026-11-03', name: '文化の日' },
        { holiday_on: '2026-11-03', name: null },
      ],
    ],
    ['暦に無い日付', [{ holiday_on: '2026-02-30', name: null }]],
    ['YYYY/M/D の日付（解析は画面が行う）', [{ holiday_on: '2026/11/3', name: null }]],
    ['長すぎる名前', [{ holiday_on: '2026-11-03', name: 'あ'.repeat(41) }]],
    ['見えない文字を含む名前', [{ holiday_on: '2026-11-03', name: '文化\u{200B}の日' }]],
  ])('%sは 400 の invalid_input で、何も入れない', async (_, holidays) => {
    const target = await createTarget();
    const res = await add(target, holidays);
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe('invalid_input');
    expect(await readRows(target.organization)).toEqual([]);
  });

  test('一覧は自分の組織の休日だけを返す', async () => {
    const [target, other] = await Promise.all([createTarget(), createTarget()]);
    await createOrganizationHoliday(other.organization, other.admin.userId!, { holiday_on: '2026-11-03' });
    await add(target, [{ holiday_on: '2026-11-23', name: '勤労感謝の日' }]);
    expect(await list(target)).toEqual([{ holiday_on: '2026-11-23', name: '勤労感謝の日' }]);
  });

  test('同じ日付を別の組織で登録しても、それぞれ1行ずつ入る', async () => {
    const [target, other] = await Promise.all([createTarget(), createTarget()]);
    await createOrganizationHoliday(other.organization, other.admin.userId!, {
      holiday_on: '2026-11-03',
      name: 'ひばりの休み',
    });
    const res = await add(target, [{ holiday_on: '2026-11-03', name: '文化の日' }]);
    expect(await res.json()).toEqual({ added: 1, skipped: 0 });
    expect((await readRows(other.organization)).map((row) => row.name)).toEqual(['ひばりの休み']);
  });

  test('ワークスペースのリーダーとメンバーでも、管理者でなければ 403 で、何も入れない', async () => {
    const target = await createTarget();
    for (const person of [target.leader, target.member]) {
      const res = await add(target, [{ holiday_on: '2026-11-03', name: '文化の日' }], person.token);
      expect(res.status).toBe(403);
      expect(await errorCodeOf(res)).toBe('forbidden');
    }
    expect(await readRows(target.organization)).toEqual([]);
  });
});

describe('organization-holiday-delete', () => {
  test('組織の休日を1日消す。ほかの日は残る', async () => {
    const target = await createTarget();
    await add(target, [
      { holiday_on: '2026-11-03', name: '文化の日' },
      { holiday_on: '2026-11-23', name: '勤労感謝の日' },
    ]);
    const res = await remove(target, '2026-11-03');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ holiday_on: '2026-11-03' });
    expect(await list(target)).toEqual([{ holiday_on: '2026-11-23', name: '勤労感謝の日' }]);
    expect(await countLogs(target.organization)).toBe(0);
  });

  test('無い日付は 404 の not_found。消した日付をもう一度消しても 404', async () => {
    const target = await createTarget();
    await add(target, [{ holiday_on: '2026-11-03', name: '文化の日' }]);
    expect(await errorCodeOf(await remove(target, '2026-12-31'))).toBe('not_found');
    expect((await remove(target, '2026-11-03')).status).toBe(200);
    const again = await remove(target, '2026-11-03');
    expect(again.status).toBe(404);
    expect(await errorCodeOf(again)).toBe('not_found');
  });

  test('別の組織にだけある日付は 404 で、その組織の休日は消えない', async () => {
    const [target, other] = await Promise.all([createTarget(), createTarget()]);
    const holiday = await createOrganizationHoliday(other.organization, other.admin.userId!);
    const res = await remove(target, holiday.holiday_on);
    expect(res.status).toBe(404);
    expect(await readRows(other.organization)).toHaveLength(1);
  });

  test('管理者でなければ 403 で、消さない', async () => {
    const target = await createTarget();
    const holiday = await createOrganizationHoliday(target.organization, target.admin.userId!);
    const res = await remove(target, holiday.holiday_on, target.member.token);
    expect(res.status).toBe(403);
    expect(await readRows(target.organization)).toHaveLength(1);
  });

  test('日付の形でない入力は 400', async () => {
    const target = await createTarget();
    const res = await remove(target, '2026/11/3');
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe('invalid_input');
  });
});
