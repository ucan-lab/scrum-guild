import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { longTextProblem, normalizeLongText } from '../../story.ts';
import { defineOperation } from '../define.ts';

// 完成の定義（workspaces.definition_of_done_md）の字数の上限。列の CHECK と同じ 10 万字（コードポイントで数える）
export const DEFINITION_OF_DONE_MAX_LENGTH = 100_000;

// 完成の定義の問題。画面の検査と API の検証が同じ判定を使う。value は normalizeLongText を通した後の値
export function definitionOfDoneProblem(value: string): 'too_long' | 'invalid_character' | null {
  return longTextProblem(value, DEFINITION_OF_DONE_MAX_LENGTH);
}

// 本文（body_md）と同じ整え方（改行をそろえ、前後の空行と末尾の空白を落とす）。空白だけなら null（空）にそろえる
const definitionOfDoneSchema = z.string().transform((raw, ctx) => {
  const value = normalizeLongText(raw);
  const problem = value === null ? null : definitionOfDoneProblem(value);
  if (problem !== null) {
    ctx.addIssue({ code: 'custom', message: `完成の定義が使えない（${problem}）` });
    return z.NEVER;
  }
  return value;
});

// ワークスペースの完成の定義（Markdown）を書く。リーダー（管理者を含む）だけ。空白だけの値は空（null）にする。
// 今の値と同じなら何も書かない。変えたときは、変更の履歴（entity_type = 'workspace'、update、
// {"definition_of_done_md": [前, 後]}）を同じ batch() で書く。閉じたワークスペースは 409 の workspace_closed
export const workspaceDodUpdate = defineOperation({
  name: 'workspace-dod-update',
  description: 'ワークスペースの完成の定義（Markdown）を書く。空白だけなら空にする。変えたら変更の履歴に残す',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z.object({ workspace_id: idSchema, definition_of_done_md: definitionOfDoneSchema }),
  output: z.object({ definition_of_done_md: z.string().nullable() }),
});
