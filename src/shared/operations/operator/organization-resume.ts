import { z } from 'zod';
import { SLUG_MAX_LENGTH } from '../../organization-slug.ts';
import { defineOperation } from '../define.ts';

// 停止した組織を再開する。suspended_at と purge_on を空に戻す。解約で消す予定日を過ぎた組織（予定日が今日の UTC の日付より前）は、
// データを消している途中で戻さないよう 409 の purge_due で断る。境目は消す SQL のガードと同じで、予定日の当日までは再開できる。
// 停止していない組織と、読んだ後に別の運用者が先に操作していたときは 409 の conflict、無い slug は 404。履歴の扱いは organization-suspend と同じ
export const organizationResume = defineOperation({
  name: 'organization-resume',
  description:
    '停止した組織を再開する。停止した日時と、データを消す予定日を空に戻す。解約で消す予定日を過ぎた組織は再開できない（409 の purge_due）',
  mode: 'write',
  permission: 'operator',
  input: z.object({ slug: z.string().max(SLUG_MAX_LENGTH * 2) }),
  output: z.object({ slug: z.string() }),
});
