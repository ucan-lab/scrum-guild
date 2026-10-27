import { z } from 'zod';
import { SLUG_MAX_LENGTH } from '../../organization-slug.ts';
import { defineOperation } from '../define.ts';
import { adminNomineeInput } from './create-organization.ts';

// 入力の誤りの理由。400 の invalid_input の details に、項目ごとの { path, code, message } で入る（組織の作成と同じ path と code）
export const reassignAdminProblems = [
  'github_user_not_found',
  'github_not_a_user',
  'github_user_changed',
  'email_invalid',
  // 指名する GitHub の人が、操作する運用者自身（運用者のアカウントに結んだログインのどれか）。Google は突き合わせられないので見ない
  'nominee_is_operator',
] as const;
export type ReassignAdminProblem = (typeof reassignAdminProblems)[number];

// 既にある組織に、管理者を指名し直す（Issue #217）。どの組織にも（管理者の状態が active の組織にも、停止中の組織にも）指名できる。
// その組織の、まだログインしていない前の指名（account_id が空の users の行）を消し、続けて指名する。前の管理者の印は外さない。
// 指し方と応答は組織の作成と同じ。GitHub は同じ組織に既にいる人なら、その人を管理者にする（無効にされていれば戻す）。
// 無い slug は 404 の not_found、GitHub に届かないときは 503 の unavailable、競合は 409 の conflict。
// 応答に組織の中のデータ（人の名前や ID）を入れない
export const organizationAdminReassign = defineOperation({
  name: 'organization-admin-reassign',
  description: '既にある組織に管理者を指名し直す。まだログインしていない前の指名は消す',
  mode: 'write',
  permission: 'operator',
  input: z.object({
    slug: z.string().max(SLUG_MAX_LENGTH * 2),
    admin: adminNomineeInput,
  }),
  output: z.object({
    slug: z.string(),
    // 指名した人の GitHub のユーザー名。Google の指名ではそろえたメールアドレス
    admin_login_name: z.string(),
    // Google の指名で作った招待の URL と、その期限（ISO 8601）。GitHub の指名では null
    invite: z.object({ url: z.string(), expires_at: z.string() }).nullable(),
  }),
});
