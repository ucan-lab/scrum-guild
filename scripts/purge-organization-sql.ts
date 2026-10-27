// 解約した組織のデータを消す SQL を組む（docs/operations.md の「解約した組織のデータを消す」）。
// 人が本番の D1 に `wrangler d1 execute --remote --file` で流す。--file は束縛の値を取れないので、組織の ID を SQL に埋める。
// Workers の実行環境のテスト（test/purge-organization.test.ts）が同じ SQL を流すので、Node の API を使わない。
//
// - どの文にも「その組織が解約で停止していて、消す予定日を過ぎている」の EXISTS を付ける。一時的な停止、停止していない組織、
//   予定日の当日より前の組織、無い ID では何も消えない
// - 外部キーの子から順に消し、organizations の行を最後に消す。途中で失敗しても、同じ SQL を流し直せば続きから消える
// - 共通の表のうち消すのは organizations の行だけ。accounts、account_logins、sessions、oauth_states、rate_limits は消さない
//   （アカウントはほかの組織でも使う。停止したときにセッションは消えている）
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

export function purgeOrganizationSql(organizationId: string): string {
  if (!UUID.test(organizationId)) {
    throw new Error(`組織の ID は小文字の UUID の形で渡す: ${JSON.stringify(organizationId)}`);
  }
  const id = `'${organizationId}'`;
  const guard = `EXISTS (SELECT 1 FROM organizations WHERE id = ${id} AND suspended_at IS NOT NULL AND purge_on IS NOT NULL AND purge_on < date('now'))`;
  const scopeOf = (scope: Scope) =>
    scope === 'organization'
      ? `organization_id = ${id}`
      : `workspace_id IN (SELECT id FROM workspaces WHERE organization_id = ${id})`;
  const statements = [
    ...TABLES.map(([table, scope]) => `DELETE FROM ${table} WHERE ${scopeOf(scope)} AND ${guard};`),
    `DELETE FROM organizations WHERE id = ${id} AND ${guard};`,
  ];
  return [
    `-- 解約した組織 ${organizationId} のデータを消す（docs/operations.md の「解約した組織のデータを消す」）`,
    '-- 解約で停止していて、消す予定日（purge_on）を過ぎた組織だけが消える。途中で失敗したら、このファイルをもう一度流す',
    ...statements,
    '',
  ].join('\n');
}
