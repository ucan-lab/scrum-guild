import { z } from 'zod';
import { defineOperation } from '../define.ts';

// 組織の管理者の状態。運用者が組織の中を見ずに、管理者のいない組織と、指名した人のログイン待ちの組織を見分けるのに使う。
//   none: 無効でない管理者の行が無い
//   pending: 管理者の行はあるが、どれもアカウントに結ばれていない（指名した人がまだログインしていない）
//   expired: pending のうち、どれも Google の指名で待つ行で、招待の URL の期限が過ぎている（運用者が指名し直す）
//   active: それ以外
export const adminStatuses = ['none', 'pending', 'expired', 'active'] as const;
export type AdminStatus = (typeof adminStatuses)[number];

// 組織をまたぐ一覧。組織の中のデータ（人の名前、ID、ログインの ID など）は返さず、組織ごとの集計（数と日時）だけを返す。
// 集計の数え方は docs/data-model.md の users の節の、運用者の組織の一覧の集計を書いた箇条書き。添付ファイルの合計は出さない（#68 で足す）
export const listOrganizations = defineOperation({
  name: 'list-organizations',
  description:
    '組織の一覧を返す。slug、名前、お試しの期限とそれを過ぎたか、停止した日時、データを消す予定日とそれを過ぎたか、作った日時、管理者の状態と、組織ごとの集計（人数と上限、閉じていないワークスペースの数、削除していないタスクの数、添付ファイルの上限、最後に使われた日時）だけで、組織の中のデータは返さない',
  mode: 'read',
  permission: 'operator',
  input: z.object({}),
  output: z.object({
    organizations: z.array(
      z.object({
        slug: z.string(),
        name: z.string(),
        self_created: z.boolean(),
        trial_ends_on: z.string().nullable(),
        trial_expired: z.boolean(),
        suspended_at: z.string().nullable(),
        // 解約で停止した組織の、データを消す予定日（YYYY-MM-DD）。一時的な停止と、停止していない組織では null
        purge_on: z.string().nullable(),
        // 解約で停止し、消す予定日を過ぎた（予定日が今日の UTC の日付より前）。再開と一時的な停止への切り替えは 409 の purge_due で
        // 断られるので、画面はその操作を出さずに理由を出す。境目はサーバーの時計で決める
        purge_due: z.boolean(),
        created_at: z.string(),
        admin_status: z.enum(adminStatuses),
        // 組織の人数（used。数え方は docs/data-model.md の organizations の「人数」で、招待の上限と同じ）と上限（limit。member_limit）
        seats: z.object({ used: z.number().int(), limit: z.number().int() }),
        // 閉じていない（closed_at が空）ワークスペースの数
        workspace_count: z.number().int(),
        // 削除していない（deleted_at が空）タスクの数。受信箱、アーカイブ、閉じたワークスペースの分も含める
        task_count: z.number().int(),
        // 添付ファイルの上限（バイト）。organizations.attachment_quota_bytes のまま。使った量の合計は出さない（#68）
        attachment_quota_bytes: z.number().int(),
        // 組織の人（無効にした人も含む）が最後に使った日時（users.last_seen_at の最大）。だれも使っていなければ null
        last_used_at: z.string().nullable(),
      }),
    ),
  }),
});
