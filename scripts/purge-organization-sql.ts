// 解約した組織のデータを消す SQL を組む（docs/operations.md の「解約した組織のデータを消す」）。
// 人が本番の D1 に、1文ずつ `wrangler d1 execute --remote --command` で流す。`--file` は取り込みの API を使い、流している間は
// D1 全体がクエリに答えなくなるので使わない。`--command` は束縛の値を取れないので、組織の ID を SQL に埋める。
// Workers の実行環境のテスト（test/purge-organization.test.ts）が同じ SQL を流すので、Node の API を使わない。
//
// - 1文を1行に書く。行は手順書の `--command "<文>"` にそのまま入るよう、`"`、`$`、`` ` ``、`\`、`!` を含めない（scripts/purge-organization.test.ts）
// - どの文にも「その組織が解約で停止していて、消す予定日を過ぎている」の EXISTS を付ける。一時的な停止、停止していない組織、
//   予定日の当日より前の組織、無い ID では何も消えない
// - 外部キーの子から順に消し、organizations の行を最後に消す。途中で止まっても、同じ順で流し直せば続きから消える
// - 共通の表のうち消すのは organizations の行だけ。accounts、account_logins、sessions、oauth_states、rate_limits は消さない
//   （アカウントはほかの組織でも使う。アカウントをどうするかは #407。セッションはアカウントに結ぶ。入れる組織を失った人の
//   セッションは、その人の次のリクエストか期限切れで消える）
// - 共通の表（organizations）を組織の中の表の文から引く。DB を1つにしている今だけの書き方で、組織ごとに DB を分けるときは
//   ガードの確かめを共通の DB で先に行う形に直す（docs/data-model.md の「データベースの分け方」）
// - 組織の中の表を足したら、ここに消す文を足す。足し忘れると test/purge-organization.test.ts が落ちる

// UUID の形（小文字の16進）。組織の ID は小文字で作る（src/server/uuid.ts）
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// 組織で絞る条件の形
type Scope = 'organization' | 'workspace';

// 外部キーの子から順。xp_grants は自分の表を指す（reverses_grant_id）が、1文で組織の行をまとめて消すので、文の終わりの検査に当たらない
const TABLES: readonly (readonly [table: string, scope: Scope])[] = [
  ['xp_grants', 'workspace'],
  ['comments', 'workspace'],
  ['completions', 'workspace'],
  ['change_logs', 'organization'],
  ['organization_holidays', 'organization'],
  ['tasks', 'workspace'],
  ['stories', 'workspace'],
  ['epics', 'workspace'],
  ['sprints', 'workspace'],
  ['board_columns', 'workspace'],
  ['detail_fields', 'workspace'],
  ['categories', 'workspace'],
  ['repositories', 'workspace'],
  ['invitations', 'workspace'],
  ['memberships', 'workspace'],
  ['workspace_point_rates', 'workspace'],
  ['workspaces', 'organization'],
  ['users', 'organization'],
];

function quotedId(organizationId: string): string {
  if (!UUID.test(organizationId)) {
    throw new Error(`組織の ID は小文字の UUID の形で渡す: ${JSON.stringify(organizationId)}`);
  }
  return `'${organizationId}'`;
}

function scopeOf(scope: Scope, id: string): string {
  return scope === 'organization'
    ? `organization_id = ${id}`
    : `workspace_id IN (SELECT id FROM workspaces WHERE organization_id = ${id})`;
}

// 消す文。外部キーの子から順に並び、最後が organizations の行
export function purgeOrganizationStatements(organizationId: string): string[] {
  const id = quotedId(organizationId);
  const guard = `EXISTS (SELECT 1 FROM organizations WHERE id = ${id} AND suspended_at IS NOT NULL AND purge_on IS NOT NULL AND purge_on < date('now'))`;
  return [
    ...TABLES.map(([table, scope]) => `DELETE FROM ${table} WHERE ${scopeOf(scope, id)} AND ${guard}`),
    `DELETE FROM organizations WHERE id = ${id} AND ${guard}`,
  ];
}

// 消す文を1行に1文で書いたもの（コメントの行は無い）。手順書はこの行を1つずつ `--command` で流す
export function purgeOrganizationSql(organizationId: string): string {
  return `${purgeOrganizationStatements(organizationId).join('\n')}\n`;
}

// 残りを数える1行の SELECT。組織の slug と停止の状態（suspended_at、purge_on）と、organizations と消す表ごとの、その組織の行の数を返す。
// 流す前と流した後に同じ文で数え、比べて判定する。slug は、一覧から控えた slug と見比べて ID の取り違えに気づくため
// （docs/operations.md の「解約した組織のデータを消す」）
export function purgeOrganizationCountSql(organizationId: string): string {
  const id = quotedId(organizationId);
  const columns = [
    `(SELECT slug FROM organizations WHERE id = ${id}) AS slug`,
    `(SELECT suspended_at FROM organizations WHERE id = ${id}) AS suspended_at`,
    `(SELECT purge_on FROM organizations WHERE id = ${id}) AS purge_on`,
    `(SELECT count(*) FROM organizations WHERE id = ${id}) AS organizations`,
    ...TABLES.map(([table, scope]) => `(SELECT count(*) FROM ${table} WHERE ${scopeOf(scope, id)}) AS ${table}`),
  ];
  return `SELECT ${columns.join(', ')}\n`;
}
