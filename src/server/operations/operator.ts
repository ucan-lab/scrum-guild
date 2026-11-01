// 運用者の操作の処理（docs/data-model.md の「書き込みの単位」の組織の作成）。
// 運用者は組織の中に特権を持たない。応答に組織の中のデータ（人の名前など）を入れない
import { now } from '../../shared/clock.ts';
import {
  createOrganization,
  isPurgeDue,
  listOrganizations,
  resolveGithubUser,
} from '../../shared/operations/operator/index.ts';
import { slugProblem } from '../../shared/organization-slug.ts';
import type { CreatedOrganization, Statement } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { adminDesignationStatements } from '../organizations/designate-admin.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import {
  githubNominee,
  googleNominee,
  invalid,
  linkIfLoggedInSince,
  resolveForOperator,
  type CommonDb,
} from './operator-nominee.ts';
import type { OperatorTools } from './operator-tools.ts';

async function slugExists(db: CommonDb, slug: string): Promise<boolean> {
  const row = await db.first(db.statement((q) => q.selectFrom('organizations').select('id').where('slug', '=', slug)));
  return row !== undefined;
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
          'created_by_account_id',
          'suspended_at',
          'purge_on',
          'trial_ends_on',
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
  const at = now();
  const [statuses, usage] = await Promise.all([operator.adminStatuses(ids, at), operator.organizationUsage(ids, at)]);
  return {
    organizations: rows.map((row) => ({
      slug: row.slug,
      name: row.name,
      self_created: row.created_by_account_id !== null,
      trial_ends_on: row.trial_ends_on,
      trial_expired: row.trial_ends_on !== null && row.trial_ends_on < at.toISOString().slice(0, 10),
      suspended_at: row.suspended_at,
      purge_on: row.purge_on,
      purge_due: row.suspended_at !== null && isPurgeDue(row.purge_on, at),
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
  const now = new Date();
  const { nominee, email, claimToken, claimExpiresAt } = await googleNominee(input.email, now);

  if (await slugExists(db, input.slug)) throw new ApiError(409, 'conflict');

  const created = await operator.insertOrganization({ slug: input.slug, name: input.name, now });
  if (created === 'slug_taken') throw new ApiError(409, 'conflict');

  const designation = adminDesignationStatements(created.db, { nominee, operatorLoginId: operator.loginId, now });
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
// 6 が失敗すると、管理者のいない組織が残る（一覧の admin_status が none）。運用者が管理者を指名し直して直す
// （organization-admin-reassign）
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

  if (await slugExists(db, input.slug)) throw new ApiError(409, 'conflict');

  const nominee = await githubNominee(db, operator, input.admin, createOrganization.name);

  const now = new Date();
  const created = await operator.insertOrganization({ slug: input.slug, name: input.name, now });
  if (created === 'slug_taken') throw new ApiError(409, 'conflict');

  const designation = adminDesignationStatements(created.db, { nominee, operatorLoginId: operator.loginId, now });
  await writeOrganizationAndAdmin(
    operator,
    created,
    { slug: input.slug, name: input.name, now },
    designation.statements,
  );

  // アカウントが無いと読んだ後に、その人が初めてログインを終えていれば結ぶ（operator-nominee.ts の linkIfLoggedInSince）
  if (nominee.accountId === null) {
    await linkIfLoggedInSince(db, operator, {
      subject: nominee.subject,
      operation: createOrganization.name,
      organizationId: created.organizationId,
    });
  }

  return {
    slug: input.slug,
    name: input.name,
    admin_login_name: nominee.name,
    invite: null,
  };
});
