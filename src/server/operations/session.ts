// ログインしている人自身の操作の処理（定義は src/shared/operations/session/）
import { logout, me } from '../../shared/operations/session/index.ts';
import { ApiError } from '../errors.ts';
import { implement } from './implement.ts';

export const meOperation = implement(me, async ({ db, accountId }) => {
  // 初版は1つのアカウントに結ぶログインの手段が1つだけ。複数になったら最初に結んだものを返す
  const login = await db.first(
    db.statement((q) =>
      q
        .selectFrom('account_logins')
        .select(['login_provider', 'login_name', 'display_name', 'avatar_url'])
        .where('account_id', '=', accountId)
        .orderBy('created_at')
        .limit(1),
    ),
  );
  if (login === undefined) throw new ApiError(404, 'not_found');
  return {
    account_id: accountId,
    login_provider: login.login_provider,
    login_name: login.login_name,
    display_name: login.display_name,
    avatar_url: login.avatar_url,
  };
});

export const logoutOperation = implement(logout, async ({ db, session }) => {
  await db.batch([db.statement((q) => q.deleteFrom('sessions').where('token_hash', '=', session.tokenHash))]);
  session.clearCookie();
  return {};
});
