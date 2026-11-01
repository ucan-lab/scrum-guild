import { createMyOrganization } from '../../shared/operations/organization/index.ts';
import { now } from '../../shared/clock.ts';
import { slugProblem } from '../../shared/organization-slug.ts';
import { invalid } from './operator-nominee.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';

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

    const createdAt = now();
    const created = await account.createOrganization({ slug: input.slug, name: input.name, now: createdAt });
    if (created === 'slug_taken') throw new ApiError(409, 'conflict', { reason: 'slug_taken' });
    if (created === 'trial_limit') throw new ApiError(409, 'conflict', { reason: 'trial_limit' });

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

    const userId = uuidv7(createdAt.getTime());
    const at = createdAt.toISOString();
    await created.db.batch([
      created.db.statement((q) =>
        q.insertInto('users').values({
          id: userId,
          organization_id: created.organizationId,
          account_id: accountId,
          login_provider: login.login_provider,
          login_subject: login.login_subject,
          name: login.login_name,
          is_admin: 1,
          created_at: at,
          updated_at: at,
        }),
      ),
      created.db.statement((q) =>
        q.insertInto('change_logs').values({
          id: uuidv7(createdAt.getTime() + 1),
          organization_id: created.organizationId,
          actor_user_id: userId,
          operator: null,
          entity_type: 'organization',
          entity_id: created.organizationId,
          action: 'create',
          changes_json: JSON.stringify({ slug: [null, input.slug], name: [null, input.name] }),
          created_at: at,
        }),
      ),
    ]);
    return { slug: input.slug, name: input.name };
  },
);
