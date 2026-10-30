// pnpm bench:backlog: バックログの木（backlog-tree）を 5 万件のタスクで測る（#62 の完了条件。結果は docs/data-model.md の tasks の節）。
// 手元だけで動く。使い捨ての場所（--persist-to の一時ディレクトリ）の D1 に、全マイグレーションと seed を入れ、測る形のワークスペースを足し、
// その D1 で wrangler dev（--local）を立てて、seed の管理者（ミナト）のセッションで API を呼ぶ。手元の開発用の D1 と本番には触らない。
// 形は2つ（どちらも、エピック 50、ストーリー 1,000（800 はエピックの下）、タスクの 8 割はストーリーの下）
//   - 現実の形: 完了 45,000、未完了 5,000
//   - 最悪の形: 未完了 50,000
// 読み方は3つ: 絞らない、担当で絞る（自分）、検索（1% のタスクの題に入る語）。続けて、担当なし、区分、リポジトリ、エピック、
// 当たらない語の検索も測る（索引の選び方で遅くならないかを見る）。読み方ごとに、温める 2 回の後に --runs 回（既定 10）測り、
// 中央値と最大を出す。時間は API の往復（Worker の処理、D1、JSON の組み立てを含む）
// 使い方: node scripts/backlog-bench.ts [--runs 10] [--port 9700]（既定は dev-ports.ts の BENCH_PORTS。デバッガーは既定で 9701、--port を替えたら --port + 1）
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BENCH_PORTS } from './dev-ports.ts';
import { SEED_SESSIONS } from '../seed/sessions.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';

function option(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} には正の整数を渡す`);
  return value;
}

const runs = option('--runs', 10);
const port = option('--port', BENCH_PORTS.api);
const inspectorPort = port + 1;
const origin = `http://localhost:${port}`;

// seed（seed/data.sql）のあおば開発と、その管理者（ミナト）と一般のユーザー（ハルカ）
const ORGANIZATION_ID = '019a0000-0000-7000-8000-000000000201';
const ADMIN_USER_ID = '019a0000-0000-7000-8000-000000000301';
const MEMBER_USER_ID = '019a0000-0000-7000-8000-000000000302';
const AT = '2026-10-01T00:00:00.000Z';

type Shape = { name: string; workspaceId: string; prefix: string; completedPerTen: number };

// 完了の割合は、10 件ごとに completedPerTen 件（現実の形は 9 件で 45,000、最悪の形は 0 件）。続き番号 7 件ずつの塊で決め、
// 担当、リポジトリ、検索の語の振り方（番号の余りで決める）と重ならないようにする
const shapes: Shape[] = [
  { name: '現実の形（完了 45,000、未完了 5,000）', workspaceId: id('1', 1), prefix: '1', completedPerTen: 9 },
  { name: '最悪の形（未完了 50,000）', workspaceId: id('2', 1), prefix: '2', completedPerTen: 0 },
];

// 測る行の ID。形（prefix）と表（kind）ごとに桁をずらし、seed の ID（019a…）とぶつけない
function id(prefix: string, n: number, kind = '0'): string {
  return `019b${prefix}${kind}00-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

// SQL の中で ID を作る式（id() と同じ形）
const sqlId = (prefix: string, kind: string, expr: string) =>
  `printf('019b${prefix}${kind}00-0000-7000-8000-%012d', ${expr})`;

function shapeSql(shape: Shape): string {
  const { workspaceId: ws, prefix } = shape;
  return `
INSERT INTO workspaces (id, organization_id, name, timezone, vocabulary, created_by, created_at, updated_at) VALUES
  ('${ws}', '${ORGANIZATION_ID}', '測る形 ${prefix}', 'Asia/Tokyo', 'game', '${ADMIN_USER_ID}', '${AT}', '${AT}');
INSERT INTO memberships (id, workspace_id, user_id, role, joined_on, joined_at) VALUES
  ('${id(prefix, 1, 'm')}', '${ws}', '${ADMIN_USER_ID}', 'leader', '2026-10-01', '${AT}'),
  ('${id(prefix, 2, 'm')}', '${ws}', '${MEMBER_USER_ID}', 'member', '2026-10-01', '${AT}');
INSERT INTO categories (id, workspace_id, name, is_billed_monthly, position, created_at, updated_at) VALUES
  ('${id(prefix, 1, 'c')}', '${ws}', '保守', 0, 'a0', '${AT}', '${AT}'),
  ('${id(prefix, 2, 'c')}', '${ws}', '追加案件', 1, 'a1', '${AT}', '${AT}');
INSERT INTO repositories (id, workspace_id, name, position, created_at, updated_at) VALUES
  ('${id(prefix, 1, 'r')}', '${ws}', 'shop-api', 'a0', '${AT}', '${AT}'),
  ('${id(prefix, 2, 'r')}', '${ws}', 'shop-web', 'a1', '${AT}', '${AT}');
INSERT INTO epics (id, workspace_id, title, category_id, reward_tier, requester_user_id, created_by, position, created_at, updated_at)
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50)
  SELECT ${sqlId(prefix, 'e', 'i')}, '${ws}', '大きな目標 ' || i,
    CASE WHEN i % 2 = 0 THEN '${id(prefix, 1, 'c')}' END, 'small', '${ADMIN_USER_ID}', '${ADMIN_USER_ID}',
    printf('a0%04dV', i), '${AT}', '${AT}' FROM n;
INSERT INTO stories (id, workspace_id, epic_id, title, category_id, created_by, position, created_at, updated_at)
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
  SELECT ${sqlId(prefix, 's', 'i')}, '${ws}',
    CASE WHEN i <= 800 THEN ${sqlId(prefix, 'e', '(i - 1) % 50 + 1')} END,
    'ひとまとまりの目標 ' || i,
    CASE WHEN i > 800 AND i % 3 = 0 THEN '${id(prefix, 2, 'c')}' END,
    '${ADMIN_USER_ID}', printf('a0%05dV', i), '${AT}', '${AT}' FROM n;
INSERT INTO tasks (id, workspace_id, is_imported, tray, title, story_id, category_id, repository_id, assignee_user_id, points,
    completed_at, completed_by, position, created_by, created_at, updated_at)
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50000)
  SELECT ${sqlId(prefix, 't', 'i')}, '${ws}', 0, 'backlog',
    CASE WHEN i % 97 = 0 THEN '請求書の出力を直す ' || i ELSE 'バックログの作業 ' || i END,
    CASE WHEN i % 5 <> 0 THEN ${sqlId(prefix, 's', '(i - 1) % 1000 + 1')} END,
    CASE WHEN i % 5 = 0 AND i % 7 = 0 THEN '${id(prefix, 1, 'c')}' END,
    CASE WHEN i % 4 = 0 THEN '${id(prefix, 1, 'r')}' END,
    CASE i % 3 WHEN 0 THEN '${ADMIN_USER_ID}' WHEN 1 THEN '${MEMBER_USER_ID}' END,
    CASE i % 5 WHEN 0 THEN NULL WHEN 1 THEN 1 WHEN 2 THEN 2 WHEN 3 THEN 3 ELSE 5 END,
    CASE WHEN (i / 7) % 10 < ${shape.completedPerTen} THEN '${AT}' END,
    CASE WHEN (i / 7) % 10 < ${shape.completedPerTen} THEN '${ADMIN_USER_ID}' END,
    printf('a0%06dV', i), '${ADMIN_USER_ID}', '${AT}', '${AT}' FROM n;
`;
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: ['ignore', 'ignore', 'inherit'] });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.slice(0, 3).join(' ')} が失敗しました`);
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${origin}/api/health`);
      if (res.status < 500) return;
    } catch {
      // 立ち上がるまで待つ
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('wrangler dev が立ち上がらない');
}

const cookie = `${sessionCookieName(origin)}=${SEED_SESSIONS.admin.token}`;

async function call(body: Record<string, unknown>): Promise<{ ms: number; bytes: number }> {
  const started = performance.now();
  const res = await fetch(`${origin}/api/aoba/backlog-tree`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const ms = performance.now() - started;
  if (!res.ok) throw new Error(`backlog-tree が ${res.status} を返した`);
  return { ms, bytes: text.length };
}

// 決まった3つ（絞らない、担当、検索）の後に、ほかの絞り込みも1つずつ測る（索引の選び方で遅くならないかを見るため）
const readings = (shape: Shape): { name: string; input: Record<string, unknown> }[] => [
  { name: '絞らない', input: {} },
  { name: '担当で絞る（自分）', input: { assignee_user_id: 'me' } },
  { name: '検索（請求）', input: { query: '請求' } },
  { name: '担当なし', input: { assignee_user_id: null } },
  { name: '区分で絞る', input: { category_id: id(shape.prefix, 1, 'c') } },
  { name: 'リポジトリで絞る', input: { repository_id: id(shape.prefix, 1, 'r') } },
  { name: 'エピックで絞る', input: { epic_id: id(shape.prefix, 1, 'e') } },
  { name: '検索（当たらない語）', input: { query: '当たらない語' } },
];

// --prepare-only <dir> は、その場所の D1 に測る形を入れて終える（測らず、消さない）。遅い文を
// wrangler d1 execute DB --local --persist-to <dir> --command "EXPLAIN QUERY PLAN ..." で見るのに使う
const prepareIndex = process.argv.indexOf('--prepare-only');
const prepareOnly = prepareIndex === -1 ? undefined : process.argv[prepareIndex + 1];
if (prepareIndex !== -1 && !prepareOnly) throw new Error('--prepare-only に場所を渡す');

const dir = prepareOnly ?? mkdtempSync(path.join(tmpdir(), 'scrum-guild-bench-'));
const persist = ['--local', '--persist-to', dir];
let server: ReturnType<typeof spawn> | undefined;
try {
  console.log('使い捨ての D1 にマイグレーションと seed を入れています');
  run('node', ['scripts/db-seed.ts', '--persist-to', dir]);
  const file = path.join(dir, 'bench.sql');
  writeFileSync(file, shapes.map(shapeSql).join('\n'));
  console.log('測る形（2 つのワークスペース、それぞれ 5 万件）を入れています');
  run('wrangler', ['d1', 'execute', 'DB', ...persist, '--file', file]);
  if (prepareOnly !== undefined) {
    console.log(`${dir} に入れました。ワークスペースの ID は ${shapes.map((shape) => shape.workspaceId).join('、')}`);
    process.exit(0);
  }

  server = spawn(
    'wrangler',
    [
      'dev',
      '--port',
      String(port),
      '--inspector-port',
      String(inspectorPort),
      '--persist-to',
      dir,
      '--var',
      `PUBLIC_ORIGIN:${origin}`,
    ],
    { stdio: 'ignore' },
  );
  await waitForServer();

  for (const shape of shapes) {
    console.log(`\n${shape.name}`);
    for (const reading of readings(shape)) {
      const body = { workspace_id: shape.workspaceId, ...reading.input };
      await call(body);
      await call(body);
      const results: { ms: number; bytes: number }[] = [];
      for (let i = 0; i < runs; i++) results.push(await call(body));
      const sorted = results.map((r) => r.ms).sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)]!;
      const max = sorted[sorted.length - 1]!;
      const kb = Math.round(results[0]!.bytes / 1024);
      console.log(
        `  ${reading.name}: 中央値 ${median.toFixed(0)} ms、最大 ${max.toFixed(0)} ms（応答 ${kb} KB、${runs} 回）`,
      );
    }
  }
} finally {
  // 立てた wrangler dev だけを止める
  server?.kill('SIGTERM');
  if (prepareOnly === undefined) rmSync(dir, { recursive: true, force: true });
}
