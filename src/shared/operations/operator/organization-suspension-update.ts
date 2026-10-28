import { z } from 'zod';
import { SLUG_MAX_LENGTH } from '../../organization-slug.ts';
import { defineOperation } from '../define.ts';
import { suspensionKinds } from './organization-suspend.ts';

// 停止中の組織の停止の理由を、再開せずに切り替える。停止した日時（suspended_at）は変えない。
// 解約にすると purge_on を切り替えた日の UTC の日付の30日後にし、一時的な停止にすると空にする。
// 今と同じ理由への切り替えと、停止していない組織は 409 の conflict、無い slug は 404。
// 解約で消す予定日を過ぎた組織（予定日が今日の UTC の日付より前）から一時的な停止へは、409 の purge_due で断る
// （予定日が空になると消す SQL のガードが偽になり、消している途中で止まるため）。予定日の当日までは切り替えられる。
// 履歴は action が update で、changes_json は {"purge_on": [前, 後]} の1行。履歴を書けなくても切り替えは成功として返す
export const organizationSuspensionUpdate = defineOperation({
  name: 'organization-suspension-update',
  description:
    '停止中の組織の停止の理由（一時的な停止か解約）を切り替える。停止した日時は変えない。解約で消す予定日を過ぎた組織は一時的な停止へ切り替えられない（409 の purge_due）',
  mode: 'write',
  permission: 'operator',
  input: z.object({ slug: z.string().max(SLUG_MAX_LENGTH * 2), kind: z.enum(suspensionKinds) }),
  output: z.object({
    slug: z.string(),
    // 解約にしたときだけ入る（YYYY-MM-DD）
    purge_on: z.string().nullable(),
  }),
});
