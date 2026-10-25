// 運用者の操作の処理（docs/data-model.md の「書き込みの単位」の組織の作成）。
// 運用者は組織の中に特権を持たない。応答に組織の中のデータ（人の名前など）を入れない
import {
  createOrganization,
  listOrganizations,
  resolveGithubUser,
  type CreateOrganizationProblem,
} from '../../shared/operations/operator/index.ts';
import { slugProblem } from '../../shared/organization-slug.ts';
import { LoginMethodError, type ResolvedInvitee } from '../auth/login-method.ts';
import { commonDb } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { adminDesignationStatements } from '../organizations/designate-admin.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import type { OperatorTools } from './operator-tools.ts';

type CommonDb = ReturnType<typeof commonDb>;

// 入力の誤り。details の形は入力の検証（guards.ts の readInput）と同じ { path, code, message }。
// message は開発者向けの固定の文で、入力の値を入れない
function invalid(path: string, code: CreateOrganizationProblem, message: string): ApiError {
  return new ApiError(400, 'invalid_input', [{ path, code, message }]);
}

// GitHub のユーザー名をユーザー ID に解決する。当たる人がいない、個人のアカウントでない、は入力の誤り（400）。
// 届かない（GitHub の上限、障害、資格情報の未設定）は 503 の unavailable にして、入力の誤りと分ける
async function resolveGithubUsername(
  operator: OperatorTools,
  username: string,
  path: string,
  operation: string,
): Promise<ResolvedInvitee> {
  const method = operator.loginMethod('github');
  if (method === undefined) {
    throw unavailable(operator, operation, 'GitHub のクライアントの ID と秘密が設定されていない');
  }
  let resolution;
  try {
    resolution = await method.resolveInvitee(username);
  } catch (err) {
    if (err instanceof LoginMethodError) throw unavailable(operator, operation, err.message);
    throw err;
  }
  switch (resolution.kind) {
    case 'found':
      return resolution.invitee;
    case 'not_found':
      throw invalid(path, 'github_user_not_found', 'GitHub にそのユーザー名の人がいない');
    case 'not_a_user':
      throw invalid(path, 'github_not_a_user', 'GitHub の個人のアカウントではない');
  }
}

// reason は固定の文（LoginMethodError の message か、こちらの文）。応答には出さない
function unavailable(operator: OperatorTools, operation: string, reason: string): ApiError {
  console.warn(
    JSON.stringify({
      level: 'warn',
      code: 'unavailable',
      requestId: operator.requestId,
      operation,
      route: 'operator',
      provider: 'github',
      reason,
    }),
  );
  return new ApiError(503, 'unavailable');
}

async function slugExists(db: CommonDb, slug: string): Promise<boolean> {
  const row = await db.first(db.statement((q) => q.selectFrom('organizations').select('id').where('slug', '=', slug)));
  return row !== undefined;
}

// 指名する人が既にアカウントを持つか。持てば users.account_id を指名のときに埋め、ログインし直さずに入れるようにする
async function findAccountId(db: CommonDb, provider: string, subject: string): Promise<string | null> {
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

export const listOrganizationsOperation = implement(listOrganizations, async ({ db, operator }) => {
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('organizations')
        .select(['id', 'slug', 'name', 'suspended_at', 'created_at'])
        .orderBy('created_at', 'desc')
        .orderBy('slug'),
    ),
  );
  const statuses = await operator.adminStatuses(rows.map((row) => row.id));
  return {
    organizations: rows.map((row) => ({
      slug: row.slug,
      name: row.name,
      suspended_at: row.suspended_at,
      created_at: row.created_at,
      admin_status: statuses.get(row.id) ?? ('none' as const),
    })),
  };
});

export const resolveGithubUserOperation = implement(resolveGithubUser, async ({ operator, input }) => {
  const invitee = await resolveGithubUsername(operator, input.username, 'username', 'resolve-github-user');
  return {
    login_subject: invitee.subject,
    login_name: invitee.loginName,
    display_name: invitee.displayName,
    avatar_url: invitee.avatarUrl,
  };
});

// 作る順（docs/data-model.md の「書き込みの単位」）:
//   1. slug の形と予約した名前を確かめる  2. slug の重なりを読む（重なれば GitHub に問い合わせずに 409）
//   3. GitHub のユーザー名を解決し、運用者が確かめたユーザー ID と一致するか確かめる
//   4. 指名する人のアカウントを共通の DB で引く  5. organizations を書く（同時に作られて UNIQUE に当たれば 409）
//   6. 組織の DB に、最初の管理者の users と change_logs の2行を1回の batch() で書く
// 6 が失敗すると、管理者のいない組織が残る（一覧の admin_status が none）。指名し直しは Issue #60
const OPERATION = 'create-organization';

export const createOrganizationOperation = implement(createOrganization, async ({ db, operator, input }) => {
  const problem = slugProblem(input.slug);
  if (problem !== undefined) {
    throw invalid(
      'slug',
      problem === 'format' ? 'slug_format' : 'slug_reserved',
      problem === 'format' ? 'slug の形に合わない' : 'アプリが使う名前は slug にできない',
    );
  }
  if (input.admin.provider !== 'github') {
    throw invalid('admin.provider', 'login_provider_unavailable', 'この手段での指名はまだ使えない');
  }
  const admin = input.admin;

  if (await slugExists(db, input.slug)) throw new ApiError(409, 'conflict');

  const invitee = await resolveGithubUsername(operator, admin.username, 'admin.username', OPERATION);
  if (invitee.subject !== admin.login_subject) {
    throw invalid('admin.login_subject', 'github_user_changed', '確かめたユーザー ID と、解決し直した ID が違う');
  }

  const accountId = await findAccountId(db, 'github', invitee.subject);

  const now = new Date();
  const created = await operator.insertOrganization({ slug: input.slug, name: input.name, now });
  if (created === 'slug_taken') throw new ApiError(409, 'conflict');

  const designation = adminDesignationStatements(created.db, {
    nominee: { provider: 'github', subject: invitee.subject, name: invitee.loginName, accountId },
    operatorLoginId: operator.loginId,
    now,
  });
  try {
    await created.db.batch([
      created.db.statement((q) =>
        q.insertInto('change_logs').values({
          id: uuidv7(now.getTime()),
          organization_id: created.organizationId,
          actor_user_id: null,
          operator: operator.loginId,
          entity_type: 'organization',
          entity_id: created.organizationId,
          action: 'create',
          changes_json: JSON.stringify({ slug: [null, input.slug], name: [null, input.name] }),
          created_at: now.toISOString(),
        }),
      ),
      ...designation.statements,
    ]);
  } catch (err) {
    // organizations だけが残った。例外の message に SQL や接続の詳細が混ざりうるので、名前と組織の ID だけをログに残す
    console.error(
      JSON.stringify({
        level: 'error',
        code: 'internal',
        requestId: operator.requestId,
        operation: OPERATION,
        route: 'operator',
        reason: '組織を作ったが、最初の管理者を書けなかった。管理者のいない組織が残る',
        organizationId: created.organizationId,
        error: err instanceof Error ? err.name : typeof err,
      }),
    );
    throw err;
  }

  // アカウントが無いと読んだ後、書くまでの間にその人が初めてログインを終えると、users.account_id が空のまま残る
  // （ログインの結ぶ書き込みは、まだ書いていない行に当たらない）。書いた後に引き直し、できていれば結ぶ。
  // 結ぶ文は account_id が空の行だけに当たるので、何度流しても同じ結果。失敗しても次のログインで結ばれる
  if (accountId === null) {
    try {
      const later = await findAccountId(db, 'github', invitee.subject);
      if (later !== null) await operator.linkLogin(later, { provider: 'github', subject: invitee.subject }, new Date());
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          code: 'internal',
          requestId: operator.requestId,
          operation: OPERATION,
          route: 'operator',
          reason: '指名した人のアカウントを結べなかった。次のログインで結ばれる',
          organizationId: created.organizationId,
          error: err instanceof Error ? err.name : typeof err,
        }),
      );
    }
  }

  return { slug: input.slug, name: input.name, admin_login_name: invitee.loginName };
});
