// 組織の作成の最初の書き込み（共通の DB の organizations）。続けて書く最初の管理者の users と change_logs のために、
// 作った組織の組織の中の入口（OrganizationDb）を返す。
// 組織を確かめた結果（VerifiedOrganization）を発行するのは、この関数が organizations に挿入した組織の ID に限る。
// 任意の組織の ID を受けて確かめた結果を発行する関数は、db/ の外へ出さない（index.ts は値を出さない）。
// 共通の表と組織の中の表は別の batch() で書く（docs/data-model.md の「書き込みの単位」）
import { defaultVocabularies } from '../../shared/vocabulary.ts';
import { uuidv7 } from '../uuid.ts';
import { commonDb, orgDb, type OrganizationDb } from './entries.ts';
import { issueVerifiedOrganization } from './verify-organization.ts';

export type NewOrganization = {
  slug: string;
  name: string;
  // 作った運用者のログインの ID（`github:12345` の形）
  createdByOperator: string;
  now: Date;
};

export type CreatedOrganization = { organizationId: string; db: OrganizationDb };

// 言葉づかいは画面の既定（defaultVocabularies）で作る（列の既定は 'game' のままで、マイグレーションは足すだけのため、ここで明示する）。
// 人数と添付ファイルの上限、テーマは列の既定の値で作る。
// slug が重なったときは 'slug_taken'（同時に作られて UNIQUE に当たった場合を含む）。それ以外の失敗は投げる
export async function insertOrganization(
  env: Env,
  input: NewOrganization,
): Promise<CreatedOrganization | 'slug_taken'> {
  const organizationId = uuidv7(input.now.getTime());
  const at = input.now.toISOString();
  const common = commonDb(env);
  try {
    await common.batch([
      common.statement((q) =>
        q.insertInto('organizations').values({
          id: organizationId,
          slug: input.slug,
          name: input.name,
          vocabulary: defaultVocabularies.organization,
          created_by_operator: input.createdByOperator,
          created_at: at,
          updated_at: at,
        }),
      ),
    ]);
  } catch (err) {
    // UNIQUE に当たったかは例外の文面でなく、slug の行を読み直して見分ける。
    // 自分の INSERT がコミットされた後に応答だけ失敗した場合は、行の ID が自分の ID なので、成功として続ける
    let existing: { id: string } | undefined;
    try {
      existing = await common.first(
        common.statement((q) => q.selectFrom('organizations').select('id').where('slug', '=', input.slug)),
      );
    } catch {
      // 読み直せないときは、重なりとも成功とも言えない。元の例外を cause に残して投げる
      throw new Error('slug の行を読み直せなかったので、組織を作れたか分からない', { cause: err });
    }
    if (existing === undefined) throw err;
    if (existing.id !== organizationId) return 'slug_taken';
  }
  return { organizationId, db: orgDb(env, issueVerifiedOrganization(organizationId)) };
}
