import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { deploy, PRODUCTION_URL, type DeployDeps, type WranglerResult } from './deploy.ts';

const SHA = 'abc1234';
const CURRENT = 'version-current';

const ok = (stdout = ''): WranglerResult => ({ status: 0, stdout, stderr: '' });
const fail = (stderr = ''): WranglerResult => ({ status: 1, stdout: '', stderr });
const statusOf = (versions: unknown): WranglerResult => ok(JSON.stringify({ versions }));
const status100 = statusOf([{ version_id: CURRENT, percentage: 100 }]);
const noWorker = fail('X [ERROR] A request to the Cloudflare API failed. [code: 10007]');

type Fake = {
  deps: DeployDeps;
  calls: string[][];
  fetches: number;
  // 煙のテストの各回の開始時刻と打ち切りの時間
  attempts: { at: number; timeoutMs: number }[];
  logs: string[];
  errors: string[];
  clock: () => number;
};

// wrangler の呼び出しは引数の先頭の語で答えを返す。deployments status は statuses を呼ばれた順に返し、
// 尽きたら wrangler.status（無ければ CURRENT が 100%）を返す。版は versions を順に返し、尽きたら最後の値を返し続ける。
// fetchMs は1回の問い合わせにかかる時間
function fake(options: {
  inWorkersBuilds?: boolean;
  commitSha?: string | undefined;
  wrangler?: Partial<Record<'status' | 'bookmark' | 'apply' | 'deploy' | 'rollback', WranglerResult>>;
  statuses?: WranglerResult[];
  hasMigrations?: boolean;
  versions?: (string | Error)[];
  fetchMs?: number;
}): Fake {
  const calls: string[][] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  let clock = 0;
  let statusCalls = 0;
  const versions = options.versions ?? [SHA];
  const result: Fake = {
    calls,
    logs,
    errors,
    fetches: 0,
    attempts: [],
    clock: () => clock,
    deps: {
      inWorkersBuilds: options.inWorkersBuilds ?? true,
      commitSha: 'commitSha' in options ? options.commitSha : SHA,
      wrangler: (args) => {
        calls.push(args);
        const w = options.wrangler ?? {};
        if (args[0] === 'deployments') return options.statuses?.[statusCalls++] ?? w.status ?? status100;
        if (args[1] === 'time-travel') return w.bookmark ?? ok('{"bookmark":"b-1"}');
        if (args[1] === 'migrations') return w.apply ?? ok();
        if (args[0] === 'deploy') return w.deploy ?? ok();
        if (args[0] === 'rollback') return w.rollback ?? ok();
        throw new Error(`想定外の wrangler の呼び出し: ${args.join(' ')}`);
      },
      hasMigrations: () => options.hasMigrations ?? false,
      fetchVersion: async (url, timeoutMs) => {
        assert.equal(url, `${PRODUCTION_URL}/api/health`);
        result.attempts.push({ at: clock, timeoutMs });
        clock += Math.min(options.fetchMs ?? 0, timeoutMs);
        const value = versions[Math.min(result.fetches, versions.length - 1)];
        result.fetches++;
        if (value instanceof Error) throw value;
        return value!;
      },
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
    },
  };
  return result;
}

const commands = (calls: string[][]) => calls.map((args) => args.slice(0, 2).join(' '));
const lastCall = (f: Fake) => f.calls.at(-1)?.slice(0, 2);

describe('deploy', () => {
  test('マイグレーションが無ければ、戻し先を控えて版を上げ、煙のテストで成功する', async () => {
    const f = fake({});
    assert.equal(await deploy(f.deps), 0);
    assert.deepEqual(commands(f.calls), [
      'deployments status',
      'deployments status',
      'deploy --var',
      'deployments status',
    ]);
    assert.deepEqual(f.calls[0], ['deployments', 'status', '--json']);
    assert.deepEqual(f.calls[2], ['deploy', '--var', `APP_VERSION:${SHA}`, '--message', SHA]);
    // 障害のときに頼るログの行
    assert.ok(f.logs.includes(`戻し先の版: ${CURRENT}`));
    assert.ok(f.logs.some((message) => message.startsWith('煙のテスト: 1回目で版が一致しました')));
  });

  test('マイグレーションがあれば、ブックマークを取ってから当て、その後に版を上げる', async () => {
    const f = fake({ hasMigrations: true });
    assert.equal(await deploy(f.deps), 0);
    assert.deepEqual(commands(f.calls), [
      'deployments status',
      'd1 time-travel',
      'd1 migrations',
      'deployments status',
      'deploy --var',
      'deployments status',
    ]);
    assert.deepEqual(f.calls[1], ['d1', 'time-travel', 'info', 'DB', '--json']);
    assert.deepEqual(f.calls[2], ['d1', 'migrations', 'apply', 'DB', '--remote']);
    assert.ok(f.logs.includes('マイグレーションを当てる前の Time Travel のブックマーク: {"bookmark":"b-1"}'));
  });

  test('Workers Builds の外では、wrangler を1つも呼ばずに失敗する', async () => {
    const f = fake({ inWorkersBuilds: false });
    assert.equal(await deploy(f.deps), 1);
    assert.deepEqual(f.calls, []);
  });

  test('WORKERS_CI_COMMIT_SHA が無いかコミットの SHA の形でなければ、wrangler を1つも呼ばずに失敗する', async () => {
    for (const commitSha of [undefined, '', 'dev', 'main', 'ABC1234', 'abc12', 'abc1234 --remote']) {
      const f = fake({ commitSha });
      assert.equal(await deploy(f.deps), 1, String(commitSha));
      assert.deepEqual(f.calls, []);
    }
  });

  test('Worker が無い（10007）なら、戻し先無しで出して成功する', async () => {
    const f = fake({ wrangler: { status: noWorker } });
    assert.equal(await deploy(f.deps), 0);
    assert.deepEqual(commands(f.calls).slice(0, 3), ['deployments status', 'deployments status', 'deploy --var']);
    assert.ok(f.logs.includes('戻し先の版はありません（初回）'));
  });

  test('Worker にデプロイが1つも無ければ、戻し先無しで出す', async () => {
    const f = fake({ wrangler: { status: fail('The Worker scrum-guild has no deployments.') } });
    assert.equal(await deploy(f.deps), 0);
  });

  test('10007 以外のエラーで今の版を取れなければ、wrangler の出力を添えて本番に触らずに失敗する', async () => {
    const f = fake({ hasMigrations: true, wrangler: { status: fail('Authentication error [code: 10000]') } });
    assert.equal(await deploy(f.deps), 1);
    assert.deepEqual(commands(f.calls), ['deployments status']);
    assert.ok(f.errors.some((message) => message.includes('Authentication error')));
  });

  test('今の版の JSON の形が崩れていれば、本番に触らずに失敗する', async () => {
    for (const stdout of ['not json', 'null', '{}', '{"versions":{}}']) {
      const f = fake({ wrangler: { status: ok(stdout) } });
      assert.equal(await deploy(f.deps), 1, stdout);
      assert.deepEqual(commands(f.calls), ['deployments status']);
    }
  });

  test('今の版が 100% で動く1つでなければ、本番に触らずに失敗する', async () => {
    const cases = [
      [
        { version_id: 'a', percentage: 90 },
        { version_id: 'b', percentage: 10 },
      ],
      [],
      [{ version_id: 'a', percentage: 90 }],
      [{ percentage: 100 }],
    ];
    for (const versions of cases) {
      const f = fake({ hasMigrations: true, wrangler: { status: statusOf(versions) } });
      assert.equal(await deploy(f.deps), 1, JSON.stringify(versions));
      assert.deepEqual(commands(f.calls), ['deployments status']);
    }
  });

  test('ブックマークを取れなければ、マイグレーションを当てずに失敗する', async () => {
    const f = fake({ hasMigrations: true, wrangler: { bookmark: fail() } });
    assert.equal(await deploy(f.deps), 1);
    assert.deepEqual(commands(f.calls), ['deployments status', 'd1 time-travel']);
  });

  test('マイグレーションに失敗したら、版を上げずに失敗する', async () => {
    const f = fake({ hasMigrations: true, wrangler: { apply: fail() } });
    assert.equal(await deploy(f.deps), 1);
    assert.deepEqual(commands(f.calls), ['deployments status', 'd1 time-travel', 'd1 migrations']);
  });

  test('控えた後に別のデプロイで版が変わっていれば、版を上げずに失敗する', async () => {
    const other = statusOf([{ version_id: 'version-other', percentage: 100 }]);
    const f = fake({ statuses: [status100, other] });
    assert.equal(await deploy(f.deps), 1);
    assert.deepEqual(commands(f.calls), ['deployments status', 'deployments status']);
  });

  test('版を上げる直前に今の版を取れなければ、版を上げずに失敗する', async () => {
    const f = fake({ statuses: [status100, fail('network')] });
    assert.equal(await deploy(f.deps), 1);
    assert.deepEqual(commands(f.calls), ['deployments status', 'deployments status']);
  });

  test('版を上げられず、版が切り替わっていなければ、煙のテストも rollback もせずに失敗する', async () => {
    const f = fake({ wrangler: { deploy: fail() } });
    assert.equal(await deploy(f.deps), 1);
    assert.equal(f.fetches, 0);
    assert.deepEqual(commands(f.calls), [
      'deployments status',
      'deployments status',
      'deploy --var',
      'deployments status',
    ]);
  });

  test('初回に版を上げられず、デプロイが無いままなら rollback せずに失敗する', async () => {
    const f = fake({ wrangler: { status: noWorker, deploy: fail() } });
    assert.equal(await deploy(f.deps), 1);
    assert.ok(!f.calls.some((args) => args[0] === 'rollback'));
  });

  test('初回に wrangler deploy が落ちたが版は切り替わっていたら、戻し先が無いので壊れた版が残っていると書く', async () => {
    const switched = statusOf([{ version_id: 'version-new', percentage: 100 }]);
    const f = fake({ wrangler: { status: noWorker, deploy: fail() }, statuses: [noWorker, noWorker, switched] });
    assert.equal(await deploy(f.deps), 1);
    assert.ok(!f.calls.some((args) => args[0] === 'rollback'));
    assert.ok(f.errors.some((message) => message.includes('壊れた版が残っています')));
  });

  test('版を 100% に切り替えた後で wrangler deploy が落ちたら、控えた版へ戻す', async () => {
    const switched = statusOf([{ version_id: 'version-new', percentage: 100 }]);
    const f = fake({ wrangler: { deploy: fail() }, statuses: [status100, status100, switched] });
    assert.equal(await deploy(f.deps), 1);
    assert.deepEqual(lastCall(f), ['rollback', CURRENT]);
  });

  test('wrangler deploy が落ち、切り替わったか確かめられなければ、控えた版へ戻す', async () => {
    const f = fake({ wrangler: { deploy: fail() }, statuses: [status100, status100, fail('network')] });
    assert.equal(await deploy(f.deps), 1);
    assert.deepEqual(lastCall(f), ['rollback', CURRENT]);
  });

  test('煙のテストに落ちたら、控えた版の ID を指定して戻し、失敗する', async () => {
    const f = fake({ versions: [CURRENT] });
    assert.equal(await deploy(f.deps), 1);
    assert.deepEqual(lastCall(f), ['rollback', CURRENT]);
    assert.ok(f.calls.at(-1)!.includes('--message'));
  });

  test('煙のテストの間に別のデプロイが版を上げていれば、それを潰さないよう戻さずに失敗する', async () => {
    const own = statusOf([{ version_id: 'version-own', percentage: 100 }]);
    const other = statusOf([{ version_id: 'version-other', percentage: 100 }]);
    const f = fake({ versions: ['def5678'], statuses: [status100, status100, own, other] });
    assert.equal(await deploy(f.deps), 1);
    assert.ok(!f.calls.some((args) => args[0] === 'rollback'));
    assert.ok(f.errors.some((message) => message.includes('version-other')));
  });

  test('煙のテストに落ちたとき、本番が上げた版のままなら戻す', async () => {
    const own = statusOf([{ version_id: 'version-own', percentage: 100 }]);
    const f = fake({ versions: [CURRENT], statuses: [status100, status100, own, own] });
    assert.equal(await deploy(f.deps), 1);
    assert.deepEqual(lastCall(f), ['rollback', CURRENT]);
  });

  test('マイグレーションを当てた後に煙のテストに落ちても、戻すのはコードだけ', async () => {
    const f = fake({ hasMigrations: true, versions: [CURRENT] });
    assert.equal(await deploy(f.deps), 1);
    const writes = commands(f.calls).filter((command) => command !== 'deployments status');
    assert.deepEqual(writes, ['d1 time-travel', 'd1 migrations', 'deploy --var', `rollback ${CURRENT}`]);
  });

  test('戻せなければ、壊れた版が残っていると書いて失敗する', async () => {
    const f = fake({ versions: [CURRENT], wrangler: { rollback: fail() } });
    assert.equal(await deploy(f.deps), 1);
    assert.ok(f.errors.some((message) => message.includes('戻せませんでした')));
  });

  test('煙のテストに落ち、戻し先が無ければ rollback を呼ばずに失敗する', async () => {
    const f = fake({ versions: ['dev'], wrangler: { status: noWorker } });
    assert.equal(await deploy(f.deps), 1);
    assert.ok(!f.calls.some((args) => args[0] === 'rollback'));
    assert.ok(f.errors.some((message) => message.includes('壊れた版が残っています')));
  });

  test('煙のテストは5秒おきに問い合わせ、1回を10秒で打ち切り、2分を過ぎたら諦める', async () => {
    const f = fake({ versions: [new Error('HTTP 503')], fetchMs: 1_000 });
    assert.equal(await deploy(f.deps), 1);
    // 0秒から115秒まで5秒おき
    assert.deepEqual(
      f.attempts.map((attempt) => attempt.at),
      Array.from({ length: 24 }, (_, i) => i * 5_000),
    );
    assert.equal(f.attempts[0]!.timeoutMs, 10_000);
    assert.ok(f.clock() <= 120_000);
  });

  test('煙のテストの問い合わせが遅くても5秒を足さず、2分を超えない', async () => {
    const f = fake({ versions: [new Error('timeout')], fetchMs: 10_000 });
    assert.equal(await deploy(f.deps), 1);
    assert.deepEqual(
      f.attempts.map((attempt) => attempt.at),
      Array.from({ length: 12 }, (_, i) => i * 10_000),
    );
    assert.ok(f.clock() <= 120_000);
  });

  test('期限の直前に始めた問い合わせは、残りの時間で打ち切る', async () => {
    const f = fake({ versions: [new Error('timeout')], fetchMs: 7_000 });
    assert.equal(await deploy(f.deps), 1);
    // 0, 7, 14, ... 119 秒に始め、最後の回は残りの1秒で打ち切る
    assert.deepEqual(f.attempts.at(-1), { at: 119_000, timeoutMs: 1_000 });
    assert.ok(f.clock() <= 120_000);
  });

  test('反映が遅れても、何回目かで版が一致すれば成功する', async () => {
    const f = fake({ versions: [new Error('HTTP 503'), CURRENT, SHA] });
    assert.equal(await deploy(f.deps), 0);
    assert.equal(f.fetches, 3);
    assert.ok(!f.calls.some((args) => args[0] === 'rollback'));
  });
});
