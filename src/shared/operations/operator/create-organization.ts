import { z } from 'zod';
import { SLUG_MAX_LENGTH } from '../../organization-slug.ts';
import { defineOperation } from '../define.ts';
import { GITHUB_USERNAME_MAX_LENGTH } from './resolve-github-user.ts';

// 入力の誤りの理由。400 の invalid_input の details に、項目ごとの { path, code, message } で入る。
// 画面は code で文言を選ぶ（message は開発者向けで、画面に出さない）
export const createOrganizationProblems = [
  'slug_format',
  'slug_reserved',
  'github_user_not_found',
  'github_not_a_user',
  'github_user_changed',
  'login_provider_unavailable',
] as const;
export type CreateOrganizationProblem = (typeof createOrganizationProblems)[number];

// 最初の管理者の指し方。ログインの手段ごとに分ける（docs/requirements.md の「組織と運用者」）。
// GitHub はユーザー名と、運用者が resolve-github-user で確かめたユーザー ID を渡す。作るときにサーバーでもう一度解決し、
// ID が違えば invalid_input にする（確かめた後にユーザー名が付け替えられた場合に、別の人を管理者にしない）。
// Google はメールアドレスで指す。まだ使えず、選ぶと invalid_input（login_provider_unavailable）を返す
const githubAdmin = z.object({
  provider: z.literal('github'),
  username: z.string().trim().min(1).max(GITHUB_USERNAME_MAX_LENGTH),
  login_subject: z.string().min(1).max(20),
});
const googleAdmin = z.object({ provider: z.literal('google'), email: z.string().trim().min(1).max(254) });

// 組織の作り方は docs/data-model.md の「書き込みの単位」。共通の DB の organizations、続けて組織の DB の
// 最初の管理者の users の2回に分けて書く。users が入らなかったときは、管理者のいない組織が残る（一覧の admin_status が none）。
// 人数と添付ファイルの上限は既定の値で作る。重なる slug は 409 の conflict、GitHub に届かないときは 503 の unavailable
export const createOrganization = defineOperation({
  name: 'create-organization',
  description: '組織を作り、最初の管理者を指名する。slug は後から変えられない',
  mode: 'write',
  permission: 'operator',
  input: z.object({
    slug: z.string().max(SLUG_MAX_LENGTH * 2),
    name: z.string().trim().min(1).max(80),
    admin: z.discriminatedUnion('provider', [githubAdmin, googleAdmin]),
  }),
  output: z.object({
    slug: z.string(),
    name: z.string(),
    // 管理者に指名した人の GitHub のユーザー名。作った後に「この名前でログインするよう伝えてください」と出すのに使う
    admin_login_name: z.string(),
  }),
});
