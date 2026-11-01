import { createMyOrganization } from '../../shared/operations/organization/index.ts';
import { now } from '../../shared/clock.ts';
import { slugProblem } from '../../shared/organization-slug.ts';
import type { CreatedOrganization } from '../db/index.ts';
import { invalid } from './operator-nominee.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import type { OutsideAccount } from './account.ts';
import { implement } from './implement.ts';

type FirstLogin = { login_provider: string; login_subject: string; login_name: string };

// 作った人を管理者の users の行にし、組織の作成を change_logs に残す。1回の batch() で書くので、失敗すれば2行とも書かれない
async function writeFirstAdmin(
  created: CreatedOrganization,
  organization: { slug: string; name: string; createdAt: Date },
  admin: { accountId: string; login: FirstLogin },
): Promise<void> {
  const userId = uuidv7(organization.createdAt.getTime());
  const at = organization.createdAt.toISOString();
  await created.db.batch([
    created.db.statement((q) =>
      q.insertInto('users').values({
        id: userId,
        organization_id: created.organizationId,
        account_id: admin.accountId,
        login_provider: admin.login.login_provider,
        login_subject: admin.login.login_subject,
        name: admin.login.login_name,
        is_admin: 1,
        created_at: at,
        updated_at: at,
      }),
    ),
    created.db.statement((q) =>
      q.insertInto('change_logs').values({
        id: uuidv7(organization.createdAt.getTime() + 1),
        organization_id: created.organizationId,
        actor_user_id: userId,
        operator: null,
        entity_type: 'organization',
        entity_id: created.organizationId,
        action: 'create',
        changes_json: JSON.stringify({ slug: [null, organization.slug], name: [null, organization.name] }),
        created_at: at,
      }),
    ),
  ]);
}

// 組織の行を戻す。戻せなければ（外部キーが断る、DB が応じない）、管理者のいない組織か、users が書かれた組織が残る。
// 運用者が指名し直して直す（organization-admin-reassign）。補償の失敗で元の例外を隠さないよう、ここでは投げない。
// 例外の message に SQL が混ざりうるので、名前と組織の ID だけをログに残す
async function abandon(account: OutsideAccount, organizationId: string): Promise<void> {
  try {
    await account.abandonOrganization(organizationId);
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        code: 'internal',
        operation: createMyOrganization.name,
        route: 'outside',
        reason: '組織を作ったが、最初の管理者を書けず、組織の行も戻せなかった。管理者のいない組織が残りうる',
        organizationId,
        error: err instanceof Error ? err.name : typeof err,
      }),
    );
  }
}

// 順（docs/data-model.md の「書き込みの単位」）:
//   1. slug の形を確かめる  2. 最も早いログインを読む（無ければ、組織を書く前に止める）
//   3. organizations を書く（上限と slug の重なりはこの文が確かめる）  4. 組織の DB に管理者の users と change_logs を書く
// 4 が失敗したら 3 の行を消す（消せなければログに残して運用者の指名し直しに任せる）
export const createMyOrganizationOperation = implement(
  createMyOrganization,
  async ({ db, accountId, account, input }) => {
    const problem = slugProblem(input.slug);
    if (problem !== undefined) {
      throw invalid(
        'slug',
        problem === 'format' ? 'slug_format' : 'slug_reserved',
        problem === 'format' ? 'slug の形に合わない' : 'アプリが使う名前は slug にできない',
      );
    }

    const login = await db.first(
      db.statement((q) =>
        q
          .selectFrom('account_logins')
          .select(['login_provider', 'login_subject', 'login_name'])
          .where('account_id', '=', accountId)
          .orderBy('created_at')
          .orderBy('login_provider')
          .orderBy('login_subject')
          .limit(1),
      ),
    );
    if (login === undefined) throw new Error('組織を作るアカウントのログインが無い');

    const createdAt = now();
    const created = await account.createOrganization({ slug: input.slug, name: input.name, now: createdAt });
    if (created === 'slug_taken') throw new ApiError(409, 'conflict', { reason: 'slug_taken' });
    if (created === 'trial_limit') throw new ApiError(409, 'conflict', { reason: 'trial_limit' });

    try {
      await writeFirstAdmin(created, { slug: input.slug, name: input.name, createdAt }, { accountId, login });
    } catch (err) {
      await abandon(account, created.organizationId);
      throw err;
    }
    return { slug: input.slug, name: input.name };
  },
);
