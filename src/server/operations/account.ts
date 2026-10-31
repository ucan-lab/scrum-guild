// 組織の外の操作の処理に渡す、ログインした人についての読み取り。env を処理に渡さず、決まった問い合わせだけを渡す。
// アカウントに結んだログインの手段と ID、入れる組織と届いた招待と停止した組織は、使われたときに1回だけ引く
// （入れる組織の確かめは登録の関数では行わない。my-organizations の処理が使う）
import { accountLogins } from '../auth/account-logins.ts';
import { isOperatorLogin, operatorLoginIdOf } from '../auth/operators.ts';
import { listAccountOrganizations, type AccountOrganizations, type LoginId } from '../db/index.ts';

export type OutsideAccount = {
  // 入れる組織と、承諾待ちの招待だけがある組織（組織をまたいで読む関数を通す）。アカウントに結ばれる前の行は数えない
  organizations(): Promise<AccountOrganizations>;
  // シークレットの運用者の一覧に、このアカウントのログインが載っているか
  isOperator(): Promise<boolean>;
  // 運用者の一覧に載っているログインの ID（`github:12345` の形）。運用者でなければ undefined
  operatorLoginId(): Promise<string | undefined>;
  // アカウントに結んだログインの手段と ID。登録の関数が、組織に入れるかの判定（enterOrganization）に渡す。引くのは1回だけ
  logins(): Promise<readonly LoginId[]>;
};

export function outsideAccount(env: Env, accountId: string): OutsideAccount {
  let logins: Promise<LoginId[]> | undefined;
  const loadLogins = () => (logins ??= accountLogins(env, accountId));
  let organizations: Promise<AccountOrganizations> | undefined;
  return {
    logins: loadLogins,
    organizations: () =>
      (organizations ??= (async () => listAccountOrganizations(env, { accountId, logins: await loadLogins() }))()),
    isOperator: async () => isOperatorLogin(env, await loadLogins()),
    operatorLoginId: async () => operatorLoginIdOf(env, await loadLogins()),
  };
}
