// 操作の定義の型と、定義から決まる URL（docs/development.md の「操作の定義」）。
// 画面からの呼び出し（src/lib/api.ts）と、Hono への登録（src/server/operations/）が同じ定義を読む。
// 処理は定義に持たせない。画面の束に Worker のコードを入れないため
import type { z } from 'zod';
// 定義が zod のスキーマを作る前に、設定を済ませる（定義はこのファイルを import する）
import '../zod-config.ts';

// 要る権限と、その範囲。権限の一覧も型も、実行時の検査もこの表から導く。
//   outside: 組織の外（/api/<name>）
//   organization: 組織の中（/api/<slug>/<name>）。admin だけは workspace: true を付けてワークスペースの下に置ける
//   workspace: ワークスペースの下。workspace: true が必須で、入力に workspace_id を持つ
const permissionScopes = {
  login: 'outside',
  operator: 'outside',
  // 組織に入れる人すべて。承諾待ちの招待だけの人を含む（招待の一覧、承諾、辞退に使う）
  invitee: 'organization',
  // users の行がある人（無効でない管理者か、いずれかのワークスペースに今所属している人）
  organization: 'organization',
  admin: 'organization',
  member: 'workspace',
  leader: 'workspace',
} as const;

type PermissionScopes = typeof permissionScopes;
export type Permission = keyof PermissionScopes;
type PermissionsIn<Scope extends string> = {
  [P in Permission]: PermissionScopes[P] extends Scope ? P : never;
}[Permission];

export const permissions = Object.keys(permissionScopes) as Permission[];

// URL の最後の1区分になるので、英小文字と数字をハイフンでつないだ1語に限る
const OPERATION_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

// 操作の回数の上限。アカウントごと、操作ごとに数え、窓の中で max を超えた呼び出しは 429 の rate_limited で断る。
// アプリ側のレート制限を設けるのは、ログインと手動の同期だけ（docs/requirements.md の「運用」）。ログインは GET の
// 直書きの例外（src/server/auth/login-routes.ts）で IP ごとに数え、定義に付けるのは同期のような重い操作
export type RateLimit = { readonly max: number; readonly windowSeconds: number };

type Common<Input, Output> = {
  readonly name: string;
  // 後で足す Claude の道具と MCP の道具の説明にも使う
  readonly description: string;
  readonly mode: 'read' | 'write';
  readonly input: Input;
  readonly output: Output;
  readonly rateLimit?: RateLimit;
  // 組織の外の操作は、既定で、呼ぶたびに「入れる組織がある（か運用者）」ことを確かめ、失っていればセッションを消して 401 にする
  // （判定は DB を3〜4回引く。運用者は確かめずに通す）。確かめない操作だけに true を付ける（ログアウトなど、
  // 入れる組織を失った人にも使わせる操作）。組織の中の操作には付けられない（組織に入れなかったときに、登録の関数が確かめる）
  readonly skipsLoginAccess?: true;
};

// ワークスペースの下の操作は、入力に workspace_id を持つ。無いと型で落ちる
type WorkspaceInput = z.ZodType<{ workspace_id: string }>;

export type OperationDefinition<Input extends z.ZodType = z.ZodType, Output extends z.ZodType = z.ZodType> =
  // 組織の外: /api/<name>
  | (Common<Input, Output> & { readonly permission: PermissionsIn<'outside'>; readonly workspace?: false })
  // 組織の中: /api/<slug>/<name>
  | (Common<Input, Output> & { readonly permission: PermissionsIn<'organization'>; readonly workspace?: false })
  // 組織の中のワークスペースの下。管理者は所属していないワークスペースでもリーダーと同じ操作ができる
  | (Common<Input & WorkspaceInput, Output> & {
      readonly permission: PermissionsIn<'workspace'> | 'admin';
      readonly workspace: true;
      // 閉じたワークスペースでも通す書き込み（開き直す操作）。無印の write は、閉じていれば 409 の workspace_closed になる
      readonly allowClosed?: true;
    });

export type AnyOperationDefinition = OperationDefinition;

export type OutsideOperationDefinition = Extract<AnyOperationDefinition, { permission: PermissionsIn<'outside'> }>;
export type WorkspaceOperationDefinition = Extract<AnyOperationDefinition, { workspace: true }>;

// 入力は画面が渡す形（既定値を埋める前）、出力は画面が受け取る形（スキーマの変換を通した後）
export type InputOf<D extends AnyOperationDefinition> = z.input<D['input']>;
export type OutputOf<D extends AnyOperationDefinition> = z.output<D['output']>;

// 型の検査を抜けた定義（型を消した一覧、手で組んだオブジェクト）を実行時に止める。defineOperation と登録の関数が呼ぶ
export function assertOperationDefinition(definition: AnyOperationDefinition): void {
  const { name, permission } = definition;
  if (!OPERATION_NAME_PATTERN.test(name)) {
    throw new Error(`操作の名前は英小文字と数字をハイフンでつないだ1語にする（${name}）`);
  }
  const scope: string | undefined = (permissionScopes as Record<string, string>)[permission];
  if (scope === undefined) throw new Error(`操作 ${name} の権限 ${String(permission)} は権限の一覧に無い`);
  const workspace = (definition as { workspace?: unknown }).workspace;
  if (workspace !== undefined && workspace !== true && workspace !== false) {
    throw new Error(`操作 ${name} の workspace は true か省略`);
  }
  if (scope === 'workspace' && workspace !== true) {
    throw new Error(`操作 ${name} は権限 ${permission} なので workspace: true が要る`);
  }
  if (workspace === true && scope === 'outside') {
    throw new Error(`組織の外の操作 ${name} は workspace: true にできない`);
  }
  if (workspace === true && scope === 'organization' && permission !== 'admin') {
    throw new Error(`操作 ${name} は権限 ${permission} なので workspace: true にできない`);
  }
  if (definition.skipsLoginAccess !== undefined && (definition.skipsLoginAccess !== true || scope !== 'outside')) {
    throw new Error(`操作 ${name} の skipsLoginAccess は、組織の外の操作に true だけ付けられる`);
  }
  const rateLimit = definition.rateLimit;
  if (rateLimit !== undefined && !(Number.isInteger(rateLimit.max) && rateLimit.max > 0)) {
    throw new Error(`操作 ${name} の rateLimit.max は 1 以上の整数`);
  }
  if (rateLimit !== undefined && !(Number.isInteger(rateLimit.windowSeconds) && rateLimit.windowSeconds > 0)) {
    throw new Error(`操作 ${name} の rateLimit.windowSeconds は 1 以上の整数`);
  }
  if ((definition as { allowClosed?: unknown }).allowClosed !== undefined) {
    if (workspace !== true || definition.mode !== 'write') {
      throw new Error(`操作 ${name} の allowClosed は、ワークスペースの下の write だけに付けられる`);
    }
  }
}

export function defineOperation<const D extends AnyOperationDefinition>(definition: D): D {
  assertOperationDefinition(definition);
  return definition;
}

export function isOutsideOperation(definition: AnyOperationDefinition): definition is OutsideOperationDefinition {
  return permissionScopes[definition.permission] === 'outside';
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
