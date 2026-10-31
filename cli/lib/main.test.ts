// sg の本体（main）を、偽の fetch と操作の一覧の見本で確かめる。コマンド、優先順位、型の変換、出力、終了コードは Issue #582 の前提
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { main, type CliDeps, type Config, type ConfigStore } from './main.ts';

const URL_MAIN = 'https://guild.example';
const URL_SUB = 'https://sub.guild.example';
const TOKEN_MAIN = `sgp_${'M'.repeat(43)}`;
const TOKEN_SUB = `sgp_${'S'.repeat(43)}`;
const TOKEN_ENV = `sgp_${'E'.repeat(43)}`;
const TOKEN_STDIN = `sgp_${'I'.repeat(43)}`;
const ALL_TOKENS = [TOKEN_MAIN, TOKEN_SUB, TOKEN_ENV, TOKEN_STDIN];

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties,
  required,
});

// operation-list が返す形の見本（z.toJSONSchema の io: 'input' の形）
const catalog = {
  operations: [
    {
      name: 'task-edit',
      description: 'タスクを書き換える',
      mode: 'write',
      scope: 'workspace',
      permission: 'member',
      input_schema: object(
        {
          workspace_id: { type: 'string' },
          task_id: { type: 'string' },
          title: { type: 'string' },
          points: { type: 'number' },
          order: { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 },
          done: { type: 'boolean' },
          due: { type: ['string', 'null'] },
          labels: { type: 'array', items: { type: 'string' } },
          meta: { type: 'object', properties: {} },
        },
        ['workspace_id', 'task_id'],
      ),
      output_schema: object({ task_id: { type: 'string' } }, ['task_id']),
    },
    {
      name: 'task-get',
      description: 'タスクを返す',
      mode: 'read',
      scope: 'organization',
      permission: 'organization',
      input_schema: object({ task_id: { type: 'string' } }, ['task_id']),
      output_schema: object({ title: { type: 'string' } }, ['title']),
    },
    {
      name: 'who-am-i',
      description: 'ログインしているアカウントを返す',
      mode: 'read',
      scope: 'outside',
      permission: 'login',
      input_schema: object({ note: { type: 'string' } }),
      output_schema: object({ account_id: { type: 'string' } }, ['account_id']),
    },
    {
      name: 'workspace-peek',
      description: 'ワークスペースを覗く',
      mode: 'read',
      scope: 'workspace',
      permission: 'member',
      input_schema: object({ workspace_id: { type: 'string' } }, ['workspace_id']),
      output_schema: object({ workspace_id: { type: 'string' } }, ['workspace_id']),
    },
  ],
};

type Recorded = { url: string; method: string; authorization: string | null; body: unknown };

type ServerReply = { status: number; body: unknown };

// 一覧の操作には見本を、ほかの操作には reply を返す。throws なら接続できないときと同じく投げる
function fakeServer(options: { reply?: (request: Recorded) => ServerReply; throws?: boolean } = {}) {
  const requests: Recorded[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (options.throws) throw new TypeError('fetch failed');
    const request = new Request(input, init);
    const text = await request.text();
    const recorded: Recorded = {
      url: request.url,
      method: request.method,
      authorization: request.headers.get('Authorization'),
      body: text === '' ? undefined : JSON.parse(text),
    };
    requests.push(recorded);
    const path = new URL(request.url).pathname;
    const reply: ServerReply = path.endsWith('/api/operation-list')
      ? { status: 200, body: catalog }
      : (options.reply?.(recorded) ?? { status: 200, body: { ok: true } });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  // 一覧を取る呼び出しを除いた、操作の呼び出し
  const calls = () => requests.filter((request) => !new URL(request.url).pathname.endsWith('/api/operation-list'));
  return { fetcher, requests, calls };
}

function memoryStore(initial?: Config): ConfigStore & { current(): Config | undefined } {
  let saved = initial === undefined ? undefined : structuredClone(initial);
  return {
    read: async () => (saved === undefined ? undefined : structuredClone(saved)),
    write: async (config) => {
      saved = structuredClone(config);
    },
    current: () => saved,
  };
}

const oneProfile = (profile: Config['profiles'][string] = {}): Config => ({
  default_profile: 'main',
  profiles: { main: { url: URL_MAIN, token: TOKEN_MAIN, ...profile } },
});

type RunOptions = {
  config?: ConfigStore;
  env?: Record<string, string | undefined>;
  server?: ReturnType<typeof fakeServer>;
  stdin?: string;
};

// どの呼び出しでも、標準出力と標準エラーにトークンの生の値が出ないことを確かめる
async function sg(argv: string[], options: RunOptions = {}) {
  const server = options.server ?? fakeServer();
  let stdout = '';
  let stderr = '';
  const deps: CliDeps = {
    fetch: server.fetcher,
    env: options.env ?? {},
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    readStdin: async () => options.stdin ?? '',
    config: options.config ?? memoryStore(oneProfile()),
  };
  const code = await main(argv, deps);
  for (const token of ALL_TOKENS) {
    assert.ok(!stdout.includes(token), `標準出力にトークンが出た: ${argv.join(' ')}`);
    assert.ok(!stderr.includes(token), `標準エラーにトークンが出た: ${argv.join(' ')}`);
  }
  return { code, stdout, stderr, server };
}

function usageError(result: { code: number; stderr: string }) {
  assert.equal(result.code, 2, result.stderr);
  assert.equal(JSON.parse(result.stderr).error.code, 'usage');
}

const workspaceConfig = () => memoryStore(oneProfile({ org: 'aoba', workspace: 'ws-config' }));

describe('sg call の引数の型の変換', () => {
  test('string、number、integer、boolean、null を許す項目の null を、入力の JSON Schema の型で変える', async () => {
    const { code, server } = await sg(
      [
        'call',
        'task-edit',
        '--task_id',
        't-1',
        '--title',
        '123',
        '--points',
        '2.5',
        '--order',
        '3',
        '--done',
        'true',
        '--due',
        'null',
      ],
      { config: workspaceConfig() },
    );
    assert.equal(code, 0);
    assert.deepEqual(server.calls()[0]!.body, {
      workspace_id: 'ws-config',
      task_id: 't-1',
      title: '123',
      points: 2.5,
      order: 3,
      done: true,
      due: null,
    });
  });

  test('boolean の false と、null を許す項目の文字列はそのまま', async () => {
    const { code, server } = await sg(
      ['call', 'task-edit', '--task_id', 't-1', '--done', 'false', '--due', '2026-11-01'],
      {
        config: workspaceConfig(),
      },
    );
    assert.equal(code, 0);
    assert.deepEqual(server.calls()[0]!.body, {
      workspace_id: 'ws-config',
      task_id: 't-1',
      done: false,
      due: '2026-11-01',
    });
  });

  for (const [label, args] of [
    ['integer に小数', ['--order', '2.5']],
    ['number に数でない値', ['--points', 'abc']],
    ['boolean に true / false 以外', ['--done', 'yes']],
    ['null を許さない number に null', ['--points', 'null']],
    ['入力に無い項目', ['--colour', 'red']],
    ['array の項目', ['--labels', 'a']],
    ['object の項目', ['--meta', 'x']],
  ] as const) {
    test(`${label}は使い方の誤り（2）で、操作を呼ばない`, async () => {
      const result = await sg(['call', 'task-edit', '--task_id', 't-1', ...args], { config: workspaceConfig() });
      usageError(result);
      assert.equal(result.server.calls().length, 0);
    });
  }

  test('--<項目> が JSON の同じ項目に勝ち、ほかの項目は JSON のまま', async () => {
    const { code, server } = await sg(
      ['call', 'task-edit', '{"task_id":"t-1","title":"古い題名"}', '--title', '新しい題名'],
      {
        config: workspaceConfig(),
      },
    );
    assert.equal(code, 0);
    assert.deepEqual(server.calls()[0]!.body, { workspace_id: 'ws-config', task_id: 't-1', title: '新しい題名' });
  });

  test('JSON の入力は object/array の項目もそのまま送る', async () => {
    const { code, server } = await sg(['call', 'task-edit', '{"task_id":"t-1","labels":["急ぎ"],"meta":{"k":1}}'], {
      config: workspaceConfig(),
    });
    assert.equal(code, 0);
    assert.deepEqual(server.calls()[0]!.body, {
      workspace_id: 'ws-config',
      task_id: 't-1',
      labels: ['急ぎ'],
      meta: { k: 1 },
    });
  });

  test('壊れた JSON は 2 で、操作を呼ばない', async () => {
    const result = await sg(['call', 'task-edit', '{"task_id":'], { config: workspaceConfig() });
    usageError(result);
    assert.equal(result.server.calls().length, 0);
  });

  test('無い操作名は 2 で、操作を呼ばない', async () => {
    const result = await sg(['call', 'no-such-operation']);
    usageError(result);
    assert.equal(result.server.calls().length, 0);
  });

  test('操作名が無い call は 2', async () => {
    usageError(await sg(['call']));
  });

  test('無いコマンドは 2', async () => {
    usageError(await sg(['launch']));
  });
});

describe('sg call の URL と認証', () => {
  test('組織の外の操作は /api/<name> に POST し、Authorization: Bearer を付け、workspace_id を補わない', async () => {
    const { code, server } = await sg(['call', 'who-am-i'], { config: workspaceConfig() });
    assert.equal(code, 0);
    const [call] = server.calls();
    assert.equal(call!.url, `${URL_MAIN}/api/who-am-i`);
    assert.equal(call!.method, 'POST');
    assert.equal(call!.authorization, `Bearer ${TOKEN_MAIN}`);
    assert.deepEqual(call!.body ?? {}, {});
  });

  test('一覧を取る呼び出しにも Authorization: Bearer が付く', async () => {
    const { server } = await sg(['call', 'who-am-i']);
    const list = server.requests.find((request) => request.url === `${URL_MAIN}/api/operation-list`);
    assert.ok(list, '一覧を /api/operation-list から取る');
    assert.equal(list.authorization, `Bearer ${TOKEN_MAIN}`);
  });

  test('組織の中の操作は /api/<slug>/<name>、slug は encode する', async () => {
    const { code, server } = await sg(['call', 'task-get', '--task_id', 't-1', '--org', 'aoba kobo/x']);
    assert.equal(code, 0);
    assert.equal(server.calls()[0]!.url, `${URL_MAIN}/api/aoba%20kobo%2Fx/task-get`);
    assert.deepEqual(server.calls()[0]!.body, { task_id: 't-1' });
  });

  test('組織の中の操作で組織がどこにも無ければ 2 で、操作を呼ばない', async () => {
    const result = await sg(['call', 'task-get', '--task_id', 't-1']);
    usageError(result);
    assert.equal(result.server.calls().length, 0);
  });

  test('成功の応答は標準出力に 2 字下げの JSON で、終了コード 0', async () => {
    const server = fakeServer({ reply: () => ({ status: 200, body: { account_id: 'acc-1', nested: { a: 1 } } }) });
    const { code, stdout, stderr } = await sg(['call', 'who-am-i'], { server });
    assert.equal(code, 0);
    assert.equal(stderr, '');
    assert.deepEqual(JSON.parse(stdout), { account_id: 'acc-1', nested: { a: 1 } });
    assert.ok(stdout.includes('\n  "account_id"'), stdout);
  });
});

describe('組織とワークスペースの補い', () => {
  const orgOf = (url: string) => new URL(url).pathname.split('/')[2];

  test('組織は --org > SG_ORG > 設定', async () => {
    const config = () => memoryStore(oneProfile({ org: 'from-config' }));
    const viaConfig = await sg(['call', 'task-get', '--task_id', 't'], { config: config() });
    assert.equal(orgOf(viaConfig.server.calls()[0]!.url), 'from-config');
    const viaEnv = await sg(['call', 'task-get', '--task_id', 't'], { config: config(), env: { SG_ORG: 'from-env' } });
    assert.equal(orgOf(viaEnv.server.calls()[0]!.url), 'from-env');
    const viaFlag = await sg(['call', 'task-get', '--task_id', 't', '--org', 'from-flag'], {
      config: config(),
      env: { SG_ORG: 'from-env' },
    });
    assert.equal(orgOf(viaFlag.server.calls()[0]!.url), 'from-flag');
  });

  test('workspace_id は 入力 > --workspace > SG_WORKSPACE > 設定', async () => {
    const workspaceOf = async (args: string[], env: Record<string, string> = {}) => {
      const { code, server } = await sg(['call', 'workspace-peek', ...args], { config: workspaceConfig(), env });
      assert.equal(code, 0);
      return (server.calls()[0]!.body as { workspace_id: string }).workspace_id;
    };
    assert.equal(await workspaceOf([]), 'ws-config');
    assert.equal(await workspaceOf([], { SG_WORKSPACE: 'ws-env' }), 'ws-env');
    assert.equal(await workspaceOf(['--workspace', 'ws-flag'], { SG_WORKSPACE: 'ws-env' }), 'ws-flag');
    assert.equal(await workspaceOf(['--workspace_id', 'ws-input', '--workspace', 'ws-flag']), 'ws-input');
    assert.equal(await workspaceOf(['{"workspace_id":"ws-json"}', '--workspace', 'ws-flag']), 'ws-json');
  });
});

describe('設定が無い、つながらない、API のエラー', () => {
  test('設定ファイルも環境変数も無ければ 2', async () => {
    const result = await sg(['call', 'who-am-i'], { config: memoryStore() });
    usageError(result);
    assert.equal(result.server.requests.length, 0);
  });

  test('url だけ、token だけの接続先は 2', async () => {
    usageError(
      await sg(['call', 'who-am-i'], {
        config: memoryStore({ profiles: { main: { url: URL_MAIN } }, default_profile: 'main' }),
      }),
    );
    usageError(
      await sg(['call', 'who-am-i'], {
        config: memoryStore({ profiles: { main: { token: TOKEN_MAIN } }, default_profile: 'main' }),
      }),
    );
  });

  test('環境変数の SG_URL と SG_TOKEN だけでも呼べる', async () => {
    const { code, server } = await sg(['call', 'who-am-i'], {
      config: memoryStore(),
      env: { SG_URL: URL_SUB, SG_TOKEN: TOKEN_ENV },
    });
    assert.equal(code, 0);
    assert.equal(server.calls()[0]!.url, `${URL_SUB}/api/who-am-i`);
    assert.equal(server.calls()[0]!.authorization, `Bearer ${TOKEN_ENV}`);
  });

  test('つながらない（fetch が投げる）ときは 3 で connection_failed', async () => {
    const { code, stderr } = await sg(['call', 'who-am-i'], { server: fakeServer({ throws: true }) });
    assert.equal(code, 3);
    assert.equal(JSON.parse(stderr).error.code, 'connection_failed');
  });

  test('sg ops もつながらなければ 3', async () => {
    const { code } = await sg(['ops'], { server: fakeServer({ throws: true }) });
    assert.equal(code, 3);
  });

  for (const status of [403, 404, 409, 500]) {
    test(`API の ${status} は標準エラーに {status, error} を出し、終了コード 1`, async () => {
      const error = { code: status === 403 ? 'forbidden' : 'not_found', message: '架空のエラー' };
      const server = fakeServer({ reply: () => ({ status, body: { error } }) });
      const { code, stdout, stderr } = await sg(['call', 'who-am-i'], { server });
      assert.equal(code, 1);
      assert.equal(stdout, '');
      assert.deepEqual(JSON.parse(stderr), { status, error });
    });
  }
});

describe('名前付きの接続先', () => {
  const twoProfiles = (): Config => ({
    default_profile: 'main',
    profiles: {
      main: { url: URL_MAIN, token: TOKEN_MAIN },
      sub: { url: URL_SUB, token: TOKEN_SUB },
    },
  });
  const target = async (args: string[], env: Record<string, string> = {}, config = twoProfiles()) => {
    const { code, server } = await sg(['call', 'who-am-i', ...args], { config: memoryStore(config), env });
    assert.equal(code, 0);
    const call = server.calls()[0]!;
    return { url: call.url, authorization: call.authorization };
  };

  test('既定は default_profile', async () => {
    assert.deepEqual(await target([]), { url: `${URL_MAIN}/api/who-am-i`, authorization: `Bearer ${TOKEN_MAIN}` });
  });

  test('SG_PROFILE が default_profile に勝ち、--profile が SG_PROFILE に勝つ', async () => {
    assert.deepEqual(await target([], { SG_PROFILE: 'sub' }), {
      url: `${URL_SUB}/api/who-am-i`,
      authorization: `Bearer ${TOKEN_SUB}`,
    });
    assert.deepEqual(await target(['--profile', 'main'], { SG_PROFILE: 'sub' }), {
      url: `${URL_MAIN}/api/who-am-i`,
      authorization: `Bearer ${TOKEN_MAIN}`,
    });
    assert.deepEqual(await target(['--profile', 'sub']), {
      url: `${URL_SUB}/api/who-am-i`,
      authorization: `Bearer ${TOKEN_SUB}`,
    });
  });

  test('SG_URL と SG_TOKEN が接続先の設定に勝つ', async () => {
    assert.deepEqual(await target(['--profile', 'sub'], { SG_URL: 'https://env.guild.example', SG_TOKEN: TOKEN_ENV }), {
      url: 'https://env.guild.example/api/who-am-i',
      authorization: `Bearer ${TOKEN_ENV}`,
    });
  });

  test('無い接続先を --profile で選ぶと 2', async () => {
    usageError(await sg(['call', 'who-am-i', '--profile', 'ghost'], { config: memoryStore(twoProfiles()) }));
  });
});

describe('sg config', () => {
  test('config set url と、標準入力から読んだ config set token で、その接続先から呼べる', async () => {
    const config = memoryStore();
    assert.equal((await sg(['config', 'set', 'url', URL_SUB], { config })).code, 0);
    assert.equal((await sg(['config', 'set', 'token'], { config, stdin: `${TOKEN_STDIN}\n` })).code, 0);
    const { code, server } = await sg(['call', 'who-am-i'], { config });
    assert.equal(code, 0);
    assert.equal(server.calls()[0]!.url, `${URL_SUB}/api/who-am-i`);
    assert.equal(server.calls()[0]!.authorization, `Bearer ${TOKEN_STDIN}`);
  });

  test('--profile を付けた config set は、その名前の接続先に書く', async () => {
    const config = memoryStore(oneProfile());
    for (const [key, value] of [
      ['url', URL_SUB],
      ['org', 'kaede'],
      ['workspace', 'ws-kaede'],
    ] as const) {
      assert.equal((await sg(['config', 'set', key, value, '--profile', 'work'], { config })).code, 0);
    }
    assert.equal((await sg(['config', 'set', 'token', '--profile', 'work'], { config, stdin: TOKEN_STDIN })).code, 0);
    assert.deepEqual(config.current()!.profiles.work, {
      url: URL_SUB,
      token: TOKEN_STDIN,
      org: 'kaede',
      workspace: 'ws-kaede',
    });
    assert.deepEqual(config.current()!.profiles.main, oneProfile().profiles.main);
  });

  test('config set token は引数のトークンを受け付けず 2、設定も変えない', async () => {
    const config = memoryStore(oneProfile());
    usageError(await sg(['config', 'set', 'token', TOKEN_SUB], { config }));
    assert.equal(config.current()!.profiles.main!.token, TOKEN_MAIN);
  });

  test('config show はトークンを伏せ、ほかの値は見せる', async () => {
    const { code, stdout } = await sg(['config', 'show'], {
      config: memoryStore(oneProfile({ org: 'aoba', workspace: 'ws-aoba' })),
    });
    assert.equal(code, 0);
    assert.ok(stdout.includes(URL_MAIN), stdout);
    assert.ok(stdout.includes('aoba'), stdout);
    assert.ok(stdout.includes('ws-aoba'), stdout);
  });

  test('config use は default_profile を変える', async () => {
    const config = memoryStore({
      default_profile: 'main',
      profiles: { main: { url: URL_MAIN, token: TOKEN_MAIN }, sub: { url: URL_SUB, token: TOKEN_SUB } },
    });
    assert.equal((await sg(['config', 'use', 'sub'], { config })).code, 0);
    assert.equal(config.current()!.default_profile, 'sub');
    const { server } = await sg(['call', 'who-am-i'], { config });
    assert.equal(server.calls()[0]!.url, `${URL_SUB}/api/who-am-i`);
  });
});

describe('sg ops', () => {
  test('一覧に操作の名前が並び、終了コード 0', async () => {
    const { code, stdout } = await sg(['ops']);
    assert.equal(code, 0);
    for (const operation of catalog.operations) assert.ok(stdout.includes(operation.name), operation.name);
  });

  test('sg ops <操作名> は説明と入力の形を見せる', async () => {
    const { code, stdout } = await sg(['ops', 'task-edit']);
    assert.equal(code, 0);
    assert.ok(stdout.includes('タスクを書き換える'), stdout);
    for (const key of ['workspace_id', 'task_id', 'points', 'due']) assert.ok(stdout.includes(key), key);
  });

  test('無い操作名は 2', async () => {
    usageError(await sg(['ops', 'no-such-operation']));
  });
});
