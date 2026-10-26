import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// 1回に返す履歴の件数の上限。続きは next を before に渡して読む
export const TASK_HISTORY_PAGE_SIZE = 50;

// 履歴の値。人、親、区分は、そのときの ID と名前（親のストーリーの { id, title } も { id, name } にそろえる）。
// 本文（body_md）と、形の合わない値は null で返す
export const taskHistoryValueSchema = z.union([
  z.null(),
  z.string(),
  z.number(),
  z.object({ id: z.string(), name: z.string() }),
]);

export const taskHistoryEntrySchema = z.object({
  id: z.string(),
  // create、update、complete、delete。ほかの値（後で足す reopen など）もそのまま返し、画面は変えた行として出す
  action: z.string(),
  created_at: z.string(),
  // 変えた人（今の名前）。null は同期などの定期処理か運用者の操作
  actor: z.object({ id: z.string(), name: z.string() }).nullable(),
  // 保存した順の、変えた欄と前と後。知らない欄も落とさず、欄の名前だけ（値は null）を返す
  changes: z.array(z.object({ field: z.string(), before: taskHistoryValueSchema, after: taskHistoryValueSchema })),
});

// 続きの位置。created_at は change_logs に書く形（toISOString の、ミリ秒まで UTC の日時）だけを受け付ける
const cursorSchema = z.object({ created_at: z.iso.datetime({ precision: 3 }), id: idSchema });

// 詳細の引き出しの「変更の履歴」。タスク1件の change_logs を新しい順（created_at の降順、同じなら id の降順）に、
// 1回 50 件まで返す。続きがあれば next（次に before へ渡す値）を返す。閉じたワークスペースでも読める。
// 削除したタスクは画面から隠すので、履歴も読めない（削除の履歴はリーダーと管理者が後の変更の履歴の画面で見る）。
// 無いタスク、削除したタスク、別のワークスペースと別の組織のタスクは 404。
// 時刻は画面がワークスペースのタイムゾーン（timezone）で出す
export const taskHistory = defineOperation({
  name: 'task-history',
  description:
    'タスク1件の変更の履歴（作成、属性の変更、完了、削除）を新しい順に 50 件ずつ返す。変えた人は今の名前、値はそのときの名前。本文の値は返さない',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, task_id: idSchema, before: cursorSchema.optional() }),
  output: z.object({
    entries: z.array(taskHistoryEntrySchema),
    next: cursorSchema.nullable(),
    timezone: z.string(),
  }),
});

export type TaskHistoryValue = z.output<typeof taskHistoryValueSchema>;
export type TaskHistoryEntry = z.output<typeof taskHistoryEntrySchema>;
