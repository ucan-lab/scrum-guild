import { z } from 'zod';
import { EMAIL_MAX_LENGTH } from '../../email.ts';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import { GITHUB_USERNAME_MAX_LENGTH } from '../operator/resolve-github-user.ts';

// 招待する人の指し方。ログインの手段ごとに分ける（運用者の adminNomineeInput と同じ形。docs/requirements.md の「メンバーと権限」）。
// GitHub はユーザー名と、画面が invitee-resolve で確かめたユーザー ID を渡す。送るときに解決し直して、ID が違えば 409 の invitee_changed
// （確かめた後にユーザー名が付け替えられた場合に、別の人を招待しない）。
// Google はメールアドレスで指す。サーバーが normalizeEmail でそろえ、そろえられなければ 400 の invalid_input（details の code は
// email_invalid）。確かめる手順（invitee-resolve）は通らず、login_subject の空の招待を入れて、招待の URL を返す
const common = { workspace_id: idSchema, role: z.enum(['leader', 'member']) };
const githubInvitee = z.object({
  ...common,
  provider: z.literal('github'),
  username: z.string().trim().min(1).max(GITHUB_USERNAME_MAX_LENGTH),
  login_subject: z.string().min(1).max(20),
});
const googleInvitee = z.object({
  ...common,
  provider: z.literal('google'),
  email: z.string().trim().min(1).max(EMAIL_MAX_LENGTH),
});

// 入力の誤りの理由のうち、invitation-create だけのもの（GitHub の解決の理由は invitee-resolve と同じ）。
// 400 の invalid_input の details に { path, code, message } で入り、画面は code で文言を選ぶ
export const invitationCreateProblems = ['email_invalid'] as const;
export type InvitationCreateProblem = (typeof invitationCreateProblems)[number];

// ワークスペースに人を招待する。
// GitHub の断る順は、解決できない（400 の invalid_input。理由は invitee-resolve と同じ）、ID の違い、今所属している（409 の already_member）、
// 同じワークスペースに承諾待ちの招待がある（409 の already_invited）、組織の人数が上限以上で、招待する人がまだ数えられていない
// （409 の member_limit_reached。すでに数えられている人は上限でも招待できる）。無効にされた人であることでは断らない（人数に数えないので、上限では新しい人と同じく断る）。
// Google は、そろえられないメールアドレス（400）、人数の上限（409 の member_limit_reached。同じメールアドレスの承諾待ちの招待で
// 数えられていれば通る）の順に断る。sub が分からないので所属と承諾待ちの検査はしない（所属の検査は招待の URL から結ぶときに行う）。
// 同じワークスペースの同じメールアドレスの承諾待ちの招待は、同じ batch で取り消す（招待し直すと古い招待の URL は使えなくなる）。
// 人数の数え方は docs/data-model.md の organizations の「人数」。同時に招待して超えたときはそのまま認める（超えるのは同時に送った招待の数まで）。
// invitations と change_logs（action: create）を1回の batch で書く
export const invitationCreate = defineOperation({
  name: 'invitation-create',
  description:
    'GitHub のユーザー名か Google のメールアドレスとロールを指して、ワークスペースに人を招待する。組織の人数が上限なら、所属している人なら、承諾待ちの招待があれば 409。Google では招待の URL を返す',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  // GitHub では送るたびに解決し直すので、invitee-resolve と同じ大きさの別の枠で数える
  rateLimit: { max: 30, windowSeconds: 600 },
  input: z.discriminatedUnion('provider', [githubInvitee, googleInvitee]),
  output: z.object({
    invitation_id: z.string(),
    // GitHub ではユーザー名、Google ではそろえたメールアドレス
    login_name: z.string(),
    // Google の招待の URL（<公開 URL>/invite#<秘密>）と、その期限（ISO 8601）。応答の本文にだけ入る（二度と出ない。
    // 応答はどれも Cache-Control: no-store）。GitHub では null
    invite: z.object({ url: z.string(), expires_at: z.string() }).nullable(),
  }),
});
