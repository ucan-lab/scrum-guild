import { z } from 'zod';
import { defineOperation } from '../define.ts';

// GitHub のユーザー名の最大の長さ（英数字とハイフンで 39 文字）
export const GITHUB_USERNAME_MAX_LENGTH = 39;

// 組織の作成のダイアログが、最初の管理者に指名する人を、作る前に運用者へ見せるために使う。
// 見せるのは GitHub の公開の情報で、組織の中のデータではない。
// 届かないとき（GitHub の上限、障害）は 503 の unavailable、見つからない人と個人のアカウントでない人は 400 の invalid_input
export const resolveGithubUser = defineOperation({
  name: 'resolve-github-user',
  description: 'GitHub のユーザー名をユーザー ID に解決し、ユーザー名、表示名、アバターの URL とともに返す',
  mode: 'read',
  permission: 'operator',
  input: z.object({ username: z.string().trim().min(1).max(GITHUB_USERNAME_MAX_LENGTH) }),
  output: z.object({
    // GitHub のユーザー ID（10進の文字列）。account_logins.login_subject と同じ値
    login_subject: z.string(),
    // GitHub が返す綴りのユーザー名
    login_name: z.string(),
    display_name: z.string().nullable(),
    avatar_url: z.string().nullable(),
  }),
});
