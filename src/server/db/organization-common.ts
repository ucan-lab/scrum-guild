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

// 組織の設定のうち、管理者が変えるもの。項目ごとに、先に読んだ値（from）と書く値（to）を持つ。渡した項目だけを書く
export type OrganizationSettingsChange = {
  readonly vocabulary?: { readonly from: Vocabulary; readonly to: Vocabulary };
  readonly theme?: { readonly from: Theme; readonly to: Theme };
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

// 自分の組織の言葉づかいと既定のテーマを、読んだ値のままなら、という条件つきで書く（書く項目ごとの `<列> IS :読んだ値`）。
// 共通の表だけの batch() で送る（変更の記録は組織の中の表なので、呼び出し側が書けたときだけ別の batch() で書く）。
// 書けたら true、読んでから書くまでに別の要求が変えていた（行が変わらなかった）ら false。書く項目が無ければ何も書かず true
export async function writeOrganizationSettings(
  env: Env,
  db: OrganizationDb,
  change: OrganizationSettingsChange,
  now: Date,
): Promise<boolean> {
  const { vocabulary, theme } = change;
  if (vocabulary === undefined && theme === undefined) return true;
  const common = commonDb(env);
  const [result] = await common.batch([
    common.statement((q) => {
      let query = q
        .updateTable('organizations')
        .set({
          ...(vocabulary === undefined ? {} : { vocabulary: vocabulary.to }),
          ...(theme === undefined ? {} : { theme: theme.to }),
          updated_at: now.toISOString(),
        })
        .where('id', '=', db.organizationId);
      if (vocabulary !== undefined) query = query.where('vocabulary', 'is', vocabulary.from);
      if (theme !== undefined) query = query.where('theme', 'is', theme.from);
      return query;
    }),
  ] as const);
  return result.changes > 0;
}

// 自分の組織の users の ID ごとのアバターの URL。組織の中の表（users）を organization_id で絞ってアカウントとログインの手段と ID を引き、
// 共通の表（account_logins）を別の問い合わせで引いて、アプリで合わせる。account_logins の行は、users の行に結んだアカウントの
// ものだけを使う（アカウントに結ばれる前の行は null。手段と ID だけで引くと、管理者が任意の GitHub の人に Scrum Guild の
// アカウントがあるかを知れてしまう）。ログインしたことの無い人と、アバターの無い人も null。別の組織の ID と、存在しない ID はキーを持たない
export async function userAvatarsOf(
  env: Env,
  db: OrganizationDb,
  userIds: readonly string[],
): Promise<Map<string, string | null>> {
  const users: { id: string; linked: LinkedLogin | null }[] = [];
  // 組織の ID も束縛するので、users の ID は上限より1つ少なく区切る
  for (const chunk of chunksOf([...new Set(userIds)], MAX_BOUND_PARAMETERS - 1)) {
    const rows = await db.rows(
      db.statement((q) =>
        q
          .selectFrom('users')
          .select(['id', 'account_id', 'login_provider', 'login_subject'])
          .where('organization_id', '=', db.organizationId)
          .where('id', 'in', chunk),
      ),
    );
    for (const row of rows) {
      // login_subject が空の行は、Google の指名で待っている人（まだログインしていない）
      users.push({
        id: row.id,
        linked:
          row.account_id === null || row.login_subject === null
            ? null
            : { accountId: row.account_id, provider: row.login_provider, subject: row.login_subject },
      });
    }
  }
  const logins = await accountLoginsOf(
    env,
    users.flatMap((user) => (user.linked === null ? [] : [user.linked])),
  );
  return new Map(
    users.map((user) => {
      if (user.linked === null) return [user.id, null];
      const login = logins.get(loginKey(user.linked));
      return [user.id, login !== undefined && login.accountId === user.linked.accountId ? login.avatarUrl : null];
    }),
  );
}

type LinkedLogin = LoginId & { readonly accountId: string };

function loginKey(login: LoginId): string {
  return `${login.provider}:${login.subject}`;
}

function chunksOf<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}

// ログインの手段と ID の組ごとの、結んだアカウントとアバターの URL（account_logins）。キーは loginKey()。
// 手段ごとに login_subject IN (...) で引き、主キー（login_provider, login_subject）の索引に乗せる（OR でつながない）。
// 行の無いログイン（アカウントを消した人など）はキーを持たない
async function accountLoginsOf(
  env: Env,
  logins: readonly LoginId[],
): Promise<Map<string, { accountId: string; avatarUrl: string | null }>> {
  const subjectsByProvider = new Map<string, Set<string>>();
  for (const login of logins) {
    const subjects = subjectsByProvider.get(login.provider) ?? new Set<string>();
    subjects.add(login.subject);
    subjectsByProvider.set(login.provider, subjects);
  }
  const common = commonDb(env);
  const found = new Map<string, { accountId: string; avatarUrl: string | null }>();
  for (const [provider, subjects] of subjectsByProvider) {
    // 手段の値も束縛するので、ID は上限より1つ少なく区切る
    for (const chunk of chunksOf([...subjects], MAX_BOUND_PARAMETERS - 1)) {
      const rows = await common.rows(
        common.statement((q) =>
          q
            .selectFrom('account_logins')
            .select(['login_provider', 'login_subject', 'account_id', 'avatar_url'])
            .where('login_provider', '=', provider)
            .where('login_subject', 'in', chunk),
        ),
      );
      for (const row of rows) {
        found.set(loginKey({ provider: row.login_provider, subject: row.login_subject }), {
          accountId: row.account_id,
          avatarUrl: row.avatar_url,
        });
      }
    }
  }
  return found;
}
