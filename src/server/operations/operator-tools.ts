// 運用者の操作の処理に渡す道具。env を処理に渡さず、決まった呼び出しだけを渡す（account.ts と同じ作り）。
// 登録の関数が、運用者の権限を確かめた操作にだけ渡す。組織の中の表を、組織で絞らずに読み書きする入口は渡さない。
// 組織で絞らずに書くのは linkLogin だけ。組織の作成で、アカウントが無いと読んだ後に、その人が初めてログインを終えた場合に、
// 書いた後の結び直しで呼ぶ（ログインのたびの結び直しと同じ文で、account_id が空でログインの手段と ID が同じ行だけに当たる）
import type { LoginMethod } from '../auth/login-method.ts';
import {
  adminStatusesOf,
  insertOrganization,
  linkLoginToAccount,
  type CreatedOrganization,
  type LoginId,
  type NewOrganization,
} from '../db/index.ts';
import type { AdminStatus } from '../../shared/operations/operator/list-organizations.ts';

export type OperatorTools = {
  // この運用者のログインの ID（`github:12345` の形）。organizations.created_by_operator と change_logs.operator に残す
  readonly loginId: string;
  // このリクエストの ID。失敗のログに添える（エラーのログと操作のログで揃える）
  readonly requestId: string;
  // 手段のログインの実装。資格情報が未設定の手段と、知らない手段は undefined
  loginMethod(provider: string): LoginMethod | undefined;
  // 組織ごとの管理者の状態。人の名前や ID は返さない
  adminStatuses(organizationIds: readonly string[]): Promise<Map<string, AdminStatus>>;
  // organizations に書き、続けて最初の管理者を書く組織の入口を返す。slug が重なれば 'slug_taken'
  insertOrganization(input: Omit<NewOrganization, 'createdByOperator'>): Promise<CreatedOrganization | 'slug_taken'>;
  // 指名で待っている users の行（account_id が空で、ログインの手段と ID が同じ）にアカウントを結ぶ。何度流しても同じ結果
  linkLogin(accountId: string, login: LoginId, now: Date): Promise<void>;
};

export function operatorTools(
  env: Env,
  context: { loginId: string; requestId: string },
  loginMethod: (provider: string) => LoginMethod | undefined,
): OperatorTools {
  return {
    loginId: context.loginId,
    requestId: context.requestId,
    loginMethod,
    adminStatuses: (organizationIds) => adminStatusesOf(env, organizationIds),
    insertOrganization: (input) => insertOrganization(env, { ...input, createdByOperator: context.loginId }),
    linkLogin: (accountId, login, now) => linkLoginToAccount(env, accountId, login, now),
  };
}
