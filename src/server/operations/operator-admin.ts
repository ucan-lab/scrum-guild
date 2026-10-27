// 運用者による管理者の指名し直しの処理（Issue #217。docs/data-model.md の「書き込みの単位」の管理者の指名し直し）。
// 運用者は組織の中に特権を持たない。応答に組織の中のデータ（人の名前など）を入れない
import { organizationAdminReassign } from '../../shared/operations/operator/index.ts';
import { ApiError } from '../errors.ts';
import { implement } from './implement.ts';
import { githubNominee, googleNominee, linkIfLoggedInSince, type CommonDb } from './operator-nominee.ts';

// slug の組織の ID。無ければ 404（別の組織と存在しないものを分けない）。停止中の組織も引く
async function organizationIdOf(db: CommonDb, slug: string): Promise<string> {
  const row = await db.first(db.statement((q) => q.selectFrom('organizations').select('id').where('slug', '=', slug)));
  if (row === undefined) throw new ApiError(404, 'not_found');
  return row.id;
}

// 順:
//   1. 組織を slug で引く（無ければ、GitHub に問い合わせず、招待の URL も作らずに 404）
//   2. GitHub はユーザー名を解決し直して確かめたユーザー ID と一致するか確かめ、アカウントを共通の DB で引く。
//      Google はメールアドレスをそろえ、待つ行と招待の URL の秘密を作る（組織の作成と同じ。operator-nominee.ts）
//   3. 組織の DB に、前の指名の DELETE と指名を1回の batch() で書く（運用者の道具の reassignAdmin。共通の表は混ぜない）。
//      競合は 409
//   4. GitHub でアカウントが無いと読んだ人は、書いた後に account_logins を引き直して結ぶ（組織の作成と同じ）
export const organizationAdminReassignOperation = implement(
  organizationAdminReassign,
  async ({ db, operator, input }) => {
    const organizationId = await organizationIdOf(db, input.slug);
    const now = new Date();

    if (input.admin.provider === 'google') {
      const google = await googleNominee(input.admin.email, now);
      const result = await operator.reassignAdmin(organizationId, { nominee: google.nominee, now });
      if (result === 'conflict') throw new ApiError(409, 'conflict');
      return {
        slug: input.slug,
        admin_login_name: google.email,
        invite: { url: operator.inviteUrl(google.claimToken), expires_at: google.claimExpiresAt },
      };
    }

    const nominee = await githubNominee(db, operator, input.admin, organizationAdminReassign.name);
    const result = await operator.reassignAdmin(organizationId, { nominee, now });
    if (result === 'conflict') throw new ApiError(409, 'conflict');
    if (nominee.accountId === null) {
      await linkIfLoggedInSince(db, operator, {
        subject: nominee.subject,
        operation: organizationAdminReassign.name,
        organizationId,
      });
    }
    return { slug: input.slug, admin_login_name: nominee.name, invite: null };
  },
);
