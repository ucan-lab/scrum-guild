import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// 組織の変更の履歴（docs/data-model.md の change_logs の「組織の変更の履歴」）。管理者だけ。
// 新しい順に ORGANIZATION_HISTORY_PAGE_SIZE 件ずつ返し、続きは next のカーソルで読む。期間で消さない表なので、全部を読み切れる
export const ORGANIZATION_HISTORY_PAGE_SIZE = 50;

// カーソル。前のページの最後の行の created_at と id。created_at は change_logs に書く形（toISOString の UTC、ミリ秒まで）に限る
const cursor = z.object({
  created_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  id: idSchema.min(1),
});

// した人。users の行（今の名前。行が無いときは null）、運用者（ログインの ID は返さない）、どちらも空なら自動の処理
const actor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), id: z.string(), name: z.string().nullable() }),
  z.object({ kind: z.literal('operator') }),
  z.object({ kind: z.literal('system') }),
]);

// 内容。entity_type と action（と changes_json の列）の組ごとに、画面の文に要る値だけを持つ。changes_json はそのまま返さない。
// 人の名前（name）は、記録にそのときの名前があればそれを、無ければ users の今の名前。分からなければ null
const event = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('organization_created'), name: z.string().nullable() }),
  // 停止。purge_on は解約で消す予定日（YYYY-MM-DD）、一時的な停止は null
  z.object({ kind: z.literal('organization_suspended'), purge_on: z.string().nullable() }),
  z.object({ kind: z.literal('organization_resumed') }),
  // 停止の理由の切り替え。purge_on は切り替えた後の値
  z.object({ kind: z.literal('organization_suspension_changed'), purge_on: z.string().nullable() }),
  // 組織の設定（言葉づかい、既定のテーマ）の変更
  z.object({ kind: z.literal('organization_settings_changed') }),
  // 管理者の指名。name が null なのは、Google の招待でまだログインしていない（か、既にいる人にまとめた）指名
  z.object({ kind: z.literal('admin_designated'), name: z.string().nullable() }),
  // Google の招待で指名した人が初めてログインし、指名の行に結んだ
  z.object({ kind: z.literal('admin_login_linked'), name: z.string().nullable() }),
  // Google の招待で指名した人が、同じ組織に既にいる人だったので、その人を管理者にした
  z.object({ kind: z.literal('admin_designation_merged'), name: z.string().nullable() }),
  z.object({ kind: z.literal('admin_revoked'), name: z.string().nullable() }),
  z.object({ kind: z.literal('user_disabled'), name: z.string().nullable() }),
  z.object({ kind: z.literal('user_enabled'), name: z.string().nullable() }),
  // ワークスペースの作成、終了、再開。作成はそのときの名前、終了と再開は今の名前
  z.object({ kind: z.literal('workspace_created'), workspace_name: z.string().nullable() }),
  z.object({ kind: z.literal('workspace_closed'), workspace_name: z.string().nullable() }),
  z.object({ kind: z.literal('workspace_reopened'), workspace_name: z.string().nullable() }),
  // 知らない組。画面は「組織を変更しました」とだけ出す
  z.object({ kind: z.literal('other') }),
]);

export const organizationHistory = defineOperation({
  name: 'organization-history',
  description: `組織の変更の履歴（組織の作成、管理者の指名、運用者の操作、ワークスペースの作成・終了・再開）を、新しい順に ${ORGANIZATION_HISTORY_PAGE_SIZE} 件ずつ返す。before を渡すと、その行より前を返す`,
  mode: 'read',
  permission: 'admin',
  input: z.object({ before: cursor.nullable().optional() }),
  output: z.object({
    entries: z.array(z.object({ id: z.string(), created_at: z.string(), actor, event })),
    // 続きがあれば、次に before へ渡すカーソル。無ければ null
    next: cursor.nullable(),
  }),
});
