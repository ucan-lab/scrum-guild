import { z } from 'zod';
import { defineOperation } from '../define.ts';

// 組織の管理者の状態。運用者が組織の中を見ずに、管理者のいない組織と、指名した人のログイン待ちの組織を見分けるのに使う。
//   none: 無効でない管理者の行が無い
//   pending: 管理者の行はあるが、どれもアカウントに結ばれていない（指名した人がまだログインしていない）
//   expired: pending のうち、どれも Google の指名で待つ行で、招待の URL の期限が過ぎている（運用者が指名し直す）
//   active: それ以外
export const adminStatuses = ['none', 'pending', 'expired', 'active'] as const;
export type AdminStatus = (typeof adminStatuses)[number];

// 組織をまたぐ一覧。組織の中のデータ（人の名前、ID など）は返さない。ユーザー数などの集計は組織の停止と再開の Issue で足す
export const listOrganizations = defineOperation({
  name: 'list-organizations',
  description:
    '組織の一覧を返す。slug、名前、停止した日時、データを消す予定日、作った日時、管理者の状態だけで、組織の中のデータは返さない',
  mode: 'read',
  permission: 'operator',
  input: z.object({}),
  output: z.object({
    organizations: z.array(
      z.object({
        slug: z.string(),
        name: z.string(),
        suspended_at: z.string().nullable(),
        // 解約で停止した組織の、データを消す予定日（YYYY-MM-DD）。一時的な停止と、停止していない組織では null
        purge_on: z.string().nullable(),
        created_at: z.string(),
        admin_status: z.enum(adminStatuses),
      }),
    ),
  }),
});
