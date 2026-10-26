import { z } from 'zod';
import { definitionNameSchema } from '../../definition.ts';
import { idSchema } from '../../id.ts';
import { defineOperation } from '../define.ts';
import { repositorySchema } from './definition.ts';

// リポジトリの定義の操作。決まりは区分（category.ts）と同じで、欄は名前だけ。
// 取り込み元の入る先との結び付け（provider、source_container_id）は #67 で足す

export const repositoryCreate = defineOperation({
  name: 'repository-create',
  description: 'リポジトリを足す。位置は末尾',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z.object({ workspace_id: idSchema, name: definitionNameSchema }),
  output: z.object({ repository: repositorySchema }),
});

export const repositoryUpdate = defineOperation({
  name: 'repository-update',
  description: 'リポジトリの名前を変える',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z.object({ workspace_id: idSchema, repository_id: idSchema, name: definitionNameSchema.optional() }),
  output: z.object({ repository: repositorySchema }),
});

export const repositoryMove = defineOperation({
  name: 'repository-move',
  description: 'リポジトリを並べ替える。指したリポジトリの直後（null は先頭、省くと末尾）に置く',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z.object({
    workspace_id: idSchema,
    repository_id: idSchema,
    after_repository_id: idSchema.nullable().optional(),
  }),
  output: z.object({ repository_id: z.string() }),
});

// 振っていたタスクは、同じ batch() でリポジトリなしに戻し、それぞれの変更の履歴に {"repository": [{id, name}, null]} を残す
export const repositoryDelete = defineOperation({
  name: 'repository-delete',
  description: 'リポジトリを削除し、振っていたタスクをリポジトリなしに戻す',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z.object({ workspace_id: idSchema, repository_id: idSchema }),
  output: z.object({ repository_id: z.string() }),
});
