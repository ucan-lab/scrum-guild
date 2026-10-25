// 操作の定義に処理を結ぶ。処理が受け取るのは、検証済みの入力と、確かめた DB の入口と、確かめた人（とワークスペース）と、
// 権限ごとの道具（運用者の道具、組織の道具）だけ。
// 組織の中の処理の入口（OrganizationDb）は組織を確かめないと作れず、ワークスペースの下の処理は確かめたワークスペースを受け取る。
// 組織の中の処理が共通の表とログインの手段に触れるのは、確かめた組織に結んだ組織の道具（organization-tools.ts）を通してだけ。
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
import type { OperatorTools } from './operator-tools.ts';
import type { OrganizationTools } from './organization-tools.ts';

// 応答を待たせずに続ける仕事。応答の後も終わるまで Worker が残る（waitUntil）。失敗は登録の関数が例外の名前だけをログに残す。
// 読む操作が副作用として書くものに使う（書き込みは db.batch で送る）
export type Defer = (task: () => Promise<unknown>) => void;

// 今のリクエストのセッション。ログアウトが今のセッションの行を指し、Cookie も消すのに使う
export type CurrentSession = {
  // sessions.token_hash
  readonly tokenHash: string;
  // 応答でセッションの Cookie を消す。行を消した後に呼ぶ
  clearCookie(): void;
};

export type OutsideContext<Input> = {
  db: CommonDb;
  accountId: string;
  account: OutsideAccount;
  session: CurrentSession;
  input: Input;
};
// 運用者の操作（permission: 'operator'）。登録の関数が運用者を確かめた後に、運用者の道具を渡す
export type OperatorContext<Input> = OutsideContext<Input> & { operator: OperatorTools };
// organization は入るときに引いた組織の行（名前、言葉づかい、既定のテーマ）。組織の中の処理は共通の入口を持たず、
// 共通の表とログインの手段には、入った組織に結んだ道具 tools から触れる
export type OrganizationContext<Input> = {
  db: OrganizationDb;
  actor: OrganizationActor;
  organization: OrganizationSummary;
  tools: OrganizationTools;
  defer: Defer;
  input: Input;
};
export type WorkspaceContext<Input> = OrganizationContext<Input> & { workspace: VerifiedWorkspace };

export type ContextOf<D extends AnyOperationDefinition> = D extends OutsideOperationDefinition
  ? D['permission'] extends 'operator'
    ? OperatorContext<z.output<D['input']>>
    : OutsideContext<z.output<D['input']>>
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
