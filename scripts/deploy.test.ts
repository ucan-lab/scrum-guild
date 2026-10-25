import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { SEED_SESSIONS } from '../seed/sessions.ts';
import { deploy, PRODUCTION_URL, versionFromHealth, type DeployDeps, type WranglerResult } from './deploy.ts';

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
  // seed のトークンを付けた本番への問い合わせ
  seedRequests: { url: string; headers: Record<string, string>; body: string }[];
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
  // seed のトークンへの本番の応答。状態（401 の本文の code は unauthenticated とみなす）、状態と code、投げる失敗のどれか。
  // 既定はすべて 401 の unauthenticated
  seedStatus?: (token: string, call: number) => number | { status: number; code: string | undefined } | Error;
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
    seedRequests: [],
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
      postStatus: async (url, init) => {
        result.seedRequests.push({ url, ...init });
        const token = init.headers.Cookie!.split('=')[1]!;
        const value = options.seedStatus?.(token, result.seedRequests.length) ?? 401;
        if (value instanceof Error) throw value;
        if (typeof value === 'number') {
          return { status: value, errorCode: value === 401 ? 'unauthenticated' : undefined };
        }
        return { status: value.status, errorCode: value.code };
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

  test('版が無いかコミットの SHA の形でなければ、wrangler を1つも呼ばずに失敗する', async () => {
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

  test('版が一致した後、seed のトークンを4つとも本番に送り、どれも 401 なら成功する', async () => {
    const f = fake({});
    assert.equal(await deploy(f.deps), 0);
    assert.equal(f.seedRequests.length, Object.keys(SEED_SESSIONS).length);
    for (const request of f.seedRequests) {
      // 入れる組織の判定をしない logout で確かめる（判定をする me だと、行が残っていても 401 になり、見逃す）
      assert.equal(request.url, `${PRODUCTION_URL}/api/logout`);
      // Origin が公開する URL と合わないと、セッションを読む前に 403 で終わる
      assert.equal(request.headers.Origin, PRODUCTION_URL);
      assert.equal(request.headers['Content-Type'], 'application/json');
    }
    assert.deepEqual(
      f.seedRequests.map((request) => request.headers.Cookie),
      Object.values(SEED_SESSIONS).map((seed) => `__Host-sg_session=${seed.token}`),
    );
    assert.ok(f.logs.includes(`seed のトークンの確認: ${Object.keys(SEED_SESSIONS).length}つとも本番が拒みました`));
  });

  test('本番が seed のトークンを受け付けたら、繰り返さずに控えた版へ戻して失敗し、sessions の行を消す手順を指す', async () => {
    const f = fake({ seedStatus: (token) => (token === SEED_SESSIONS.operator.token ? 200 : 401) });
    assert.equal(await deploy(f.deps), 1);
    assert.deepEqual(lastCall(f), ['rollback', CURRENT]);
    const message = f.errors.find((entry) => entry.includes('operator') && entry.includes('200'));
    assert.ok(message);
    // 戻しても本番の sessions に seed の行が残れば直らない。消す手順は人が実行する
    assert.ok(message.includes('前の版へ戻しても'));
    assert.ok(message.includes('docs/operations.md'));
    assert.ok(message.includes('seed のセッションが本番に入ったとき'));
    // 同じ名前への問い合わせは1回だけ。トークンの値は、ログにも失敗の文言にも出さない
    assert.equal(
      f.seedRequests.filter((request) => request.headers.Cookie!.includes(SEED_SESSIONS.operator.token)).length,
      1,
    );
    for (const seed of Object.values(SEED_SESSIONS)) {
      assert.ok(![...f.errors, ...f.logs].some((line) => line.includes(seed.token)));
    }
  });

  test('受け付けられたトークンがあっても、残りのトークンも全部確かめてから失敗にし、受け付けた名前をすべて報告する', async () => {
    const acceptedNames = ['admin', 'operator'] as const;
    const f = fake({
      seedStatus: (token) => (acceptedNames.some((name) => SEED_SESSIONS[name].token === token) ? 200 : 401),
    });
    assert.equal(await deploy(f.deps), 1);
    // 全部のトークンに送った（最初の1つで止めない）
    assert.equal(f.seedRequests.length, Object.keys(SEED_SESSIONS).length);
    const message = f.errors.find((entry) => entry.includes('本番が seed のトークンを受け付けました'));
    assert.ok(message);
    for (const name of acceptedNames) assert.ok(message.includes(`${name}（200）`), name);
    // 拒まれた名前は、受け付けた名前に入れない
    for (const name of Object.keys(SEED_SESSIONS).filter((key) => !acceptedNames.some((a) => a === key))) {
      assert.ok(!message.includes(`${name}（`), name);
    }
    assert.ok(message.includes(`${Object.keys(SEED_SESSIONS).length}つのうち 2つ`));
    assert.deepEqual(lastCall(f), ['rollback', CURRENT]);
  });

  test('受け付けたトークンと、確かめられなかったトークンが混ざっても、両方を報告する', async () => {
    const f = fake({
      seedStatus: (token) => {
        if (token === SEED_SESSIONS.admin.token) return 200;
        if (token === SEED_SESSIONS.member.token) return new Error('timeout');
        return 401;
      },
    });
    assert.equal(await deploy(f.deps), 1);
    const message = f.errors.find((entry) => entry.includes('本番が seed のトークンを受け付けました'))!;
    assert.ok(message.includes('admin（200）'));
    assert.ok(message.includes('seed のトークン（member）を本番が拒むことを確かめられませんでした'));
  });

  test('401 以外の 4xx と 3xx は、繰り返さずに失敗にして戻す（全部のトークンを確かめる）', async () => {
    for (const status of [400, 403, 404, 301, 302]) {
      const f = fake({ seedStatus: () => status });
      assert.equal(await deploy(f.deps), 1, String(status));
      assert.deepEqual(lastCall(f), ['rollback', CURRENT], String(status));
      // トークンごとに1回だけ（繰り返さない）
      assert.equal(f.seedRequests.length, Object.keys(SEED_SESSIONS).length, String(status));
      assert.ok(
        f.errors.some((message) => message.includes(`${status} でした`)),
        String(status),
      );
    }
  });

  test('401 でも、本文の code が unauthenticated でなければ、別の理由で止まったものとして失敗にして戻す', async () => {
    for (const code of ['forbidden', 'invalid_input', undefined]) {
      const f = fake({ seedStatus: () => ({ status: 401, code }) });
      assert.equal(await deploy(f.deps), 1, String(code));
      assert.deepEqual(lastCall(f), ['rollback', CURRENT], String(code));
      assert.equal(f.seedRequests.length, Object.keys(SEED_SESSIONS).length, String(code));
      assert.ok(
        f.errors.some((message) => message.includes('unauthenticated を想定')),
        String(code),
      );
    }
  });

  test('5xx と 429 は届かなかったのと同じ扱いで、3回まで繰り返す。その間に 401 が返れば成功する', async () => {
    for (const status of [500, 502, 503, 429]) {
      const flaky = fake({ seedStatus: (_token, call) => (call <= 2 ? status : 401) });
      assert.equal(await deploy(flaky.deps), 0, String(status));
      assert.ok(
        flaky.logs.some((message) => message.includes(`${status} でした`)),
        String(status),
      );

      // 全部のトークンが、それぞれ3回まで繰り返す
      const stuck = fake({ seedStatus: () => status });
      assert.equal(await deploy(stuck.deps), 1, String(status));
      assert.equal(stuck.seedRequests.length, 3 * Object.keys(SEED_SESSIONS).length, String(status));
      assert.deepEqual(lastCall(stuck), ['rollback', CURRENT], String(status));
      assert.ok(
        stuck.errors.some((message) => message.includes('確かめられませんでした')),
        String(status),
      );
    }
  });

  test('seed のトークンの問い合わせが届かなければ、3回まで繰り返し、それでも届かなければ戻す', async () => {
    const flaky = fake({ seedStatus: (_token, call) => (call <= 2 ? new Error('timeout') : 401) });
    assert.equal(await deploy(flaky.deps), 0);
    const down = fake({ seedStatus: () => new Error('timeout') });
    assert.equal(await deploy(down.deps), 1);
    assert.equal(down.seedRequests.length, 3 * Object.keys(SEED_SESSIONS).length);
    assert.deepEqual(lastCall(down), ['rollback', CURRENT]);
    assert.ok(down.errors.some((message) => message.includes('確かめられませんでした')));
  });

  test('確認の途中で例外が出ても（ログの出力など）、失敗として前の版へ戻す', async () => {
    const f = fake({});
    let thrown = false;
    const log = f.deps.log;
    f.deps.log = (message) => {
      if (message.startsWith('seed のトークンの確認') && !thrown) {
        thrown = true;
        throw new Error('log failed');
      }
      log(message);
    };
    f.deps.postStatus = async () => {
      throw new Error('boom');
    };
    assert.equal(await deploy(f.deps), 1);
    assert.deepEqual(lastCall(f), ['rollback', CURRENT]);
    assert.ok(f.errors.some((message) => message.includes('例外で終わりました')));
  });

  test('版が一致しなければ、seed のトークンは送らない', async () => {
    const f = fake({ versions: [CURRENT] });
    assert.equal(await deploy(f.deps), 1);
    assert.equal(f.seedRequests.length, 0);
  });

  test('反映が遅れても、何回目かで版が一致すれば成功する', async () => {
    const f = fake({ versions: [new Error('HTTP 503'), CURRENT, SHA] });
    assert.equal(await deploy(f.deps), 0);
    assert.equal(f.fetches, 3);
    assert.ok(!f.calls.some((args) => args[0] === 'rollback'));
  });
});

describe('versionFromHealth', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  test('D1 に届いた版の応答から version を取る', async () => {
    assert.equal(await versionFromHealth(json({ status: 'ok', database: 'ok', version: SHA })), SHA);
  });

  test('D1 に届かない版の 503 は、code を添えて失敗にする', async () => {
    const res = json({ error: { code: 'unavailable', message: 'database unavailable' } }, 503);
    await assert.rejects(versionFromHealth(res), /HTTP 503（unavailable）/);
  });

  test('本文が JSON でない 503 も失敗にする', async () => {
    await assert.rejects(versionFromHealth(new Response('upstream error', { status: 503 })), /HTTP 503/);
  });

  test('database の無い古い形の 200 は失敗にする', async () => {
    await assert.rejects(versionFromHealth(json({ status: 'ok', version: SHA })), /health の形ではありません/);
  });
});

describe('deploy-production.ts', () => {
  // import.meta.main の無い Node（engines は >=22.18）では deploy-production.ts が理由を出して終了コード 1 で終わるので、確かめる対象が無い
  const skip = typeof import.meta.main !== 'boolean' && 'import.meta.main が使えない Node では import できない';
  test('import しても deploy() は動かず、プロセスも終わらない', { skip }, () => {
    // 動いてしまっても本番に触らないよう、WORKERS_CI を外した環境で動かす（deploy() は手順に入らず終わる）
    const childEnv = { ...process.env, WORKERS_CI: undefined };
    const url = new URL('./deploy-production.ts', import.meta.url).href;
    const code = `await import(${JSON.stringify(url)}); console.log('imported')`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      env: childEnv,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'imported');
  });

  test('直に動かすと deploy() が動く（import.meta.main が偽のまま成功に見えない）', { skip }, () => {
    // WORKERS_CI を外すので、deploy() は wrangler を呼ぶ前に終了コード 1 で終わる
    const childEnv = { ...process.env, WORKERS_CI: undefined };
    const file = fileURLToPath(new URL('./deploy-production.ts', import.meta.url));
    const result = spawnSync(process.execPath, [file], { encoding: 'utf8', env: childEnv });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Workers Builds の外では動かしません/);
  });
});
