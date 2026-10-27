import { z } from 'zod';
import { commentBodySchema } from '../../comment.ts';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';

// タスクのコメント（詳細の引き出しの「コメント」のタブ）の、一覧、書く、直す、消すの操作の定義。
// 対象のタスクは task-detail と同じ（そのワークスペースの削除していないタスク。受信箱、アーカイブ、完了済みも含む）で、
// それ以外（無いタスク、削除したタスク、別のワークスペースと別の組織のタスクとコメント）は 404。存在（404）を権限（403）より先に決める。
// 閉じたワークスペースでは読むだけで、書く操作は 409 の workspace_closed。
// 消したコメントは「削除されました」として一覧に残るので、消えたコメントを直す、消すは 404 でなく 409 の conflict（details.reason は deleted）

// 1回に返すコメントの件数の上限。それより前は next を before に渡して読む
export const COMMENT_PAGE_SIZE = 50;

// 409 の conflict の理由。deleted は、直す（消す）前にそのコメントが消されていた
export const commentConflictReasons = ['deleted'] as const;

const personSchema = z.object({ id: z.string(), name: z.string() });

export const commentSchema = z.object({
  id: z.string(),
  // 書いた人（組織の users の今の名前。抜けた人、無効にされた人も名前を出して残す）
  author: personSchema,
  // 本文（Markdown）。消したコメントは空の文字
  body_md: z.string(),
  created_at: z.string(),
  // 直した日時。入っていれば「編集済み」
  edited_at: z.string().nullable(),
  // 消した日時と消した人（今の名前）。消していなければ null
  deleted_at: z.string().nullable(),
  deleted_by: personSchema.nullable(),
  // 呼んだ人が直せるか（書いた本人だけ）、消せるか（書いた本人とリーダー、管理者）。消したコメントと、閉じたワークスペースでは偽
  can_edit: z.boolean(),
  can_delete: z.boolean(),
});

// 続きの位置。created_at は comments に書く形（toISOString の、ミリ秒まで UTC の日時）だけを受け付ける
const cursorSchema = z.object({ created_at: z.iso.datetime({ precision: 3 }), id: idSchema });

// タスク1件のコメントを、書いた順（created_at の昇順、同じなら id の昇順）に返す。初めは新しい 50 件で、
// それより前があれば next（次に before へ渡す値。返した中で最も古いコメントの位置）を返す。
// 消したコメントも、本文を空にして返し、件数（50 件）にも数える。count は消していないコメントの数。
// 時刻は画面がワークスペースのタイムゾーン（timezone）で出す。閉じたワークスペースでも読める
export const commentList = defineOperation({
  name: 'comment-list',
  description:
    'タスク1件のコメントを書いた順に返す。初めは新しい 50 件で、前のコメントは before で続きを読む。消したコメントは本文を空にして返す',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, task_id: idSchema, before: cursorSchema.optional() }),
  output: z.object({
    comments: z.array(commentSchema),
    next: cursorSchema.nullable(),
    count: z.number().int(),
    timezone: z.string(),
  }),
});

// コメントを書く。本文はタスクの本文と同じ整え方（改行をそろえ、前後の空行と末尾の空白を落とす）で、空か空白だけなら 400。
// 10 万字まで。変更の履歴は書かない（comments の行そのものが記録）。返すのは書いた行
export const commentCreate = defineOperation({
  name: 'comment-create',
  description: 'タスクにコメントを書く。本文は Markdown で 10 万字まで',
  mode: 'write',
  permission: 'member',
  workspace: true,
  // 10 万字の本文を何件でも足せ、全組織で共有する D1 を埋められるので、回数で抑える（完成の定義の変更と同じ値）
  rateLimit: { max: 30, windowSeconds: 600 },
  input: z.object({ workspace_id: idSchema, task_id: idSchema, body_md: commentBodySchema }),
  output: z.object({ comment: commentSchema }),
});

// 自分のコメントを直す。直せるのは書いた本人だけで、それ以外は 403 の forbidden。版の番号は持たず、後から保存したほうを生かす。
// 前の本文は残さず、edited_at と、変更の履歴（誰がいつ直したか。本文は入れない）だけを書く。整えた本文が今と同じなら何も書かない。
// 消えたコメントは 409 の conflict（details.reason は deleted）
export const commentUpdate = defineOperation({
  name: 'comment-update',
  description: '自分のコメントの本文を直す。直したコメントには「編集済み」が付く。書いた本人だけが直せる',
  mode: 'write',
  permission: 'member',
  workspace: true,
  // 作成と同じく、10 万字の本文と変更の履歴を書くので、回数で抑える
  rateLimit: { max: 30, windowSeconds: 600 },
  input: z.object({ workspace_id: idSchema, comment_id: idSchema, body_md: commentBodySchema }),
  output: z.object({ comment: commentSchema }),
});

// コメントを消す。消せるのは書いた本人とリーダー（管理者を含む）で、それ以外は 403 の forbidden。
// 論理削除で、本文を空にし、消した日時と消した人を書く（中身はどこにも残らない）。変更の履歴（本文は入れない）も同時に書く。
// 消えたコメントは 409 の conflict（details.reason は deleted）。返すのは消した後の行
export const commentDelete = defineOperation({
  name: 'comment-delete',
  description:
    'コメントを消す。書いた本人とリーダー（管理者を含む）だけが消せる。消したコメントは「削除されました」と残る',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema, comment_id: idSchema }),
  output: z.object({ comment: commentSchema }),
});

export type Comment = z.output<typeof commentSchema>;
export type CommentCursor = z.output<typeof cursorSchema>;
