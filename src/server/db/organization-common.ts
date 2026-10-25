// 組織の中の操作が、組織の道具（src/server/operations/organization-tools.ts）を通して読み書きする共通の表と、
// 共通の表と合わせて読む組織の中の表。
// どの関数も、確かめた組織の入口（OrganizationDb）を受け取り、その organizationId で絞る（組織の ID を引数に取らない）。
// 共通の表と組織の中の表は結合せず、1回の batch() に混ぜない（docs/data-model.md の「データベースの分け方」）
import type { Theme } from '../../shared/theme.ts';
import type { Vocabulary } from '../../shared/vocabulary.ts';
import { commonDb, type OrganizationDb } from './entries.ts';
import type { LoginId } from './enter-organization.ts';
import { MAX_BOUND_PARAMETERS } from './send.ts';

// 組織の行のうち、入るときに引かず、使う操作だけが読むもの
export type OrganizationRow = {
  // organizations.member_limit
  readonly memberLimit: number;
};

// 組織の設定のうち、管理者が変えるもの。渡した項目だけを書く
export type OrganizationSettings = {
  readonly vocabulary?: Vocabulary;
  readonly theme?: Theme;
};

// 自分の組織の行。入ってから読むまでに消えることは無いが、無ければ投げる（組織は消さず停止するだけ）
export async function readOrganizationRow(env: Env, db: OrganizationDb): Promise<OrganizationRow> {
  const common = commonDb(env);
  const row = await common.first(
    common.statement((q) => q.selectFrom('organizations').select('member_limit').where('id', '=', db.organizationId)),
  );
  if (row === undefined) throw new Error('入った組織の行が無い');
  return { memberLimit: row.member_limit };
}

// 自分の組織の言葉づかいと既定のテーマを書く。共通の表だけの batch() で送る（変更の記録は組織の中の表なので別に書く）。
// 書く項目が無ければ何も書かない
export async function writeOrganizationSettings(
  env: Env,
  db: OrganizationDb,
  settings: OrganizationSettings,
  now: Date,
): Promise<void> {
  if (settings.vocabulary === undefined && settings.theme === undefined) return;
  const common = commonDb(env);
  await common.batch([
    common.statement((q) =>
      q
        .updateTable('organizations')
        .set({
          ...(settings.vocabulary === undefined ? {} : { vocabulary: settings.vocabulary }),
          ...(settings.theme === undefined ? {} : { theme: settings.theme }),
          updated_at: now.toISOString(),
        })
        .where('id', '=', db.organizationId),
    ),
  ]);
}

// 自分の組織の users の ID ごとのアバターの URL。組織の中の表（users）を organization_id で絞ってログインの手段と ID を引き、
// 共通の表（account_logins）を別の問い合わせで引いて、アプリで合わせる。ログインしたことの無い人と、アバターの無い人は null。
// 別の組織の ID と、存在しない ID はキーを持たない
export async function userAvatarsOf(
  env: Env,
  db: OrganizationDb,
  userIds: readonly string[],
): Promise<Map<string, string | null>> {
  const users: { id: string; login: LoginId | null }[] = [];
  // 組織の ID も束縛するので、users の ID は上限より1つ少なく区切る
  for (const chunk of chunksOf([...new Set(userIds)], MAX_BOUND_PARAMETERS - 1)) {
    const rows = await db.rows(
      db.statement((q) =>
        q
          .selectFrom('users')
          .select(['id', 'login_provider', 'login_subject'])
          .where('organization_id', '=', db.organizationId)
          .where('id', 'in', chunk),
      ),
    );
    for (const row of rows) {
      // login_subject が空の行は、Google の指名で待っている人（まだログインしていない）
      users.push({
        id: row.id,
        login: row.login_subject === null ? null : { provider: row.login_provider, subject: row.login_subject },
      });
    }
  }
  const avatars = await avatarUrlsOf(
    env,
    users.flatMap((user) => (user.login === null ? [] : [user.login])),
  );
  return new Map(
    users.map((user) => [user.id, user.login === null ? null : (avatars.get(loginKey(user.login)) ?? null)]),
  );
}

function loginKey(login: LoginId): string {
  return `${login.provider}:${login.subject}`;
}

function chunksOf<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}

// ログインの手段と ID の組ごとのアバターの URL（account_logins.avatar_url）。キーは loginKey()。
// 手段ごとに login_subject IN (...) で引き、主キー（login_provider, login_subject）の索引に乗せる（OR でつながない）。
// 行の無いログイン（アカウントを消した人など）はキーを持たない
async function avatarUrlsOf(env: Env, logins: readonly LoginId[]): Promise<Map<string, string | null>> {
  const subjectsByProvider = new Map<string, Set<string>>();
  for (const login of logins) {
    const subjects = subjectsByProvider.get(login.provider) ?? new Set<string>();
    subjects.add(login.subject);
    subjectsByProvider.set(login.provider, subjects);
  }
  const common = commonDb(env);
  const avatars = new Map<string, string | null>();
  for (const [provider, subjects] of subjectsByProvider) {
    // 手段の値も束縛するので、ID は上限より1つ少なく区切る
    for (const chunk of chunksOf([...subjects], MAX_BOUND_PARAMETERS - 1)) {
      const rows = await common.rows(
        common.statement((q) =>
          q
            .selectFrom('account_logins')
            .select(['login_provider', 'login_subject', 'avatar_url'])
            .where('login_provider', '=', provider)
            .where('login_subject', 'in', chunk),
        ),
      );
      for (const row of rows) {
        avatars.set(loginKey({ provider: row.login_provider, subject: row.login_subject }), row.avatar_url);
      }
    }
  }
  return avatars;
}
