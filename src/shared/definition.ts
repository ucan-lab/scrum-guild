// ワークスペースの定義のうち、区分（categories）とリポジトリ（repositories）の共通の値。作る操作・変える操作と、設定の画面が同じ決まりを使う。
// 画面の束にも入るので、Worker のコードを引かない
import { z } from 'zod';
import './zod-config.ts';
import { WORKSPACE_NAME_MAX_LENGTH, workspaceNameProblem, type WorkspaceNameProblem } from './workspace.ts';

// 名前は workspaces.name と同じ決まり（前後の空白を除いて 1〜50 字。コードポイントで数え、見えない文字は断る）
export const DEFINITION_NAME_MAX_LENGTH = WORKSPACE_NAME_MAX_LENGTH;

export type DefinitionNameProblem = WorkspaceNameProblem;

// 画面の検査と API の検証が同じ判定を使う。name は前後の空白を除いた後の値
export function definitionNameProblem(name: string): DefinitionNameProblem | null {
  return workspaceNameProblem(name);
}

export const definitionNameSchema = z
  .string()
  .trim()
  .superRefine((name, ctx) => {
    const problem = definitionNameProblem(name);
    if (problem !== null) ctx.addIssue({ code: 'custom', message: `名前が使えない（${problem}）` });
  });

// 1つのワークスペースに置ける、削除していない区分とリポジトリの数（それぞれ）
export const DEFINITIONS_PER_WORKSPACE = 50;

// 1つのワークスペースに置ける、削除していない決まった欄（detail_fields）の数。タスクの引き出しに並ぶので、区分より少なくする
export const DETAIL_FIELDS_PER_WORKSPACE = 10;

// 決まった欄の値（task_field_values.value_md）の上限は、ストーリーの本文と同じ（STORY_TEXT_MAX_LENGTH。コードポイントで数える）
