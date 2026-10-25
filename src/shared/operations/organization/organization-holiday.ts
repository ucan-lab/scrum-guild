import { z } from 'zod';
import { HOLIDAYS_PER_REQUEST, holidayNameSchema, holidayOnSchema } from '../../holiday.ts';
import { defineOperation } from '../define.ts';

// 組織の休日（docs/data-model.md の organization_holidays）。どれも管理者だけ。休日の登録と削除は change_logs に書かない
const holiday = z.object({ holiday_on: z.string(), name: z.string().nullable() });

// 件数に上限を付けない。祝日と会社の休日で、1年に20日前後の想定
export const organizationHolidayList = defineOperation({
  name: 'organization-holiday-list',
  description: '組織の休日を、日付の古い順に全件返す',
  mode: 'read',
  permission: 'admin',
  input: z.object({}),
  output: z.object({ holidays: z.array(holiday) }),
});

// 画面は貼り付けを解析した配列（src/shared/holiday.ts の parseHolidayPaste）を送る。同じ決まりでここでも検証する。
// 登録済みの日付は飛ばし、名前も書き換えない。同じ送信の中で同じ日付が重なれば 400
export const organizationHolidayAdd = defineOperation({
  name: 'organization-holiday-add',
  description: `組織の休日をまとめて登録する（1回に1〜${HOLIDAYS_PER_REQUEST}日）。登録済みの日付は飛ばし、名前も書き換えない。入った日数と飛ばした日数を返す`,
  mode: 'write',
  permission: 'admin',
  input: z.object({
    holidays: z
      .array(z.object({ holiday_on: holidayOnSchema, name: holidayNameSchema }))
      .min(1)
      .max(HOLIDAYS_PER_REQUEST)
      .refine((holidays) => new Set(holidays.map((item) => item.holiday_on)).size === holidays.length, {
        message: '同じ日付が重なっている',
      }),
  }),
  output: z.object({ added: z.number().int(), skipped: z.number().int() }),
});

// 無い日付（別の組織の休日を含む）は 404 の not_found
export const organizationHolidayDelete = defineOperation({
  name: 'organization-holiday-delete',
  description: '組織の休日を1日消す。無い日付は 404',
  mode: 'write',
  permission: 'admin',
  input: z.object({ holiday_on: holidayOnSchema }),
  output: z.object({ holiday_on: z.string() }),
});
