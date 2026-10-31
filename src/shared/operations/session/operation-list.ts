// 呼べる操作の一覧。CLI（cli/）が取得してコマンドを作る。CLI は定義を import しないので、定義を足しても CLI を作り直さずに使える
import { z } from 'zod';
import { defineOperation, permissions, type Permission } from '../define.ts';

const jsonSchema = z.record(z.string(), z.unknown());

export const operationList = defineOperation({
  name: 'operation-list',
  description:
    '呼べる操作の一覧を名前順に返す。名前、説明、mode、範囲（outside、organization、workspace）、要る権限、入力と出力の JSON Schema を含む。API トークンで呼べない操作（運用者の操作、cookieOnly、読み取りのトークンなら write）は含めない。役割では絞らず、足りなければ呼んだときに 403',
  mode: 'read',
  permission: 'login',
  input: z.object({}),
  output: z.object({
    operations: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        mode: z.enum(['read', 'write']),
        scope: z.enum(['outside', 'organization', 'workspace']),
        permission: z.enum(permissions as [Permission, ...Permission[]]),
        input_schema: jsonSchema,
        output_schema: jsonSchema,
      }),
    ),
  }),
});
