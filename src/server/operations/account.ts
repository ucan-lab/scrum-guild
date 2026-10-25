// 組織の外の操作の処理に渡す、ログインした人についての読み取り。env を処理に渡さず、決まった問い合わせだけを渡す。
// アカウントに結んだログインの手段と ID は、使われたときに1回だけ引く
import { isOperator, operatorLoginIds } from '../auth/operators.ts';
import { accountLogins } from '../auth/account-logins.ts';
import { listAccountOrganizations, type AccountOrganizations, type LoginId } from '../db/index.ts';

export type OutsideAccount = {
  // 入れる組織と、承諾待ちの招待だけがある組織（組織をまたいで読む関数を通す）
  organizations(): Promise<AccountOrganizations>;
  // シークレットの運用者の一覧に、このアカウントのログインが載っているか
  isOperator(): Promise<boolean>;
};

export function outsideAccount(env: Env, accountId: string): OutsideAccount {
  let logins: Promise<LoginId[]> | undefined;
  const loadLogins = () => (logins ??= accountLogins(env, accountId));
  return {
    organizations: async () => listAccountOrganizations(env, { accountId, logins: await loadLogins() }),
    isOperator: async () => {
      // 設定の誤りは app のミドルウェアが先に 500 にしている。ここに来る一覧は解釈できている
      const operators = operatorLoginIds(env);
      return operators.ok && isOperator(operators.ids, await loadLogins());
    },
  };
}
