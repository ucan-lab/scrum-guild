import { z } from 'zod';
import { SLUG_MAX_LENGTH } from '../../organization-slug.ts';
import { defineOperation } from '../define.ts';

// 解約で停止してから、運用者がデータを消すまでの日数（docs/requirements.md の「組織と運用者」）
export const PURGE_AFTER_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

// 解約で停止したときの、データを消す予定日。停止した日時の UTC の日付の30日後（YYYY-MM-DD）
export function purgeDateOf(suspendedAt: Date): string {
  return new Date(suspendedAt.getTime() + PURGE_AFTER_DAYS * DAY_MS).toISOString().slice(0, 10);
}

// 日時の UTC の日付（YYYY-MM-DD）。D1 の date('now') と同じ日付
export function utcDateOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

// 解約で消す予定日を過ぎた（予定日が今日の UTC の日付より前）。境目は消す SQL のガード
// （scripts/purge-organization-sql.ts の purge_on < date('now')）と同じで、予定日の当日はまだ過ぎていない。
// 過ぎた組織は、再開も一時的な停止への切り替えもできない（409 の purge_due）
export function isPurgeDue(purgeOn: string | null, at: Date): boolean {
  return purgeOn !== null && purgeOn < utcDateOf(at);
}

// 停止の種類。temporary は支払いの遅れなどの一時的な停止（消す予定日は持たない）、cancellation は解約（停止した日の UTC の日付の30日後が消す予定日）
export const suspensionKinds = ['temporary', 'cancellation'] as const;
export type SuspensionKind = (typeof suspensionKinds)[number];

// 組織を停止する。組織の分離の対象外の運用者の操作で、共通の表の organizations の suspended_at と purge_on を、停止していないことを条件に書く。
// 既に停止している組織は 409 の conflict、無い slug は 404。停止中の組織には、停止していなければ入れた人にも入れない（docs/requirements.md の「組織と運用者」）。
// 組織の変更の履歴（change_logs）に運用者の操作として残すが、履歴を書けなくても停止は成功として返す
export const organizationSuspend = defineOperation({
  name: 'organization-suspend',
  description: '組織を停止する。解約なら、停止した日の UTC の日付の30日後を、データを消す予定日として残す',
  mode: 'write',
  permission: 'operator',
  input: z.object({ slug: z.string().max(SLUG_MAX_LENGTH * 2), kind: z.enum(suspensionKinds) }),
  output: z.object({
    slug: z.string(),
    suspended_at: z.string(),
    // 解約のときだけ入る（YYYY-MM-DD）
    purge_on: z.string().nullable(),
  }),
});
