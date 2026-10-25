// 本人を確かめた後の分かれ道（docs/requirements.md の「メンバーと権限」、docs/data-model.md の「書き込みの単位」）。
//   - 入れる組織も届いた招待も無い人は、運用者でない限りログインさせず、accounts を作らない
//   - 初めてログインできた人は、accounts と account_logins を1回の batch() で作る。運用者は入れる組織が無くても作る
//   - 2回目以降は、account_logins の表示名とアバター、accounts.last_login_at を書き直す
//   - ログインのたびに、組織の DB の users.account_id が空で、ログインの ID が同じ行（指名で待っていた行）を結ぶ。
//     共通の表と組織の中の表は別の batch() で書くので、結ぶ書き込みが失敗しうる。失敗したらセッションを作らず、
//     「もう一度ログインしてください」を出す。次のログインで同じ行を結び直すので、何度流しても同じ結果になる
//   - 招待の URL から始めたログイン（state の行に秘密のハッシュがある）は、上の判定より前に、メールアドレスで待つ指名と招待を結ぶ
//     （docs/data-model.md の「メールアドレスで待つ指名と招待」の 4〜7）。結べなければ、ほかの組織に入れる人でもセッションを作らず、
//     `invite` で断る。結べたら、あとは通常のログインと同じ（sub で入れる組織を引き、アカウントを作り、users.account_id を結ぶ）
//   - セッションを作る
// 人が差分を読む領域（docs/development.md の「マージの判定」）
import { normalizeEmail } from '../../shared/email.ts';
import { claimPendingLogin, commonDb, hasLoginAccess, linkLoginToAccount, type ClaimOutcome } from '../db/index.ts';
import { uuidv7 } from '../uuid.ts';
import type { LoginProfile } from './login-method.ts';
import { isOperatorLogin } from './operators.ts';
import { createSession } from './session.ts';

export type LoginOutcome =
  // claimed: 招待の URL から結んだときの、結んだ先
  | { ok: true; accountId: string; sessionToken: string; claimed?: ClaimOutcome }
  // denied: 入れる組織も招待も無い。retry: 結ぶ書き込みが失敗した。invite: 招待の URL から結べなかった
  | { ok: false; reason: 'denied' | 'retry' | 'invite' };

type LoginInput = {
  provider: string;
  profile: LoginProfile;
  now: Date;
  // このリクエストが持っていた古いセッションの Cookie の値
  replacedSessionToken: string | undefined;
  requestId: string;
  // 招待の URL から始めたログインの、その URL の秘密の SHA-256（oauth_states.claim_token_hash）。通常のログインは null
  claimTokenHash?: string | null;
};

async function findAccountId(env: Env, provider: string, subject: string): Promise<string | undefined> {
  const db = commonDb(env);
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('account_logins')
        .select('account_id')
        .where('login_provider', '=', provider)
        .where('login_subject', '=', subject),
    ),
  );
  return row?.account_id;
}

// ログインのたびに表示用の値を書き直す。アカウントがまだ無ければ、accounts と同じ batch() で作る
async function writeAccount(env: Env, input: LoginInput, existing: string | undefined): Promise<string> {
  const { provider, profile, now } = input;
  const at = now.toISOString();
  const db = commonDb(env);
  if (existing !== undefined) {
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('account_logins')
          .set({
            login_name: profile.loginName,
            display_name: profile.displayName,
            avatar_url: profile.avatarUrl,
            updated_at: at,
          })
          .where('login_provider', '=', provider)
          .where('login_subject', '=', profile.subject),
      ),
      db.statement((q) =>
        q.updateTable('accounts').set({ last_login_at: at, updated_at: at }).where('id', '=', existing),
      ),
    ]);
    return existing;
  }

  const accountId = uuidv7(now.getTime());
  await db.batch([
    db.statement((q) =>
      q.insertInto('accounts').values({ id: accountId, last_login_at: at, created_at: at, updated_at: at }),
    ),
    db.statement((q) =>
      q.insertInto('account_logins').values({
        login_provider: provider,
        login_subject: profile.subject,
        account_id: accountId,
        login_name: profile.loginName,
        display_name: profile.displayName,
        avatar_url: profile.avatarUrl,
        created_at: at,
        updated_at: at,
      }),
    ),
  ]);
  return accountId;
}

// 同じ人の最初のログインが並行したときは、片方の batch() が account_logins の主キーで落ちて、accounts ごと戻る。
// 落ちた側は、もう片方が作った行を読み直して続ける
async function ensureAccount(env: Env, input: LoginInput, existing: string | undefined): Promise<string> {
  try {
    return await writeAccount(env, input, existing);
  } catch (err) {
    if (existing !== undefined) throw err;
    const created = await findAccountId(env, input.provider, input.profile.subject);
    if (created === undefined) throw err;
    return await writeAccount(env, input, created);
  }
}

// 招待の URL の秘密と、ID トークンの確かめたメールアドレスで、待っている指名と招待を結ぶ。結べなければ undefined。
// メールアドレスが無い（email_verified が真でない）、そろえられない、Google 以外の手段、のときは DB を引かずに結べないものとする
async function claimWaitingRow(env: Env, input: LoginInput, tokenHash: string): Promise<ClaimOutcome | undefined> {
  const { provider, profile, now } = input;
  const email = profile.verifiedEmail == null ? undefined : normalizeEmail(profile.verifiedEmail);
  if (provider !== 'google' || email === undefined) return undefined;
  return claimPendingLogin(env, {
    tokenHash,
    email,
    login: { provider, subject: profile.subject },
    name: profile.displayName ?? profile.loginName,
    now,
  });
}

export async function completeLogin(env: Env, input: LoginInput): Promise<LoginOutcome> {
  const { provider, profile, now } = input;
  const login = { provider, subject: profile.subject };

  let claimed: ClaimOutcome | undefined;
  if (input.claimTokenHash != null) {
    claimed = await claimWaitingRow(env, input, input.claimTokenHash);
    if (claimed === undefined) return { ok: false, reason: 'invite' };
  }

  let existing = await findAccountId(env, provider, profile.subject);
  const operator = isOperatorLogin(env, [login]);
  if (!operator) {
    let allowed = await hasLoginAccess(env, { accountId: existing, logins: [login] });
    // 同じ人の最初のログインが並行すると、アカウントが無いと読んだ後に、もう片方がアカウントを作り、指名の行を結ぶ
    // （結んだ行は、アカウントが無い側からは当たらなくなる）。判定が落ちたら読み直し、できていればその ID で判定し直す。
    // 権限の無い人のアカウントを先に作ることはしない
    if (!allowed && existing === undefined) {
      existing = await findAccountId(env, provider, profile.subject);
      if (existing !== undefined) allowed = await hasLoginAccess(env, { accountId: existing, logins: [login] });
    }
    if (!allowed) return { ok: false, reason: 'denied' };
  }

  const accountId = await ensureAccount(env, input, existing);

  try {
    await linkLoginToAccount(env, accountId, login, now);
  } catch (err) {
    // 例外の message に SQL や接続の詳細が混ざりうるので、名前だけを残す
    console.error(
      JSON.stringify({
        level: 'error',
        code: 'internal',
        requestId: input.requestId,
        reason: 'users.account_id を結べなかった。セッションを作らずにやり直させる',
        error: err instanceof Error ? err.name : typeof err,
      }),
    );
    return { ok: false, reason: 'retry' };
  }

  const sessionToken = await createSession(env, accountId, now, input.replacedSessionToken);
  return { ok: true, accountId, sessionToken, ...(claimed === undefined ? {} : { claimed }) };
}
