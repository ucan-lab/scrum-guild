// 組織の作成の最初の書き込み（共通の DB の organizations）。続けて書く最初の管理者の users と change_logs のために、
// 作った組織の組織の中の入口（OrganizationDb）を返す。
// 組織を確かめた結果（VerifiedOrganization）を発行するのは、この関数が organizations に挿入した組織の ID に限る。
// 任意の組織の ID を受けて確かめた結果を発行する関数は、db/ の外へ出さない（index.ts は値を出さない）。
// 共通の表と組織の中の表は別の batch() で書く（docs/data-model.md の「書き込みの単位」）
import { uuidv7 } from '../uuid.ts';
import { commonDb, orgDb, type OrganizationDb } from './entries.ts';
import { issueVerifiedOrganization } from './verify-organization.ts';
import { VOCABULARY_COLUMN_VALUE } from './vocabulary-column.ts';

export type NewOrganization = {
  slug: string;
  name: string;
  // 作った運用者のログインの ID（`github:12345` の形）
  createdByOperator: string;
  now: Date;
};

export type CreatedOrganization = { organizationId: string; db: OrganizationDb };

// 自分で作った組織の created_by_operator に入れる値。運用者のログインの ID（`github:12345` の形）と重ならない
export const SELF_SERVICE_CREATOR = 'self-service';

export type NewSelfCreatedOrganization = {
  slug: string;
  name: string;
  accountId: string;
  now: Date;
};

// 自分で作る組織。お試し中の組織が1つまでの上限に当たれば 'trial_limit'、slug が重なれば 'slug_taken'
export async function insertSelfCreatedOrganization(
  env: Env,
  input: NewSelfCreatedOrganization,
): Promise<CreatedOrganization | 'slug_taken' | 'trial_limit'> {
  const organizationId = uuidv7(input.now.getTime());
  const at = input.now.toISOString();
  const trialEndsOn = new Date(input.now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const common = commonDb(env);
  try {
    // 上限の確かめと INSERT を1文にする。読んでから書くと、同じアカウントの同時の作成が揃って通る
    const [result] = await common.batch([
      common.statement((q) =>
        q
          .insertInto('organizations')
          .columns([
            'id',
            'slug',
            'name',
            'vocabulary',
            'created_by_operator',
            'created_by_account_id',
            'trial_ends_on',
            'created_at',
            'updated_at',
          ])
          .expression(
            q
              .selectNoFrom((eb) => [
                eb.val(organizationId).as('id'),
                eb.val(input.slug).as('slug'),
                eb.val(input.name).as('name'),
                eb.val(VOCABULARY_COLUMN_VALUE).as('vocabulary'),
                eb.val(SELF_SERVICE_CREATOR).as('created_by_operator'),
                eb.val(input.accountId).as('created_by_account_id'),
                eb.val(trialEndsOn).as('trial_ends_on'),
                eb.val(at).as('created_at'),
                eb.val(at).as('updated_at'),
              ])
              .where((eb) =>
                eb.not(
                  eb.exists(
                    eb
                      .selectFrom('organizations')
                      .select('id')
                      .where('created_by_account_id', '=', input.accountId)
                      .where('trial_ends_on', 'is not', null),
                  ),
                ),
              ),
          ),
      ),
    ] as const);
    if (result.changes === 0) return 'trial_limit';
  } catch (err) {
    let existing: { id: string } | undefined;
    try {
      existing = await common.first(
        common.statement((q) => q.selectFrom('organizations').select('id').where('slug', '=', input.slug)),
      );
    } catch {
      throw new Error('slug の行を読み直せなかったので、組織を作れたか分からない', { cause: err });
    }
    if (existing === undefined) throw err;
    if (existing.id !== organizationId) return 'slug_taken';
  }
  return { organizationId, db: orgDb(env, issueVerifiedOrganization(organizationId)) };
}

// insertSelfCreatedOrganization が挿入した組織の行を消す補償。最初の管理者を書けなかったときに、管理者のいない組織と
// お試しの枠が残らないよう戻す。ID と作ったアカウントで絞るので、他の組織の行は消さない。
// 組織の中の表の行が結んでいれば外部キーが断り、例外を投げる（行は残る）
export async function deleteSelfCreatedOrganization(
  env: Env,
  input: { organizationId: string; accountId: string },
): Promise<void> {
  const common = commonDb(env);
  await common.batch([
    common.statement((q) =>
      q
        .deleteFrom('organizations')
        .where('id', '=', input.organizationId)
        .where('created_by_account_id', '=', input.accountId),
    ),
  ] as const);
}

// 言葉づかいの列（vocabulary）には VOCABULARY_COLUMN_VALUE を明示して入れる。
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
          vocabulary: VOCABULARY_COLUMN_VALUE,
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
