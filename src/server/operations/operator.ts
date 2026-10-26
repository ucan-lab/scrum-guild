// 運用者の操作の処理（docs/data-model.md の「書き込みの単位」の組織の作成）。
// 運用者は組織の中に特権を持たない。応答に組織の中のデータ（人の名前など）を入れない
import {
  createOrganization,
  listOrganizations,
  resolveGithubUser,
  type CreateOrganizationProblem,
} from '../../shared/operations/operator/index.ts';
import { CLAIM_LIFETIME_DAYS } from '../../shared/claim-token.ts';
import { normalizeEmail } from '../../shared/email.ts';
import { slugProblem } from '../../shared/organization-slug.ts';
import type { ResolvedInvitee } from '../auth/login-method.ts';
import { randomToken, sha256Hex } from '../auth/tokens.ts';
import { commonDb, type CreatedOrganization, type Statement } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { adminDesignationStatements } from '../organizations/designate-admin.ts';
import { uuidv7 } from '../uuid.ts';
import { resolveGithubUsername } from './github-invitee.ts';
import { implement } from './implement.ts';
import type { OperatorTools } from './operator-tools.ts';

type CommonDb = ReturnType<typeof commonDb>;

// 入力の誤り。details の形は入力の検証（guards.ts の readInput）と同じ { path, code, message }。
// message は開発者向けの固定の文で、入力の値を入れない
function invalid(path: string, code: CreateOrganizationProblem, message: string): ApiError {
  return new ApiError(400, 'invalid_input', [{ path, code, message }]);
}

// GitHub のユーザー名をユーザー ID に解決する（判定は github-invitee.ts。招待の操作と同じ）
function resolveForOperator(
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
        .select([
          'id',
          'slug',
          'name',
          'suspended_at',
          'purge_on',
          'created_at',
          'member_limit',
          'attachment_quota_bytes',
        ])
        .orderBy('created_at', 'desc')
        .orderBy('slug'),
    ),
  );
  // 共通の表（organizations）と組織の中の表は別々に読む。集計は組織の ID の束で、組織ごとに数える
  const ids = rows.map((row) => row.id);
  const at = new Date();
  const [statuses, usage] = await Promise.all([operator.adminStatuses(ids, at), operator.organizationUsage(ids, at)]);
  return {
    organizations: rows.map((row) => ({
      slug: row.slug,
      name: row.name,
      suspended_at: row.suspended_at,
      purge_on: row.purge_on,
      created_at: row.created_at,
      admin_status: statuses.get(row.id) ?? ('none' as const),
      seats: { used: usage.get(row.id)?.seatsUsed ?? 0, limit: row.member_limit },
      workspace_count: usage.get(row.id)?.workspaceCount ?? 0,
      task_count: usage.get(row.id)?.taskCount ?? 0,
      attachment_quota_bytes: row.attachment_quota_bytes,
      last_used_at: usage.get(row.id)?.lastUsedAt ?? null,
    })),
  };
});

export const resolveGithubUserOperation = implement(resolveGithubUser, async ({ operator, input }) => {
  const invitee = await resolveForOperator(operator, input.username, 'username', resolveGithubUser.name);
  return {
    login_subject: invitee.subject,
    login_name: invitee.loginName,
    display_name: invitee.displayName,
    avatar_url: invitee.avatarUrl,
  };
});

// 組織の作成の change_logs と最初の管理者の指名（users と change_logs）を、組織の DB に1回の batch() で書く
async function writeOrganizationAndAdmin(
  operator: OperatorTools,
  created: CreatedOrganization,
  organization: { slug: string; name: string; now: Date },
  designationStatements: readonly Statement<'organization'>[],
): Promise<void> {
  const { db } = created;
  try {
    await db.batch([
      db.statement((q) =>
        q.insertInto('change_logs').values({
          id: uuidv7(organization.now.getTime()),
          organization_id: created.organizationId,
          actor_user_id: null,
          operator: operator.loginId,
          entity_type: 'organization',
          entity_id: created.organizationId,
          action: 'create',
          changes_json: JSON.stringify({ slug: [null, organization.slug], name: [null, organization.name] }),
          created_at: organization.now.toISOString(),
        }),
      ),
      ...designationStatements,
    ]);
  } catch (err) {
    // organizations だけが残った。例外の message に SQL や接続の詳細が混ざりうるので、名前と組織の ID だけをログに残す
    console.error(
      JSON.stringify({
        level: 'error',
        code: 'internal',
        requestId: operator.requestId,
        operation: createOrganization.name,
        route: 'operator',
        reason: '組織を作ったが、最初の管理者を書けなかった。管理者のいない組織が残る',
        organizationId: created.organizationId,
        error: err instanceof Error ? err.name : typeof err,
      }),
    );
    throw err;
  }
}

// Google のメールアドレスで最初の管理者を指名する。sub が分かる前なので解決せず、待つ行（login_subject が空）を入れて、
// 招待の URL を返す（docs/data-model.md の「メールアドレスで待つ指名と招待」）。秘密は応答の本文にだけ入れ、DB には SHA-256 だけを持つ。
// 順は GitHub の指名と同じ（slug、重なり、organizations、組織の DB の users と change_logs）。解決も、アカウントの引き直しもしない
async function createWithGoogleAdmin(
  db: CommonDb,
  operator: OperatorTools,
  input: { slug: string; name: string; email: string },
) {
  const email = normalizeEmail(input.email);
  if (email === undefined) throw invalid('admin.email', 'email_invalid', 'メールアドレスの形に合わない');

  if (await slugExists(db, input.slug)) throw new ApiError(409, 'conflict');

  const now = new Date();
  const claimToken = randomToken();
  const claimExpiresAt = new Date(now.getTime() + CLAIM_LIFETIME_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const created = await operator.insertOrganization({ slug: input.slug, name: input.name, now });
  if (created === 'slug_taken') throw new ApiError(409, 'conflict');

  const designation = adminDesignationStatements(created.db, {
    nominee: {
      provider: 'google',
      waiting: { email, claimTokenHash: await sha256Hex(claimToken), claimExpiresAt },
      // 待つ間の users.name はメールアドレス（結ぶときに Google のプロフィールの名前に書き直す）
      name: email,
      accountId: null,
    },
    operatorLoginId: operator.loginId,
    now,
  });
  await writeOrganizationAndAdmin(
    operator,
    created,
    { slug: input.slug, name: input.name, now },
    designation.statements,
  );

  return {
    slug: input.slug,
    name: input.name,
    admin_login_name: email,
    invite: { url: operator.inviteUrl(claimToken), expires_at: claimExpiresAt },
  };
}

// 作る順（docs/data-model.md の「書き込みの単位」）:
//   1. slug の形と予約した名前を確かめる  2. slug の重なりを読む（重なれば GitHub に問い合わせずに 409）
//   3. GitHub のユーザー名を解決し、運用者が確かめたユーザー ID と一致するか確かめる
//   4. 指名する人のアカウントを共通の DB で引く  5. organizations を書く（同時に作られて UNIQUE に当たれば 409）
//   6. 組織の DB に、最初の管理者の users と change_logs の2行を1回の batch() で書く
// 6 が失敗すると、管理者のいない組織が残る（一覧の admin_status が none）。指名し直しは Issue #60
export const createOrganizationOperation = implement(createOrganization, async ({ db, operator, input }) => {
  const problem = slugProblem(input.slug);
  if (problem !== undefined) {
    throw invalid(
      'slug',
      problem === 'format' ? 'slug_format' : 'slug_reserved',
      problem === 'format' ? 'slug の形に合わない' : 'アプリが使う名前は slug にできない',
    );
  }
  if (input.admin.provider === 'google') {
    return await createWithGoogleAdmin(db, operator, { slug: input.slug, name: input.name, email: input.admin.email });
  }
  const admin = input.admin;

  if (await slugExists(db, input.slug)) throw new ApiError(409, 'conflict');

  const invitee = await resolveForOperator(operator, admin.username, 'admin.username', createOrganization.name);
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
  await writeOrganizationAndAdmin(
    operator,
    created,
    { slug: input.slug, name: input.name, now },
    designation.statements,
  );

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
          operation: createOrganization.name,
          route: 'operator',
          reason: '指名した人のアカウントを結べなかった。次のログインで結ばれる',
          organizationId: created.organizationId,
          error: err instanceof Error ? err.name : typeof err,
        }),
      );
    }
  }

  return {
    slug: input.slug,
    name: input.name,
    admin_login_name: invitee.loginName,
    invite: null,
  };
});
