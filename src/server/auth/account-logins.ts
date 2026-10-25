import { commonDb, type LoginId } from '../db/index.ts';

// アカウントに結んだログインの手段と ID。運用者の判定と、承諾待ちの招待の突き合わせに使う
export async function accountLogins(env: Env, accountId: string): Promise<LoginId[]> {
  const db = commonDb(env);
  const rows = await db.rows(
    db.statement((q) =>
      q.selectFrom('account_logins').select(['login_provider', 'login_subject']).where('account_id', '=', accountId),
    ),
  );
  return rows.map((row) => ({ provider: row.login_provider, subject: row.login_subject }));
}
