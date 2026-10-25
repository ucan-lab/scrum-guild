import { z } from 'zod';
import { SLUG_MAX_LENGTH } from '../../organization-slug.ts';
import { defineOperation } from '../define.ts';

// 停止した組織を再開する。suspended_at と purge_on を空に戻す。解約で消す予定日を過ぎていても、データを消すまでは再開できる。
// 停止していない組織は 409 の conflict、無い slug は 404。履歴の扱いは organization-suspend と同じ
export const organizationResume = defineOperation({
  name: 'organization-resume',
  description: '停止した組織を再開する。停止した日時と、データを消す予定日を空に戻す',
  mode: 'write',
  permission: 'operator',
  input: z.object({ slug: z.string().max(SLUG_MAX_LENGTH * 2) }),
  output: z.object({ slug: z.string() }),
});
