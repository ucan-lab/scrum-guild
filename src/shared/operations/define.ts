// 操作の定義の型と、定義から決まる URL（docs/development.md の「操作の定義」）。
// 画面からの呼び出し（src/lib/api.ts）と、Hono への登録（src/server/operations/）が同じ定義を読む。
// 処理は定義に持たせない。画面の束に Worker のコードを入れないため
import type { z } from 'zod';

// 要る権限。組織の外の操作は login と operator、組織の中の操作はそれ以外
export const permissions = ['login', 'operator', 'organization', 'member', 'leader', 'admin'] as const;
export type Permission = (typeof permissions)[number];

// URL の最後の1区分になるので、英小文字と数字をハイフンでつないだ1語に限る
export const OPERATION_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

type Common<Input, Output> = {
  readonly name: string;
  // 後で足す Claude の道具と MCP の道具の説明にも使う
  readonly description: string;
  readonly mode: 'read' | 'write';
  readonly input: Input;
  readonly output: Output;
};

// ワークスペースの下の操作は、入力に workspace_id を持つ。無いと型で落ちる
type WorkspaceInput = z.ZodType<{ workspace_id: string }>;

export type OperationDefinition<Input extends z.ZodType = z.ZodType, Output extends z.ZodType = z.ZodType> =
  // 組織の外: /api/<name>
  | (Common<Input, Output> & { readonly permission: 'login' | 'operator'; readonly workspace?: false })
  // 組織の中: /api/<slug>/<name>
  | (Common<Input, Output> & { readonly permission: 'organization' | 'admin'; readonly workspace?: false })
  // 組織の中のワークスペースの下。管理者は所属していないワークスペースでもリーダーと同じ操作ができる
  | (Common<Input & WorkspaceInput, Output> & {
      readonly permission: 'member' | 'leader' | 'admin';
      readonly workspace: true;
    });

export type AnyOperationDefinition = OperationDefinition;

export type OutsideOperationDefinition = Extract<AnyOperationDefinition, { permission: 'login' | 'operator' }>;
export type WorkspaceOperationDefinition = Extract<AnyOperationDefinition, { workspace: true }>;

// 入力は画面が渡す形（既定値を埋める前）、出力は画面が受け取る形
export type InputOf<D extends AnyOperationDefinition> = z.input<D['input']>;
export type OutputOf<D extends AnyOperationDefinition> = z.output<D['output']>;

export function defineOperation<const D extends AnyOperationDefinition>(definition: D): D {
  if (!OPERATION_NAME_PATTERN.test(definition.name)) {
    throw new Error(`操作の名前は英小文字と数字をハイフンでつないだ1語にする（${definition.name}）`);
  }
  return definition;
}

export function isOutsideOperation(definition: AnyOperationDefinition): definition is OutsideOperationDefinition {
  return definition.permission === 'login' || definition.permission === 'operator';
}

export function isWorkspaceOperation(definition: AnyOperationDefinition): definition is WorkspaceOperationDefinition {
  return definition.workspace === true;
}

// 組織の中の操作だけ slug を取る。URL の形はここに1つだけ持つ
export function operationPath(definition: AnyOperationDefinition, slug?: string): string {
  if (isOutsideOperation(definition)) return `/api/${definition.name}`;
  if (slug === undefined) throw new Error(`組織の中の操作 ${definition.name} には slug が要る`);
  return `/api/${encodeURIComponent(slug)}/${definition.name}`;
}
