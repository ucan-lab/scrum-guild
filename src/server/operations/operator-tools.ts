// 運用者の操作の処理に渡す道具。env を処理に渡さず、決まった呼び出しだけを渡す（account.ts と同じ作り）。
// 登録の関数が、運用者の権限を確かめた操作にだけ渡す。組織の中の表を、組織で絞らずに読み書きする入口は渡さない。
// 組織で絞らずに書くのは linkLogin だけ。組織の作成で、アカウントが無いと読んだ後に、その人が初めてログインを終えた場合に、
// 書いた後の結び直しで呼ぶ（ログインのたびの結び直しと同じ文で、account_id が空でログインの手段と ID が同じ行だけに当たる）。
// 既にある組織の中の表に書くのは、変更の履歴を1行足す appendChangeLog だけ（組織の中の入口は渡さない）。
// 足す関数（appendOperatorChangeLog）を import できるのはこのファイルだけで、ESLint が守る（eslint.config.db-entry.js）
import { INVITE_PATH } from '../../shared/claim-token.ts';
import type { InviteeResolver } from '../auth/login-method.ts';
import {
  adminStatusesOf,
  appendOperatorChangeLog,
  insertOrganization,
  linkLoginToAccount,
  organizationUsageOf,
  reassignOrganizationAdmin,
  type AdminReassignmentResult,
  type OrganizationUsage,
  type CreatedOrganization,
  type LoginId,
  type NewOrganization,
  type OperatorChangeLog,
} from '../db/index.ts';
import type { AdminStatus } from '../../shared/operations/operator/list-organizations.ts';
import type { AdminNominee } from '../organizations/designate-admin.ts';

export type OperatorTools = {
  // この運用者のログインの ID（`github:12345` の形）。organizations.created_by_operator と change_logs.operator に残す
  readonly loginId: string;
  // このリクエストの ID。失敗のログに添える（エラーのログと操作のログで揃える）
  readonly requestId: string;
  // 招待する人の解決器。持つ手段（GitHub）だけ。資格情報が未設定の手段と、解決器を持たない手段は undefined
  inviteeResolver(provider: string): InviteeResolver | undefined;
  // 招待の URL（<公開 URL のオリジン>/invite#<秘密>）。秘密は応答の本文にだけ入れる
  inviteUrl(claimToken: string): string;
  // 組織ごとの管理者の状態。人の名前や ID は返さない。期限の過ぎた待つ行は expired に数える
  adminStatuses(organizationIds: readonly string[], now: Date): Promise<Map<string, AdminStatus>>;
  // 組織ごとの集計（人数、閉じていないワークスペースの数、削除していないタスクの数、最後に使われた日時）。人の名前や ID は返さない
  organizationUsage(organizationIds: readonly string[], now: Date): Promise<Map<string, OrganizationUsage>>;
  // organizations に書き、続けて最初の管理者を書く組織の入口を返す。slug が重なれば 'slug_taken'
  insertOrganization(input: Omit<NewOrganization, 'createdByOperator'>): Promise<CreatedOrganization | 'slug_taken'>;
  // 指名で待っている users の行（account_id が空で、ログインの手段と ID が同じ）にアカウントを結ぶ。何度流しても同じ結果
  linkLogin(accountId: string, login: LoginId, now: Date): Promise<void>;
  // 既にある組織の変更の履歴に、運用者の操作を1行足す。operator はこの運用者のログインの ID が入る。停止中の組織にも足せる。
  // 組織の ID は共通の表の organizations から読んだ値を渡す（行が無い ID は外部キーが断る）
  appendChangeLog(organizationId: string, entry: Omit<OperatorChangeLog, 'operator'>): Promise<void>;
  // 既にある組織に管理者を指名し直す（前の指名を消し、続けて指名する）。change_logs.operator にはこの運用者のログインの ID が入る。
  // 組織の ID は共通の表の organizations から読んだ値を渡す
  reassignAdmin(
    organizationId: string,
    input: { nominee: AdminNominee; now: Date },
  ): Promise<AdminReassignmentResult | 'conflict'>;
};

export function operatorTools(
  env: Env,
  context: { loginId: string; requestId: string },
  inviteeResolver: (provider: string) => InviteeResolver | undefined,
): OperatorTools {
  return {
    loginId: context.loginId,
    requestId: context.requestId,
    inviteeResolver,
    inviteUrl: (claimToken) => `${new URL(env.PUBLIC_ORIGIN).origin}${INVITE_PATH}#${claimToken}`,
    adminStatuses: (organizationIds, now) => adminStatusesOf(env, organizationIds, now),
    organizationUsage: (organizationIds, now) => organizationUsageOf(env, organizationIds, now),
    insertOrganization: (input) => insertOrganization(env, { ...input, createdByOperator: context.loginId }),
    linkLogin: (accountId, login, now) => linkLoginToAccount(env, accountId, login, now),
    appendChangeLog: (organizationId, entry) =>
      appendOperatorChangeLog(env, organizationId, { ...entry, operator: context.loginId }),
    reassignAdmin: (organizationId, input) =>
      reassignOrganizationAdmin(env, organizationId, { ...input, operator: context.loginId }),
  };
}
