// API トークンの発行・一覧・取消の処理（定義は src/shared/operations/session/token.ts）。
// 生の値は token-create の応答にだけ載せる。ログには値もハッシュも出さない。ハッシュ（token_hash）は、一覧と発行の応答で
// 取消に使う id として返す（ハッシュからは認証できず、生の値は復元できない）
import { API_TOKEN_REAUTH_MINUTES } from '../../shared/api-token.ts';
import { tokenCreate, tokenList, tokenRevoke } from '../../shared/operations/session/index.ts';
import { issueApiTokenWith, listApiTokensOf, revokeApiTokenOf } from '../auth/api-token.ts';
import { ApiError } from '../errors.ts';
import { implement } from './implement.ts';

// 発行と一覧は、同じリクエスト内で1回取った時刻と、変わらない作成日時で判定する。ちょうど10分は通す。
function canCreateToken(createdAt: string, now: Date): boolean {
  return now.getTime() - Date.parse(createdAt) <= API_TOKEN_REAUTH_MINUTES * 60 * 1000;
}

export const tokenCreateOperation = implement(tokenCreate, async ({ db, accountId, session, input }) => {
  const now = new Date();
  if (!canCreateToken(session.createdAt, now)) throw new ApiError(403, 'reauth_required');
  const issued = await issueApiTokenWith(db, {
    accountId,
    name: input.name,
    scope: input.scope,
    now,
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

export const tokenListOperation = implement(tokenList, async ({ db, accountId, session }) => {
  const now = new Date();
  return {
    tokens: await listApiTokensOf(db, accountId, now),
    can_create: canCreateToken(session.createdAt, now),
  };
});

export const tokenRevokeOperation = implement(tokenRevoke, async ({ db, accountId, input }) => {
  if (!(await revokeApiTokenOf(db, accountId, input.id, new Date()))) throw new ApiError(404, 'not_found');
  return {};
});
