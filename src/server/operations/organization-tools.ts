// 組織の中の操作の処理に渡す道具。運用者の道具（operator-tools.ts）と同じく、env を処理に渡さず、決まった呼び出しだけを渡す。
// 組織の中の処理は共通の入口を持たないので、共通の表（組織の行、アカウントのログイン、セッション）と、ログインの手段に触れるのはここだけ。
// 登録の関数が、組織に入れると確かめた後に、その組織の入口（OrganizationDb）に結んで作る。どの道具も組織の ID を引数に取らず、
// 組織の行は確かめた組織の ID で、組織の中の表は organization_id で絞る。共通の表と組織の中の表は別の問い合わせで引き、1回の batch() に混ぜない
import { accountLogins } from '../auth/account-logins.ts';
import type { InviteeResolver } from '../auth/login-method.ts';
import { isOperatorLogin } from '../auth/operators.ts';
import { deleteSessionsOf } from '../auth/session.ts';
import {
  commonDb,
  listAccountOrganizations,
  readOrganizationRow,
  userAvatarsOf,
  writeOrganizationSettings,
  type OrganizationDb,
  type OrganizationRow,
  type OrganizationSettings,
} from '../db/index.ts';

export type OrganizationTools = {
  // 招待する人の解決器。持つ手段（GitHub）だけ。資格情報が未設定の手段と、解決器を持たない手段は undefined
  inviteeResolver(provider: string): InviteeResolver | undefined;
  // 自分の組織の行のうち、入るときに引かない値（人数の上限）
  readOrganization(): Promise<OrganizationRow>;
  // 自分の組織の言葉づかいと既定のテーマを書く（渡した項目と updated_at だけ）。変更の記録（change_logs）は書かない。
  // 組織の中の表なので、呼び出し側が別の batch() で書く
  writeOrganizationSettings(settings: OrganizationSettings, now: Date): Promise<void>;
  // ログインできる条件を失った人のセッションを消す。組織を離れる、無効にするなどの書き込みの batch() の後に呼ぶ。
  // users の ID は自分の組織の行だけを見る（別の組織の ID は何もしない）。アカウントに結ばれていない行、運用者、
  // まだ入れる組織か届いた招待がある人も何もしない。判定は登録の関数のセッションの判定と同じ（結ばれる前の行を数えない）
  endSessionsIfLoginLost(userId: string): Promise<void>;
  // 自分の組織の users の ID ごとのアバターの URL。ログインしたことの無い人と、アバターの無い人は null。
  // 別の組織の ID と、存在しない ID はキーを持たない
  avatarsOf(userIds: readonly string[]): Promise<Map<string, string | null>>;
};

export function organizationTools(
  env: Env,
  db: OrganizationDb,
  inviteeResolver: (provider: string) => InviteeResolver | undefined,
): OrganizationTools {
  return {
    inviteeResolver,
    readOrganization: () => readOrganizationRow(env, db),
    writeOrganizationSettings: (settings, now) => writeOrganizationSettings(env, db, settings, now),
    endSessionsIfLoginLost: (userId) => endSessionsIfLoginLost(env, db, userId),
    avatarsOf: (userIds) => userAvatarsOf(env, db, userIds),
  };
}

async function endSessionsIfLoginLost(env: Env, db: OrganizationDb, userId: string): Promise<void> {
  const user = await db.first(
    db.statement((q) =>
      q
        .selectFrom('users')
        .select('account_id')
        .where('organization_id', '=', db.organizationId)
        .where('id', '=', userId),
    ),
  );
  const accountId = user?.account_id ?? null;
  if (accountId === null) return;
  const logins = await accountLogins(env, accountId);
  // 運用者は入れる組織が無くてもログインできる
  if (isOperatorLogin(env, logins)) return;
  // 判定した時刻までに作られたセッションだけを消す（判定の後にログインし直したセッションは残す）
  const checkedAt = new Date();
  const { organizations, invitations } = await listAccountOrganizations(env, { accountId, logins });
  if (organizations.length > 0 || invitations.length > 0) return;
  await deleteSessionsOf(commonDb(env), accountId, checkedAt);
}
