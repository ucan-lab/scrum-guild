// API トークンの発行・一覧・取消の処理（定義は src/shared/operations/session/token.ts）。
// 生の値は token-create の応答にだけ載せる。ログにも一覧にも、値もハッシュも渡さない
import { tokenCreate, tokenList, tokenRevoke } from '../../shared/operations/session/index.ts';
import { issueApiTokenWith, listApiTokensOf, revokeApiTokenOf } from '../auth/api-token.ts';
import { ApiError } from '../errors.ts';
import { implement } from './implement.ts';

export const tokenCreateOperation = implement(tokenCreate, async ({ db, accountId, input }) => {
  const issued = await issueApiTokenWith(db, {
    accountId,
    name: input.name,
    scope: input.scope,
    now: new Date(),
    ...(input.lifetime_days === undefined ? {} : { lifetimeDays: input.lifetime_days }),
  });
  return {
    id: issued.tokenHash,
    name: input.name,
    scope: input.scope,
    expires_at: issued.expiresAt,
    token: issued.raw,
  };
});

export const tokenListOperation = implement(tokenList, async ({ db, accountId }) => ({
  tokens: await listApiTokensOf(db, accountId, new Date()),
}));

export const tokenRevokeOperation = implement(tokenRevoke, async ({ db, accountId, input }) => {
  if (!(await revokeApiTokenOf(db, accountId, input.id, new Date()))) throw new ApiError(404, 'not_found');
  return {};
});
