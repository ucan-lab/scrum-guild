// GitHub のユーザー名を、招待する人（と運用者が指名する最初の管理者）のユーザー ID に解決する。運用者の操作（operator.ts）と、
// 組織の中の招待の操作（invitation.ts）が同じ判定を使う。解決器は、それぞれの道具（運用者の道具、組織の道具）から受け取る
import { LoginMethodError, type InviteeResolver, type ResolvedInvitee } from '../auth/login-method.ts';
import { ApiError } from '../errors.ts';

// 失敗のログに添える値。どれも固定の値か ID で、入力のユーザー名は入れない
export type ResolveLogContext = {
  readonly operation: string;
  readonly route: 'operator' | 'organization';
  readonly requestId?: string;
  readonly organizationId?: string;
};

// 当たる人がいない、個人のアカウントでない、は入力の誤り（400）。details の形は入力の検証（guards.ts の readInput）と同じ
// { path, code, message } で、message は開発者向けの固定の文。
// 届かない（GitHub の上限、障害、資格情報の未設定）は 503 の unavailable にして、入力の誤りと分ける
export async function resolveGithubUsername(
  resolver: InviteeResolver | undefined,
  username: string,
  path: string,
  log: ResolveLogContext,
): Promise<ResolvedInvitee> {
  if (resolver === undefined) {
    throw unavailable(log, 'GitHub のクライアントの ID と秘密が設定されていない');
  }
  let resolution;
  try {
    resolution = await resolver.resolveInvitee(username);
  } catch (err) {
    if (err instanceof LoginMethodError) throw unavailable(log, err.message);
    throw err;
  }
  switch (resolution.kind) {
    case 'found':
      return resolution.invitee;
    case 'not_found':
      throw new ApiError(400, 'invalid_input', [
        { path, code: 'github_user_not_found', message: 'GitHub にそのユーザー名の人がいない' },
      ]);
    case 'not_a_user':
      throw new ApiError(400, 'invalid_input', [
        { path, code: 'github_not_a_user', message: 'GitHub の個人のアカウントではない' },
      ]);
  }
}

// reason は固定の文（LoginMethodError の message か、こちらの文）。応答には出さない
function unavailable(log: ResolveLogContext, reason: string): ApiError {
  console.warn(
    JSON.stringify({
      level: 'warn',
      code: 'unavailable',
      ...(log.requestId === undefined ? {} : { requestId: log.requestId }),
      operation: log.operation,
      route: log.route,
      ...(log.organizationId === undefined ? {} : { organizationId: log.organizationId }),
      provider: 'github',
      reason,
    }),
  );
  return new ApiError(503, 'unavailable');
}
