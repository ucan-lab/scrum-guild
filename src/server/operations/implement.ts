// 操作の定義に処理を結ぶ。処理が受け取るのは、検証済みの入力と、確かめた DB の入口と、確かめた人（とワークスペース）だけ。
// 組織の中の処理の入口（OrganizationDb）は組織を確かめないと作れず、ワークスペースの下の処理は確かめたワークスペースを受け取る。
// 組織の中の表の文は、入口の organizationId か、確かめたワークスペースの workspaceId で処理が自分で絞る
import type { z } from 'zod';
import type {
  AnyOperationDefinition,
  OutsideOperationDefinition,
  WorkspaceOperationDefinition,
} from '../../shared/operations/define.ts';
import type {
  CommonDb,
  OrganizationActor,
  OrganizationDb,
  OrganizationSummary,
  VerifiedWorkspace,
} from '../db/index.ts';
import type { OutsideAccount } from './account.ts';

// 応答を待たせずに続ける仕事。応答の後も終わるまで Worker が残る（waitUntil）。失敗は登録の関数が例外の名前だけをログに残す。
// 読む操作が副作用として書くものに使う（書き込みは db.batch で送る）
export type Defer = (task: () => Promise<unknown>) => void;

export type OutsideContext<Input> = { db: CommonDb; accountId: string; account: OutsideAccount; input: Input };
// organization は入るときに引いた組織の行（名前、言葉づかい、既定のテーマ）。組織の中の処理は共通の入口を持たない
export type OrganizationContext<Input> = {
  db: OrganizationDb;
  actor: OrganizationActor;
  organization: OrganizationSummary;
  defer: Defer;
  input: Input;
};
export type WorkspaceContext<Input> = OrganizationContext<Input> & { workspace: VerifiedWorkspace };

export type ContextOf<D extends AnyOperationDefinition> = D extends OutsideOperationDefinition
  ? OutsideContext<z.output<D['input']>>
  : D extends WorkspaceOperationDefinition
    ? WorkspaceContext<z.output<D['input']>>
    : OrganizationContext<z.output<D['input']>>;

// 処理の戻り値は出力のスキーマで検証し、スキーマに無い項目は落とす（行をそのまま返しても余計な列が出ない）
export type HandlerOf<D extends AnyOperationDefinition> = (context: ContextOf<D>) => Promise<z.input<D['output']>>;

// 定義と処理の組。型の引数は implement() で消し、登録の関数は一覧として受け取る
export type ImplementedOperation = {
  readonly definition: AnyOperationDefinition;
  readonly handler: (context: never) => Promise<unknown>;
};

export function implement<const D extends AnyOperationDefinition>(
  definition: D,
  handler: HandlerOf<D>,
): ImplementedOperation {
  return { definition, handler };
}
