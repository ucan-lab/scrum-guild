import { z } from 'zod';
import { definitionNameSchema } from '../../definition.ts';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import { detailFieldSchema } from './definition.ts';

// タスクの決まった欄（detail_fields）の定義の操作。決まりは区分（category.ts）と同じで、欄は名前だけ。
// 名前は前後の空白を除いて 1〜50 字。同じワークスペースの削除していない欄と同じ名前は 409 の conflict（duplicate_name）、
// 削除していない欄が 10 件あれば足すのは 409 の conflict（limit）。どちらも書く文の条件で守る。
// 変更の履歴は entity_type = 'detail_field'（作成は create、名前の変更は update、削除は delete）。並べ替えは残さない。
// 無い欄（別の組織・別のワークスペース・削除済みを含む）は 404。閉じたワークスペースへの書き込みは 409 の workspace_closed

// 欄の一覧（position の順）。引き出しと設定の画面が使う。削除した欄は返さない。閉じたワークスペースでも読める
export const detailFieldList = defineOperation({
  name: 'detail-field-list',
  description: 'ワークスペースの決まった欄を、並びの順に返す。削除した欄は返さない',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: idSchema }),
  output: z.object({ fields: z.array(detailFieldSchema) }),
});

export const detailFieldCreate = defineOperation({
  name: 'detail-field-create',
  description: '決まった欄を足す。位置は末尾。削除していない欄は 10 件まで',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z.object({ workspace_id: idSchema, name: definitionNameSchema }),
  output: z.object({ field: detailFieldSchema }),
});

// 名前を変える。値の行は欄の ID に結ぶので、名前を変えても値は残る
export const detailFieldUpdate = defineOperation({
  name: 'detail-field-update',
  description: '決まった欄の名前を変える。値は残る',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z.object({ workspace_id: idSchema, field_id: idSchema, name: definitionNameSchema.optional() }),
  output: z.object({ field: detailFieldSchema }),
});

// after_field_id は直前に置く欄で、null は先頭、省くと末尾。直前の欄が無い（削除済み、別のワークスペースを含む）ときは 404、
// 動かす欄自身なら 400 の invalid_input。409 の conflict の理由は task-move.ts の moveConflictReasons（changed、ties）
export const detailFieldMove = defineOperation({
  name: 'detail-field-move',
  description: '決まった欄を並べ替える。指した欄の直後（null は先頭、省くと末尾）に置く',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    field_id: idSchema,
    after_field_id: idSchema.nullable().optional(),
  }),
  output: z.object({ field_id: z.string() }),
});

// 論理削除。値の行は残す（削除した欄の値は出さず、未記入の判定からも外れる）。復活はしない
export const detailFieldDelete = defineOperation({
  name: 'detail-field-delete',
  description: '決まった欄を削除する（論理削除）。値の行は残し、削除した欄は未記入の判定から外れる',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z.object({ workspace_id: idSchema, field_id: idSchema }),
  output: z.object({ field_id: z.string() }),
});
