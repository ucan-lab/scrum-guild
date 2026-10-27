// 運用者が管理者に指名する人の指し方（組織の作成の最初の管理者と、管理者の指名し直し）。両方の処理が同じ手順を使う。
// GitHub はユーザー名を解決し直し、運用者が確かめたユーザー ID と一致するかを確かめ、既にアカウントがあるかを共通の DB で引く。
// Google はメールアドレスをそろえ、待つ行の招待の URL の秘密を作る（docs/data-model.md の「メールアドレスで待つ指名と招待」）
import { CLAIM_LIFETIME_DAYS } from '../../shared/claim-token.ts';
import { normalizeEmail } from '../../shared/email.ts';
import type { CreateOrganizationProblem, ReassignAdminProblem } from '../../shared/operations/operator/index.ts';
import type { ResolvedInvitee } from '../auth/login-method.ts';
import { randomToken, sha256Hex } from '../auth/tokens.ts';
import type { commonDb } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import type { AdminNominee } from '../organizations/designate-admin.ts';
import { resolveGithubUsername } from './github-invitee.ts';
import type { OperatorTools } from './operator-tools.ts';

export type CommonDb = ReturnType<typeof commonDb>;

// 入力の誤り。details の形は入力の検証（guards.ts の readInput）と同じ { path, code, message }。
// message は開発者向けの固定の文で、入力の値を入れない
export function invalid(
  path: string,
  code: CreateOrganizationProblem | ReassignAdminProblem,
  message: string,
): ApiError {
  return new ApiError(400, 'invalid_input', [{ path, code, message }]);
}

// GitHub のユーザー名をユーザー ID に解決する（判定は github-invitee.ts。招待の操作と同じ）
export function resolveForOperator(
  operator: OperatorTools,
  username: string,
  path: string,
  operation: string,
): Promise<ResolvedInvitee> {
  return resolveGithubUsername(operator.inviteeResolver('github'), username, path, {
    operation,
    route: 'operator',
    requestId: operator.requestId,
  });
}

// 指名する人が既にアカウントを持つか。持てば users.account_id を指名のときに埋め、ログインし直さずに入れるようにする
export async function findAccountId(db: CommonDb, provider: string, subject: string): Promise<string | null> {
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('account_logins')
        .select('account_id')
        .where('login_provider', '=', provider)
        .where('login_subject', '=', subject),
    ),
  );
  return row?.account_id ?? null;
}

// GitHub の指名する人。ユーザー名を解決し直し、確かめたユーザー ID と違えば断る。既にアカウントがあれば、その ID を添える
export async function githubNominee(
  db: CommonDb,
  operator: OperatorTools,
  admin: { username: string; login_subject: string },
  operation: string,
): Promise<Extract<AdminNominee, { subject: string }>> {
  const invitee = await resolveForOperator(operator, admin.username, 'admin.username', operation);
  if (invitee.subject !== admin.login_subject) {
    throw invalid('admin.login_subject', 'github_user_changed', '確かめたユーザー ID と、解決し直した ID が違う');
  }
  const accountId = await findAccountId(db, 'github', invitee.subject);
  return { provider: 'github', subject: invitee.subject, name: invitee.loginName, accountId };
}

// Google の指名する人。sub が分かる前なので解決せず、待つ行の値（そろえたメールアドレス、秘密のハッシュ、期限）を作る。
// 秘密（claimToken）は応答の本文にだけ入れ、DB には SHA-256 だけを持つ。そろえられないメールアドレスは断る
export async function googleNominee(
  rawEmail: string,
  now: Date,
): Promise<{ nominee: AdminNominee; email: string; claimToken: string; claimExpiresAt: string }> {
  const email = normalizeEmail(rawEmail);
  if (email === undefined) throw invalid('admin.email', 'email_invalid', 'メールアドレスの形に合わない');
  const claimToken = randomToken();
  const claimExpiresAt = new Date(now.getTime() + CLAIM_LIFETIME_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return {
    nominee: {
      provider: 'google',
      waiting: { email, claimTokenHash: await sha256Hex(claimToken), claimExpiresAt },
      // 待つ間の users.name はメールアドレス（結ぶときに Google のプロフィールの名前に書き直す）
      name: email,
      accountId: null,
    },
    email,
    claimToken,
    claimExpiresAt,
  };
}

// アカウントが無いと読んだ後、書くまでの間にその人が初めてログインを終えると、users.account_id が空のまま残る
// （ログインの結ぶ書き込みは、まだ書いていない行に当たらない）。書いた後に引き直し、できていれば結ぶ。
// 結ぶ文は account_id が空の行だけに当たるので、何度流しても同じ結果。失敗しても次のログインで結ばれる（投げずにログに残す）
export async function linkIfLoggedInSince(
  db: CommonDb,
  operator: OperatorTools,
  log: { subject: string; operation: string; organizationId: string },
): Promise<void> {
  try {
    const later = await findAccountId(db, 'github', log.subject);
    if (later !== null) await operator.linkLogin(later, { provider: 'github', subject: log.subject }, new Date());
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        code: 'internal',
        requestId: operator.requestId,
        operation: log.operation,
        route: 'operator',
        reason: '指名した人のアカウントを結べなかった。次のログインで結ばれる',
        organizationId: log.organizationId,
        error: err instanceof Error ? err.name : typeof err,
      }),
    );
  }
}
