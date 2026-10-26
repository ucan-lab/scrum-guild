import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import { GITHUB_USERNAME_MAX_LENGTH } from '../operator/resolve-github-user.ts';

// 招待に使えるログインの手段。Google のメールアドレスでの招待は #190 で足す
export const inviteProviderSchema = z.enum(['github']);

// メンバーの画面の「招待する」の節が、招待する前にリーダーへ相手を見せるために使う。返す形は運用者の resolve-github-user に、
// 組織の人数にすでに数えられているか（already_counted）を足したもの。
// 見つからない人と個人のアカウントでない人は 400 の invalid_input（details の code が github_user_not_found、github_not_a_user）、
// GitHub に届かないときは 503 の unavailable。GitHub に問い合わせるので、アカウントと操作ごとに回数を数える
// （ログインの枠とは別。超えたら 429 の rate_limited）
export const inviteeResolve = defineOperation({
  name: 'invitee-resolve',
  description:
    '招待する人のログインの手段（GitHub）のユーザー名を、ユーザー ID、ユーザー名、表示名、アバターの URL に解決する。招待はしない',
  mode: 'read',
  permission: 'leader',
  workspace: true,
  rateLimit: { max: 30, windowSeconds: 600 },
  input: z.object({
    workspace_id: idSchema,
    provider: inviteProviderSchema,
    username: z.string().trim().min(1).max(GITHUB_USERNAME_MAX_LENGTH),
  }),
  output: z.object({
    // GitHub のユーザー ID（10進の文字列）。invitation-create に、確かめた ID として渡す
    login_subject: z.string(),
    login_name: z.string(),
    display_name: z.string().nullable(),
    avatar_url: z.string().nullable(),
    // すでに組織の人数に数えられている人か（docs/data-model.md の organizations の「人数」）。
    // 人数が上限に達していても、数えられている人は招待できる。画面が「招待する」を押せるかを決めるのに使う
    already_counted: z.boolean(),
  }),
});
