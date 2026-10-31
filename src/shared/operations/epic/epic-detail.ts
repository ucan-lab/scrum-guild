import { z } from 'zod';
import { epicRewardTiers } from '../../experience.ts';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import { definitionRefSchema } from '../definition/definition.ts';

// 討伐隊に入った経緯（epic_party_members.joined_via の CHECK と同じ並び）。受注、割り振り、配下のタスクの担当
export const epicJoinedVias = ['self', 'assigned', 'task_assignee'] as const;
export type EpicJoinedVia = (typeof epicJoinedVias)[number];

// 人の1行。name は離脱済みの人でも出す。left は、そのワークスペースに今の所属（left_at が空の行）が無いこと
const epicPersonSchema = z.object({ id: z.string(), name: z.string(), left: z.boolean() });

// エピックの画面を開くときに、画面が出すものを1回で読む。閉じたワークスペースでも読める。
// 無いエピック（別の組織・別のワークスペース・削除済みを含む）は 404。
// - requester: 依頼主。離脱済み（left）でも名前を出す（担当の判定と同じ）
// - reward_tier と reward_xp: クリア報酬の段階と額（額は src/shared/experience.ts の XP_EPIC_REWARD）。払うのはクリアの処理
// - party: 討伐隊（epic_party_members の行、入った順）。離脱済みの人も含む。level は組織の中の本人の経験値の合計から出し、
//   合計の数値は返さない
// - stories: 配下の削除していないストーリー（position の順。完了したものも含む）。points_done と points_all は、削除していない
//   配下のタスクのポイントの合計（未見積もりは 0。points_done は完了したタスクだけ）で、バックログの木と同じ数え方
// - today と week_start: ワークスペースのタイムゾーンでの今日と週の始まり（0〜6、0 が日曜）。期日の印を決める（backlog-tree と同じ。
//   ブラウザの時計とタイムゾーンに頼らない）
// - can_manage: 呼んだ人が依頼主か、リーダー（管理者を含む）か。割り振りとクリア報酬の変更と、後の口（クリア、中止）の出し分けに使う
// - can_change_requester: 呼んだ人がリーダー（管理者を含む）か。依頼主を替える口の出し分けに使う（依頼主本人は替えられない）
// - can_join: 呼んだ人が討伐隊に入れる人か（そのワークスペースに今所属し、無効でなく login_subject のある人。担当にできる人と同じ）。
//   受注と抜けるの出し分けに使う。所属していない管理者は偽
// - joined: 呼んだ人が、このエピックの討伐隊にいるか（入り方を問わない）
export const epicDetail = defineOperation({
  name: 'epic-detail',
  description:
    'エピックの画面の中身を返す。欄、依頼主、クリア報酬の段階と額、討伐隊、配下のストーリー（完了とポイントつき）、呼んだ人が管理できるか、討伐隊に入れるか、入っているか',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, epic_id: idSchema }),
  output: z.object({
    today: z.string(),
    week_start: z.number().int().min(0).max(6),
    epic: z.object({
      id: z.string(),
      title: z.string(),
      body_md: z.string().nullable(),
      due_on: z.string().nullable(),
      link_url: z.string().nullable(),
      // 振った区分（削除していないもの）。無ければ null
      category: definitionRefSchema.nullable(),
      // クリアした日時と、中止した日時。どちらも空なら進行中
      completed_at: z.string().nullable(),
      canceled_at: z.string().nullable(),
    }),
    requester: epicPersonSchema,
    reward_tier: z.enum(epicRewardTiers),
    reward_xp: z.number().int(),
    party: z.array(epicPersonSchema.extend({ level: z.number().int(), joined_via: z.enum(epicJoinedVias) })),
    stories: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        completed_at: z.string().nullable(),
        points_done: z.number().int(),
        points_all: z.number().int(),
      }),
    ),
    can_manage: z.boolean(),
    can_change_requester: z.boolean(),
    can_join: z.boolean(),
    joined: z.boolean(),
  }),
});
