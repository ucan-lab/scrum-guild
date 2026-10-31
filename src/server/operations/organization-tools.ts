// 組織の中の操作の処理に渡す道具。運用者の道具（operator-tools.ts）と同じく、env を処理に渡さず、決まった呼び出しだけを渡す。
// 組織の中の処理は共通の入口を持たないので、共通の表（組織の行、アカウントのログイン、セッション）と、ログインの手段に触れるのはここだけ。
// 登録の関数が、組織に入れると確かめた後に、その組織の入口（OrganizationDb）に結んで作る。どの道具も組織の ID を引数に取らず、
// 組織の行は確かめた組織の ID で、組織の中の表は organization_id で絞る。共通の表と組織の中の表は別の問い合わせで引き、1回の batch() に混ぜない。
// 道具は権限ごとに分けず、組織の中のすべての操作に渡す。道具の中で入った人（actor）を確かめ、承諾待ちの招待だけの人の操作からは
// 自分のログインの読み取り（myLogins）のほかの道具を使えず、組織の設定の書き込みは管理者の操作からだけ使える。
// 当たらない呼び出しは処理の誤りなので、投げて 500 にする
import { INVITE_PATH } from '../../shared/claim-token.ts';
import type { InviteeResolver } from '../auth/login-method.ts';
import {
  commonDb,
  readOrganizationRow,
  userAvatarsOf,
  writeOrganizationSettings,
  type OrganizationActor,
  type OrganizationDb,
  type OrganizationRow,
  type OrganizationSettingsChange,
  type OrganizationSettingsWrite,
} from '../db/index.ts';

export type OrganizationTools = {
  // 招待する人の解決器。持つ手段（GitHub）だけ。資格情報が未設定の手段と、解決器を持たない手段は undefined
  inviteeResolver(provider: string): InviteeResolver | undefined;
  // 招待の URL（<公開 URL のオリジン>/invite#<秘密>）。Google の招待（invitation-create）が作る。秘密は応答の本文にだけ入れる
  // （運用者の道具の inviteUrl と同じ式）
  inviteUrl(claimToken: string): string;
  // 自分の組織の行のうち、入るときに引かない値（人数の上限）
  readOrganization(): Promise<OrganizationRow>;
  // 自分の組織の言葉づかいと既定のテーマを、停止しておらず、先に読んだ値（from）のままなら書く（渡した項目と updated_at だけ）。
  // 管理者の操作からだけ呼ぶ。書けたら written、入ってから書くまでに停止されていたら suspended（呼び出し側は 403 にする）、
  // 別の要求が先に変えていたら conflict（409 にする）。変更の記録（change_logs）は書かない。
  // 組織の中の表なので、呼び出し側が written のときだけ別の batch() で書く
  writeOrganizationSettings(change: OrganizationSettingsChange, now: Date): Promise<OrganizationSettingsWrite>;
  // 自分の組織の users の ID ごとのアバターの URL。アカウントに結ばれていない人、ログインしたことの無い人、アバターの無い人は null。
  // 別の組織の ID と、存在しない ID はキーを持たない
  avatarsOf(userIds: readonly string[]): Promise<Map<string, string | null>>;
  // 呼んだ人のアカウント（actor.accountId）に結んだログインの手段、ID、ログイン名。届いた招待の一覧、承諾、辞退が、
  // 招待の (login_provider, login_subject) と突き合わせ、承諾で作る users の名前を決めるのに使う。
  // この道具だけは、承諾待ちの招待だけの人の操作からも使える。1回のリクエストで1回だけ引く
  myLogins(): Promise<readonly MyLogin[]>;
};

// アカウントに結んだログイン。loginName はログインの手段の側の名前（GitHub のユーザー名など）
export type MyLogin = { readonly provider: string; readonly subject: string; readonly loginName: string };

export function organizationTools(
  env: Env,
  db: OrganizationDb,
  actor: OrganizationActor,
  inviteeResolver: (provider: string) => InviteeResolver | undefined,
): OrganizationTools {
  // 承諾待ちの招待だけの人は、組織の中を読む操作に通らない（register.ts の checkOrganizationPermission）。道具もその人には使わせない
  const member = <T>(use: () => T): T => {
    if (actor.invitedOnly) throw new Error('承諾待ちの招待だけの人の操作から、組織の道具を使った');
    return use();
  };
  let logins: Promise<readonly MyLogin[]> | undefined;
  return {
    inviteeResolver: (provider) => member(() => inviteeResolver(provider)),
    inviteUrl: (claimToken) => member(() => `${new URL(env.PUBLIC_ORIGIN).origin}${INVITE_PATH}#${claimToken}`),
    readOrganization: () => member(() => readOrganizationRow(env, db)),
    writeOrganizationSettings: (change, now) =>
      member(() => {
        if (!actor.isAdmin) throw new Error('管理者でない人の操作から、組織の設定を書いた');
        return writeOrganizationSettings(env, db, change, now);
      }),
    avatarsOf: (userIds) => member(() => userAvatarsOf(env, db, userIds)),
    myLogins: () => (logins ??= readMyLogins(env, actor.accountId)),
  };
}

// 共通の表（account_logins）だけを、共通の入口から引く。組織の中の表とは別の問い合わせにする
async function readMyLogins(env: Env, accountId: string): Promise<readonly MyLogin[]> {
  const common = commonDb(env);
  const rows = await common.rows(
    common.statement((q) =>
      q
        .selectFrom('account_logins')
        .select(['login_provider', 'login_subject', 'login_name'])
        .where('account_id', '=', accountId)
        .orderBy('login_provider')
        .orderBy('login_subject'),
    ),
  );
  return rows.map((row) => ({ provider: row.login_provider, subject: row.login_subject, loginName: row.login_name }));
}
