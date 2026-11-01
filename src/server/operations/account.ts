// 組織の外の操作の処理に渡す、ログインした人についての読み取り。env を処理に渡さず、決まった問い合わせだけを渡す。
// アカウントに結んだログインの手段と ID、入れる組織と届いた招待と停止した組織は、使われたときに1回だけ引く
// （入れる組織の確かめは登録の関数では行わない。my-organizations の処理が使う）
import { accountLogins } from '../auth/account-logins.ts';
import { isOperatorLogin, operatorLoginIdOf } from '../auth/operators.ts';
import {
  insertSelfCreatedOrganization,
  listAccountOrganizations,
  type AccountOrganizations,
  type CreatedOrganization,
  type LoginId,
} from '../db/index.ts';

export type OutsideAccount = {
  // このアカウントが自分の組織を作る最初の書き込み（共通の DB の organizations）。slug が重なれば 'slug_taken'、
  // お試し中の組織をすでに持つなら 'trial_limit'。作った人の users と change_logs は、返る組織の入口に呼び出し側が書く
  createOrganization(input: {
    slug: string;
    name: string;
    now: Date;
  }): Promise<CreatedOrganization | 'slug_taken' | 'trial_limit'>;
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
    createOrganization: (input) => insertSelfCreatedOrganization(env, { ...input, accountId }),
    logins: loadLogins,
    organizations: () =>
      (organizations ??= (async () => listAccountOrganizations(env, { accountId, logins: await loadLogins() }))()),
    isOperator: async () => isOperatorLogin(env, await loadLogins()),
    operatorLoginId: async () => operatorLoginIdOf(env, await loadLogins()),
  };
}
