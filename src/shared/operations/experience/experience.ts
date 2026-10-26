import { z } from 'zod';
import { experienceActions } from '../../experience.ts';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// 経験値とレベル（docs/requirements.md の「ゲームの仕組み」、docs/data-model.md の「経験値の読み方」）。
// 経験値の数値と明細は本人にだけ返す。ほかの人に見せるのはレベルだけで、レベルは member-list と organization の応答に足す。
// どの操作も呼んだ人の分だけを読み、人を指す入力を持たない（ほかの人の数値を返す操作は作らない）

// 1回に返す明細の件数の上限。続きは next を before に渡して読む
export const EXPERIENCE_GRANTS_PAGE_SIZE = 50;

// 自分の設定の画面の「レベル」の面。組織の中の自分の合計とレベル、見込み、ワークスペースごとの内訳を返す。
// 合計は、その組織のワークスペースの xp_grants のうち、呼んだ人の行の SUM(amount)（抜けたワークスペースと閉じたワークスペースの分も含む）。
// level_start は今のレベルの始まりの合計、next_level_at は次のレベルに要る合計（src/shared/experience.ts）。
// 見込みは、今所属している閉じていないワークスペースで、自分が手で作った、未完了の、削除していない、ポイントが1以上のタスク1件につき
// 起票の経験値（XP_TASK_CREATED）。workspaces は、明細のあるワークスペースと今所属しているワークスペース（閉じたものも含む）で、
// 名前の昇順、同じ名前は ID の昇順。total と prospective は組織の合計の内訳
export const experienceSummary = defineOperation({
  name: 'experience-summary',
  description:
    '呼んだ人の、この組織での経験値の合計、レベル、次のレベルまで、見込みと、ワークスペースごとの内訳を返す。ほかの人の値は返さない',
  mode: 'read',
  permission: 'organization',
  input: z.object({}),
  output: z.object({
    total: z.number().int(),
    level: z.number().int(),
    level_start: z.number().int(),
    next_level_at: z.number().int(),
    prospective: z.number().int(),
    workspaces: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        total: z.number().int(),
        prospective: z.number().int(),
      }),
    ),
  }),
});

// 続きの位置。confirmed_at は xp_grants に書く形（toISOString の、ミリ秒まで UTC の日時）だけを受け付ける
const cursorSchema = z.object({ confirmed_at: z.iso.datetime({ precision: 3 }), id: idSchema });

export const experienceGrantSchema = z.object({
  id: z.string(),
  confirmed_at: z.string(),
  workspace_id: z.string(),
  workspace_name: z.string(),
  action: z.enum(experienceActions),
  // 付与のもとになったタスク、ストーリー、エピックのタイトル（削除したものも出す）。どれも指さない行と、
  // 今所属していないワークスペースの行（content_hidden）は null
  content: z.string().nullable(),
  // 今所属していないワークスペース（抜けた、所属していない管理者）の行なので、内容を伏せた
  content_hidden: z.boolean(),
  // 正なら付与、負なら打ち消し
  amount: z.number().int(),
});

// 自分の設定の画面の「経験値の明細」。呼んだ人の、この組織のワークスペースの xp_grants を、新しい順
// （confirmed_at の降順、同じなら id の降順）に 1回 50 件まで返す。続きがあれば next（次に before へ渡す値）を返す
export const experienceGrants = defineOperation({
  name: 'experience-grants',
  description:
    '呼んだ人の経験値の明細（確定日時、ワークスペース、行動、内容、値。打ち消しは負の値）を新しい順に 50 件ずつ返す。ほかの人の明細は返さない',
  mode: 'read',
  permission: 'organization',
  input: z.object({ before: cursorSchema.optional() }),
  output: z.object({ grants: z.array(experienceGrantSchema), next: cursorSchema.nullable() }),
});

// バックログの画面の見出しの近くに出す、チーム全体の経験値の合計。そのワークスペースの xp_grants の SUM(amount) の1つの数で、
// 抜けた人の分も含む。人ごとの値は返さない。所属している人と管理者が読める
export const experienceTeamTotal = defineOperation({
  name: 'experience-team-total',
  description: 'ワークスペースのチーム全体の経験値の合計を1つの数で返す。人ごとの値は返さない',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema }),
  output: z.object({ total: z.number().int() }),
});

export type ExperienceGrant = z.output<typeof experienceGrantSchema>;
