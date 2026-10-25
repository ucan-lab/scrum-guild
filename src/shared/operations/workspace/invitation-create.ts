import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import { GITHUB_USERNAME_MAX_LENGTH } from '../operator/resolve-github-user.ts';
import { inviteProviderSchema } from './invitee-resolve.ts';

// ワークスペースに人を招待する。ユーザー名と、画面が invitee-resolve で確かめたユーザー ID を受け、送るときに解決し直して
// ID が違えば 409 の invitee_changed（確かめた後にユーザー名が付け替えられた場合に、別の人を招待しない）。
// 断る順は、組織の人数が上限以上（409 の member_limit_reached。招待する人がすでに数えられている人でも断る）、
// 解決できない（400 の invalid_input。理由は invitee-resolve と同じ）、ID の違い、今所属している（409 の already_member）、
// 同じワークスペースに承諾待ちの招待がある（409 の already_invited）。無効にされた人への招待は断らない。
// 人数の数え方は docs/data-model.md の organizations の「人数」。同時に招待して少し超えたときはそのまま認める。
// invitations と change_logs（action: create）を1回の batch で書く
export const invitationCreate = defineOperation({
  name: 'invitation-create',
  description:
    'GitHub のユーザー名とロールを指して、ワークスペースに人を招待する。組織の人数が上限なら、所属している人なら、承諾待ちの招待があれば 409',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  // 送るたびに GitHub に解決し直すので、invitee-resolve と同じ大きさの別の枠で数える
  rateLimit: { max: 30, windowSeconds: 600 },
  input: z.object({
    workspace_id: idSchema,
    provider: inviteProviderSchema,
    username: z.string().trim().min(1).max(GITHUB_USERNAME_MAX_LENGTH),
    login_subject: z.string().min(1).max(20),
    role: z.enum(['leader', 'member']),
  }),
  output: z.object({ invitation_id: z.string(), login_name: z.string() }),
});
