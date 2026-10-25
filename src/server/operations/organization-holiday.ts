import { now } from '../../shared/clock.ts';
import {
  organizationHolidayAdd,
  organizationHolidayDelete,
  organizationHolidayList,
} from '../../shared/operations/organization/index.ts';
import { ApiError } from '../errors.ts';
import { implement } from './implement.ts';
import { actorUserIdOf } from './write-guards.ts';

// 1文に入れる行の数。D1 の1文の束縛は 100 個までで、1行が5列（organization_id、holiday_on、name、created_by、created_at）を束縛するので 20 行
const ROWS_PER_STATEMENT = 20;

// 件数に上限を付けない。祝日と会社の休日で、1年に20日前後の想定
export const organizationHolidayListOperation = implement(organizationHolidayList, async ({ db }) => {
  const holidays = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('organization_holidays')
        .select(['holiday_on', 'name'])
        .where('organization_id', '=', db.organizationId)
        .orderBy('holiday_on'),
    ),
  );
  return { holidays };
});

// 登録済みの日付は ON CONFLICT DO NOTHING で飛ばし、名前も書き換えない。入った日付は RETURNING で数える。
// 行を 20 行ずつの文に分け、全部を1回の batch（1つのトランザクション）で送る
export const organizationHolidayAddOperation = implement(organizationHolidayAdd, async ({ db, actor, input }) => {
  // permission: 'admin' は users の行がある管理者だけを通す。型の上の null を 404 で閉じる
  const actorUserId = actorUserIdOf(actor);
  const createdAt = now().toISOString();
  const rows = input.holidays.map((holiday) => ({
    organization_id: db.organizationId,
    holiday_on: holiday.holiday_on,
    name: holiday.name,
    created_by: actorUserId,
    created_at: createdAt,
  }));
  const statements = [];
  for (let start = 0; start < rows.length; start += ROWS_PER_STATEMENT) {
    const chunk = rows.slice(start, start + ROWS_PER_STATEMENT);
    statements.push(
      db.statement((q) =>
        q
          .insertInto('organization_holidays')
          .values(chunk)
          .onConflict((oc) => oc.doNothing())
          .returning('holiday_on'),
      ),
    );
  }
  const results = await db.batch(statements);
  const added = results.reduce((sum, result) => sum + result.rows.length, 0);
  return { added, skipped: rows.length - added };
});

export const organizationHolidayDeleteOperation = implement(organizationHolidayDelete, async ({ db, input }) => {
  const [result] = await db.batch([
    db.statement((q) =>
      q
        .deleteFrom('organization_holidays')
        .where('organization_id', '=', db.organizationId)
        .where('holiday_on', '=', input.holiday_on),
    ),
  ]);
  if ((result?.changes ?? 0) === 0) throw new ApiError(404, 'not_found');
  return { holiday_on: input.holiday_on };
});
