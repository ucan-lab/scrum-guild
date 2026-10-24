import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { deploy, PRODUCTION_URL, type DeployDeps, type WranglerResult } from './deploy.ts';

const SHA = 'abc1234';
const CURRENT = 'version-current';

const ok = (stdout = ''): WranglerResult => ({ status: 0, stdout, stderr: '' });
const fail = (stderr = ''): WranglerResult => ({ status: 1, stdout: '', stderr });
const status100 = ok(JSON.stringify({ versions: [{ version_id: CURRENT, percentage: 100 }] }));

type Fake = {
  deps: DeployDeps;
  calls: string[][];
  fetches: number;
  errors: string[];
};

// wrangler の呼び出しは引数の先頭の語で答えを返す。版は responses を順に返し、尽きたら最後の値を返し続ける
function fake(options: {
  commitSha?: string | undefined;
  wrangler?: Partial<Record<'status' | 'bookmark' | 'apply' | 'deploy' | 'rollback', WranglerResult>>;
  hasMigrations?: boolean;
  versions?: (string | Error)[];
}): Fake {
  const calls: string[][] = [];
  const errors: string[] = [];
  let clock = 0;
  const versions = options.versions ?? [SHA];
  const result: Fake = {
    calls,
    errors,
    fetches: 0,
    deps: {
      commitSha: 'commitSha' in options ? options.commitSha : SHA,
      wrangler: (args) => {
        calls.push(args);
        const w = options.wrangler ?? {};
        if (args[0] === 'deployments') return w.status ?? status100;
        if (args[1] === 'time-travel') return w.bookmark ?? ok('{"bookmark":"b-1"}');
        if (args[1] === 'migrations') return w.apply ?? ok();
        if (args[0] === 'deploy') return w.deploy ?? ok();
        if (args[0] === 'rollback') return w.rollback ?? ok();
        throw new Error(`想定外の wrangler の呼び出し: ${args.join(' ')}`);
      },
      hasMigrations: () => options.hasMigrations ?? false,
      fetchVersion: async (url) => {
        assert.equal(url, `${PRODUCTION_URL}/api/health`);
        const value = versions[Math.min(result.fetches, versions.length - 1)];
        result.fetches++;
        if (value instanceof Error) throw value;
        return value!;
      },
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      log: () => {},
      error: (message) => errors.push(message),
    },
  };
  return result;
}

const commands = (calls: string[][]) => calls.map((args) => args.slice(0, 2).join(' '));

describe('deploy', () => {
  test('マイグレーションが無ければ、戻し先を控えて版を上げ、煙のテストで成功する', async () => {
    const f = fake({});
    assert.equal(await deploy(f.deps), 0);
    assert.deepEqual(commands(f.calls), ['deployments status', 'deploy --var']);
    assert.deepEqual(f.calls[1], ['deploy', '--var', `APP_VERSION:${SHA}`, '--message', SHA]);
  });

  test('マイグレーションがあれば、ブックマークを取ってから当て、その後に版を上げる', async () => {
    const f = fake({ hasMigrations: true });
    assert.equal(await deploy(f.deps), 0);
    assert.deepEqual(commands(f.calls), ['deployments status', 'd1 time-travel', 'd1 migrations', 'deploy --var']);
    assert.ok(f.calls[2]!.includes('--remote'));
  });

  test('WORKERS_CI_COMMIT_SHA が無ければ、wrangler を1つも呼ばずに失敗する', async () => {
    for (const commitSha of [undefined, '']) {
      const f = fake({ commitSha });
      assert.equal(await deploy(f.deps), 1);
      assert.deepEqual(f.calls, []);
    }
  });

  test('Worker が無い（10007）なら、戻し先無しで出して成功する', async () => {
    const f = fake({ wrangler: { status: fail('X [ERROR] A request to the Cloudflare API failed. [code: 10007]') } });
    assert.equal(await deploy(f.deps), 0);
    assert.deepEqual(commands(f.calls), ['deployments status', 'deploy --var']);
  });

  test('Worker にデプロイが1つも無ければ、戻し先無しで出す', async () => {
    const f = fake({ wrangler: { status: fail('The Worker scrum-guild has no deployments.') } });
    assert.equal(await deploy(f.deps), 0);
  });

  test('10007 以外のエラーで今の版を取れなければ、本番に触らずに失敗する', async () => {
    const f = fake({ hasMigrations: true, wrangler: { status: fail('Authentication error [code: 10000]') } });
    assert.equal(await deploy(f.deps), 1);
    assert.deepEqual(commands(f.calls), ['deployments status']);
  });

  test('今の版の JSON が読めなければ、本番に触らずに失敗する', async () => {
    const f = fake({ wrangler: { status: ok('not json') } });
    assert.equal(await deploy(f.deps), 1);
    assert.deepEqual(commands(f.calls), ['deployments status']);
  });

  test('今の版が 100% でなければ、本番に触らずに失敗する', async () => {
    const split = ok(
      JSON.stringify({
        versions: [
          { version_id: 'a', percentage: 90 },
          { version_id: 'b', percentage: 10 },
        ],
      }),
    );
    const f = fake({ hasMigrations: true, wrangler: { status: split } });
    assert.equal(await deploy(f.deps), 1);
    assert.deepEqual(commands(f.calls), ['deployments status']);
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

  test('版を上げられなければ、煙のテストも rollback もせずに失敗する', async () => {
    const f = fake({ wrangler: { deploy: fail() } });
    assert.equal(await deploy(f.deps), 1);
    assert.equal(f.fetches, 0);
    assert.deepEqual(commands(f.calls), ['deployments status', 'deploy --var']);
  });

  test('煙のテストに落ちたら、控えた版の ID を指定して戻し、失敗する', async () => {
    const f = fake({ versions: [CURRENT] });
    assert.equal(await deploy(f.deps), 1);
    const rollback = f.calls.at(-1)!;
    assert.equal(rollback[0], 'rollback');
    assert.equal(rollback[1], CURRENT);
    assert.ok(rollback.includes('--message'));
  });

  test('煙のテストは5秒おきに2分まで待ち、それを過ぎたら諦める', async () => {
    const f = fake({ versions: [new Error('timeout')] });
    assert.equal(await deploy(f.deps), 1);
    // 0秒から120秒まで5秒おき
    assert.equal(f.fetches, 25);
  });

  test('煙のテストに落ち、戻し先が無ければ rollback を呼ばずに失敗する', async () => {
    const f = fake({ versions: ['dev'], wrangler: { status: fail('[code: 10007]') } });
    assert.equal(await deploy(f.deps), 1);
    assert.ok(!f.calls.some((args) => args[0] === 'rollback'));
    assert.ok(f.errors.some((message) => message.includes('壊れた版が残っています')));
  });

  test('反映が遅れても、何回目かで版が一致すれば成功する', async () => {
    const f = fake({ versions: [new Error('HTTP 503'), CURRENT, SHA] });
    assert.equal(await deploy(f.deps), 0);
    assert.equal(f.fetches, 3);
    assert.ok(!f.calls.some((args) => args[0] === 'rollback'));
  });
});
