// 解約した組織のデータを消す SQL（scripts/purge-organization-sql.ts、docs/operations.md の「解約した組織のデータを消す」）を、
// 人が1文ずつ `wrangler d1 execute --command` で流すのと同じく、テストの D1 に1文ずつ順に流して確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { purgeOrganizationCountSql, purgeOrganizationSql } from '../scripts/purge-organization-sql.ts';
import {
  firstRowForTest,
  listAppTables,
  runStatementsForTest,
  sqlLines,
  tableRowsForTest,
} from '../src/server/db/testing.ts';
import {
  AT,
  createAccount,
  createAccountLogin,
  createBoardColumn,
  createCategory,
  createChangeLog,
  createComment,
  createCompletion,
  createDetailField,
  createEpic,
  createEpicPartyMember,
  createInvitation,
  createMembership,
  createOrganization,
  createOrganizationHoliday,
  createRepository,
  createSession,
  createSprint,
  createSprintEntry,
  createStory,
  createTask,
  createThanks,
  createUser,
  createWorkspace,
  createWorkspacePointRate,
  createXpGrant,
  uuidv7,
} from './factories.ts';

// 消さない共通の表。organizations は組織の行を最後に消す
const KEPT_COMMON_TABLES = [
  'accounts',
  'account_logins',
  'sessions',
  'api_tokens',
  'oauth_states',
  'rate_limits',
  'password_credentials',
  'account_consents',
];

// purge_on に入れる UTC の日付。消す SQL の条件は SQL の date('now') と比べる。ここで日付を作ってから SQL を流すまでに
// UTC の0時をまたぐと、SQL の今日は1日進む。前日（-1）と翌日（1）は、またいでも条件の当たり外れが変わらない
const DAY = 24 * 60 * 60 * 1000;
const dateOf = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

// 消す予定日を過ぎた解約の組織
const EXPIRED = () => ({ suspended_at: AT, purge_on: dateOf(-31) });

// 組織の中のすべての表に1行以上入れる。外部キーをできるだけ張り、子から順に消さないと落ちる形にする。
// accountId は、この組織の人が結ぶアカウント（ほかの組織でも使うので、消えないことを確かめる）
async function fillOrganization(organization: Awaited<ReturnType<typeof createOrganization>>, accountId: string) {
  const admin = await createUser(organization, { account_id: accountId, is_admin: 1 });
  const member = await createUser(organization);
  const workspace = await createWorkspace(organization, admin.id);
  const ws = workspace.id;
  await createWorkspacePointRate(organization, ws);
  await createMembership(organization, ws, admin.id, { role: 'leader' });
  await createMembership(organization, ws, member.id);
  await createInvitation(organization, ws, admin.id, { provider: 'github', subject: String(Date.now()) });
  const column = await createBoardColumn(organization, ws);
  await createDetailField(organization, ws);
  const category = await createCategory(organization, ws);
  const repository = await createRepository(organization, ws);
  const epic = await createEpic(organization, ws, admin.id, { category_id: category.id });
  const story = await createStory(organization, ws, admin.id, { epic_id: epic.id, category_id: category.id });
  const sprint = await createSprint(organization, ws, { started_by: admin.id });
  const task = await createTask(organization, ws, admin.id, {
    story_id: story.id,
    category_id: category.id,
    repository_id: repository.id,
    sprint_id: sprint.id,
    column_id: column.id,
    column_position: 'a0',
    assignee_user_id: member.id,
  });
  await createSprintEntry(organization, ws, sprint.id, task.id, admin.id);
  // 討伐隊は workspace_id を持たず、エピックを通して組織に結ぶ
  await createEpicPartyMember(organization, epic.id, member.id, { added_by: admin.id });
  await createThanks(organization, ws, task.id, admin.id, member.id);
  const completion = await createCompletion(organization, ws, task.id, member.id, {
    sprint_id: sprint.id,
    previous_column_id: column.id,
    category_id: category.id,
    assignee_user_id: member.id,
  });
  const grant = await createXpGrant(organization, ws, member.id, {
    action: 'task_completed',
    task_id: task.id,
    story_id: story.id,
    epic_id: epic.id,
    completion_id: completion.id,
  });
  await createXpGrant(organization, ws, member.id, {
    action: 'task_completed',
    task_id: task.id,
    amount: -10,
    reverses_grant_id: grant.id,
  });
  await createComment(organization, ws, task.id, member.id);
  await createChangeLog(organization, {
    workspace_id: ws,
    actor_user_id: admin.id,
    entity_type: 'task',
    entity_id: task.id,
    action: 'create',
  });
  await createChangeLog(organization);
  await createOrganizationHoliday(organization, admin.id);
}

// すべての表の、すべての行。比べると、行数だけでなく、残った行がどの組織のものかまで分かる
async function snapshot(): Promise<Record<string, unknown[]>> {
  const rows: Record<string, unknown[]> = {};
  for (const table of await listAppTables(env)) rows[table] = await tableRowsForTest(env, table);
  return rows;
}

async function purge(organizationId: string) {
  await runStatementsForTest(env, sqlLines(purgeOrganizationSql(organizationId)));
}

// 手順書が流す前と流した後に数える文の結果
async function counts(organizationId: string) {
  return (await firstRowForTest(env, purgeOrganizationCountSql(organizationId)))!;
}

// ほかの組織と、両方の組織の人が結ぶアカウント（とログインの手段とセッション）を作る
async function otherOrganizationAndAccount(overrides: Parameters<typeof createOrganization>[0] = {}) {
  const account = await createAccount({ last_login_at: AT });
  await createAccountLogin(account.id);
  await createSession(account.id);
  await fillOrganization(await createOrganization(overrides), account.id);
  return { account };
}

describe('purge-organization（解約した組織のデータを消す SQL）', () => {
  test('解約で停止して消す予定日を過ぎた組織の行だけがすべて消え、ほかの組織とアカウントの行は残る', async () => {
    const { account } = await otherOrganizationAndAccount();
    const before = await snapshot();

    const target = await createOrganization({ suspended_at: AT, purge_on: dateOf(-1) });
    await fillOrganization(target, account.id);
    const filled = await snapshot();
    // 消す組織が、消さない共通の表を除くすべての表に行を足した
    for (const table of Object.keys(before)) {
      if (KEPT_COMMON_TABLES.includes(table)) continue;
      expect(filled[table]!.length, table).toBeGreaterThan(before[table]!.length);
    }

    await purge(target.id);

    // 表ごとの行が、消す組織を作る前とまったく同じに戻る（ほかの組織の行とアカウントは変わらずに残る）
    expect(await snapshot()).toEqual(before);
  });

  test('2回流しても誤りにならず、途中で止まった後に同じ順で流し直すと続きから消える', async () => {
    const { account } = await otherOrganizationAndAccount();
    const before = await snapshot();
    const target = await createOrganization(EXPIRED());
    await fillOrganization(target, account.id);

    // 途中（タスクを消した後）で止まった形を作る
    const statements = sqlLines(purgeOrganizationSql(target.id));
    const half = statements.findIndex((statement) => statement.startsWith('DELETE FROM stories '));
    expect(half).toBeGreaterThan(0);
    await runStatementsForTest(env, statements.slice(0, half));

    await purge(target.id);
    expect(await snapshot()).toEqual(before);
    await purge(target.id);
    expect(await snapshot()).toEqual(before);
  });

  // 「今日」は、組織を作ってから SQL を流すまでに UTC の0時をまたぐと、SQL の今日が翌日になって消える側に倒れ、落ちうる。
  // 境目そのものを確かめるケースなので残す（またぐのは0時の前後の数十ミリ秒に流したときだけ）
  const guarded: [string, () => Parameters<typeof createOrganization>[0]][] = [
    ['停止していない', () => ({})],
    ['一時的な停止の', () => ({ suspended_at: AT, purge_on: null })],
    ['消す予定日が今日の', () => ({ suspended_at: AT, purge_on: dateOf(0) })],
    ['消す予定日が明日の', () => ({ suspended_at: AT, purge_on: dateOf(1) })],
    ['予定日はあるが停止していない', () => ({ suspended_at: null, purge_on: dateOf(-1) })],
  ];
  for (const [label, overrides] of guarded) {
    // ほかの組織を、消す予定日を過ぎた解約の組織にする。条件が渡した ID の組織を見ずに「どれかの組織が消してよい」を
    // 確かめる形に崩れると、渡した組織の行が消えて落ちる
    test(`${label}組織では、消す予定日を過ぎた解約のほかの組織がいても、どちらの組織も1行も消えない`, async () => {
      const { account } = await otherOrganizationAndAccount(EXPIRED());
      const target = await createOrganization(overrides());
      await fillOrganization(target, account.id);
      const before = await snapshot();

      await purge(target.id);

      expect(await snapshot()).toEqual(before);
    });
  }

  test('無い組織の ID では、消す予定日を過ぎた解約のほかの組織がいても1行も消えない', async () => {
    await otherOrganizationAndAccount(EXPIRED());
    const before = await snapshot();

    await purge(uuidv7());

    expect(await snapshot()).toEqual(before);
  });

  test('数える文は、停止の状態と表ごとの行の数を返し、流した後はすべて 0 になる', async () => {
    const { account } = await otherOrganizationAndAccount(EXPIRED());
    const target = await createOrganization({ suspended_at: AT, purge_on: dateOf(-1) });
    await fillOrganization(target, account.id);

    const before = await counts(target.id);
    const { slug, suspended_at, purge_on, ...beforeCounts } = before;
    // 手順書は slug を、手順 1 で一覧から控えた slug と見比べ、ID の取り違えに気づく
    expect({ slug, suspended_at, purge_on }).toEqual({ slug: target.slug, suspended_at: AT, purge_on: dateOf(-1) });
    expect(beforeCounts.organizations).toBe(1);
    for (const [column, count] of Object.entries(beforeCounts)) expect(count, column).toBeGreaterThan(0);

    // 途中で止まると、organizations は 1 のまま、ほかのどれかが減る
    const statements = sqlLines(purgeOrganizationSql(target.id));
    await runStatementsForTest(env, statements.slice(0, 1));
    const halfway = await counts(target.id);
    expect(halfway.organizations).toBe(1);
    expect(halfway).not.toEqual(before);

    await purge(target.id);
    const after = await counts(target.id);
    expect(after).toEqual({
      ...Object.fromEntries(Object.keys(beforeCounts).map((column) => [column, 0])),
      slug: null,
      suspended_at: null,
      purge_on: null,
    });
  });

  test('組織の中のすべての表を消し、数える（表を足して消す文や数える列を足し忘れると落ちる）', async () => {
    const id = uuidv7();
    const statements = sqlLines(purgeOrganizationSql(id));
    const deleted = statements.map((statement) => /^DELETE FROM (\w+) /.exec(statement)?.[1]);
    const organizationTables = (await listAppTables(env)).filter(
      (table) => table !== 'organizations' && !KEPT_COMMON_TABLES.includes(table),
    );

    expect(deleted).not.toContain(undefined);
    expect(new Set(deleted).size).toBe(deleted.length);
    expect([...deleted].sort()).toEqual([...organizationTables, 'organizations'].sort());
    expect(deleted.at(-1)).toBe('organizations');

    const counted = Object.keys((await counts(id))!);
    expect(counted.sort()).toEqual([...organizationTables, 'organizations', 'slug', 'suspended_at', 'purge_on'].sort());
  });
});
