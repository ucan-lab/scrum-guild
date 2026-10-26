import { z } from 'zod';
import { definitionNameSchema } from '../../definition.ts';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import { categorySchema, repositorySchema } from './definition.ts';

// ワークスペースの区分とリポジトリの一覧（どちらも position の順）。起票のダイアログ、エピックとストーリーのダイアログ、詳細の引き出し、
// 設定の画面が使う。削除したものは返さない。閉じたワークスペースでも読める
export const categoryRepositoryList = defineOperation({
  name: 'category-repository-list',
  description: 'ワークスペースの区分（月ごとに計上するか付き）とリポジトリの一覧を、並びの順に返す',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema }),
  output: z.object({ categories: z.array(categorySchema), repositories: z.array(repositorySchema) }),
});

// 区分を足す。位置は末尾。名前は前後の空白を除いて 1〜50 字で、同じワークスペースの削除していない区分と同じ名前は
// 409 の conflict（duplicate_name）。削除していない区分が 50 件あれば 409 の conflict（limit）。どちらも書く文の条件で守る。
// 変更の履歴（entity_type = 'category'、create）も同じ batch() で書く
export const categoryCreate = defineOperation({
  name: 'category-create',
  description: '区分を足す。名前と、月ごとに計上するかを指す。位置は末尾',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    name: definitionNameSchema,
    is_billed_monthly: z.boolean().default(false),
  }),
  output: z.object({ category: categorySchema }),
});

// 区分の名前と、月ごとに計上するかを変える。送った欄のうち今の値と違うものだけを、読んだ値のままなら、という条件つきで書く。
// 同じ名前の区分があれば 409 の conflict（duplicate_name）。月ごとに計上するかを切り替えても、すでにある完了の記録の計上月は変えない。
// 無い区分（別の組織・別のワークスペース・削除済みを含む）は 404
export const categoryUpdate = defineOperation({
  name: 'category-update',
  description: '区分の名前と、月ごとに計上するかのうち、送った欄だけを変える。すでにある完了の記録の計上月は変えない',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    category_id: idSchema,
    name: definitionNameSchema.optional(),
    is_billed_monthly: z.boolean().optional(),
  }),
  output: z.object({ category: categorySchema }),
});

// 区分を並べ替える。after_category_id は直前に置く区分で、null は先頭、省くと末尾。
// 直前の区分が無い（削除済み、別のワークスペースを含む）ときは 404、動かす区分自身なら 400 の invalid_input。
// 409 の conflict の理由は task-move.ts の moveConflictReasons（changed、ties）。並べ替えは変更の履歴に残さない
export const categoryMove = defineOperation({
  name: 'category-move',
  description: '区分を並べ替える。指した区分の直後（null は先頭、省くと末尾）に置く',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    category_id: idSchema,
    after_category_id: idSchema.nullable().optional(),
  }),
  output: z.object({ category_id: z.string() }),
});

// 区分を削除する（論理削除）。振っていたエピック、ストーリー、タスクは、同じ batch() で区分なしに戻し、それぞれの変更の履歴に
// {"category": [{id, name}, null]} を残す。完了の記録（completions の category_id と billing_month）は変えない。
// 無い区分（別の組織・別のワークスペース・削除済みを含む）は 404
export const categoryDelete = defineOperation({
  name: 'category-delete',
  description: '区分を削除し、振っていたエピック、ストーリー、タスクを区分なしに戻す。完了の記録は元の区分のまま残す',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z.object({ workspace_id: idSchema, category_id: idSchema }),
  output: z.object({ category_id: z.string() }),
});
