// sg の本体（main）の done-check の指摘を止めるテスト。期待は Issue #582 の前提と受け入れ条件（終了コード 1 / 2 / 3、トークンを出さない）に照らす
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { main, type CliDeps, type Config, type ConfigStore } from './main.ts';

const URL_A = 'https://aoba.guild.example';
const URL_B = 'https://kaede.guild.example';
const TOKEN_A = `sgp_${'A'.repeat(43)}`;
const TOKEN_B = `sgp_${'B'.repeat(43)}`;
const TOKEN_ENV = `sgp_${'V'.repeat(43)}`;

const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: [] });
const entry = (name: string, scope: string, properties: Record<string, unknown>) => ({
  name,
  description: name,
  mode: 'write',
  scope,
  permission: 'login',
  input_schema: object(properties),
  output_schema: object({}),
});

const catalog = {
  operations: [
    entry('lantern-set', 'outside', {
      count: { type: 'integer' },
      brightness: { type: 'number' },
      label: { type: 'string' },
    }),
    entry('lantern-org', 'organization', { label: { type: 'string' } }),
    entry('lantern-ws', 'workspace', { workspace_id: { type: 'string' } }),
  ],
};

type Call = { url: string; authorization: string; body: unknown; init: RequestInit };
type Handler = (path: string, body: unknown) => Response | Promise<Response>;

function memoryStore(initial?: Config) {
  let saved = initial === undefined ? undefined : structuredClone(initial);
  const store: ConfigStore & { current(): Config | undefined } = {
    read: async () => (saved === undefined ? undefined : structuredClone(saved)),
    write: async (config) => {
      saved = structuredClone(config);
    },
    current: () => saved,
  };
  return store;
}

const twoProfiles = (): Config => ({
  default_profile: 'main',
  profiles: {
    main: { url: URL_A, token: TOKEN_A, org: 'aoba', workspace: 'ws-aoba' },
    sub: { url: URL_B, token: TOKEN_B, org: 'kaede' },
  },
});

async function sg(
  argv: string[],
  options: {
    config?: ConfigStore;
    env?: Record<string, string>;
    stdin?: string;
    handler?: Handler;
    fetcher?: typeof fetch;
  } = {},
) {
  const calls: Call[] = [];
  const handler: Handler = options.handler ?? (() => Response.json({ ok: true }));
  const fetcher: typeof fetch =
    options.fetcher ??
    ((async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body: unknown = JSON.parse(String(init?.body));
      const url = String(input);
      calls.push({ url, authorization: headers.get('authorization') ?? '', body, init: init ?? {} });
      const path = new URL(url).pathname;
      if (path === '/api/operation-list') return Response.json(catalog);
      return handler(path, body);
    }) as typeof fetch);
  let stdout = '';
  let stderr = '';
  const deps: CliDeps = {
    fetch: fetcher,
    env: options.env ?? {},
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    readStdin: async () => options.stdin ?? '',
    config: options.config ?? memoryStore(twoProfiles()),
  };
  const code = await main(argv, deps);
  return { code, stdout, stderr, calls };
}

function usageError(result: { code: number; stderr: string; calls: Call[] }, secrets: string[] = []) {
  assert.equal(result.code, 2, result.stderr);
  assert.equal(JSON.parse(result.stderr).error.code, 'usage');
  assert.deepEqual(result.calls, []);
  for (const secret of secrets) assert.ok(!result.stderr.includes(secret), result.stderr);
}

describe('call の JSON は、つながる前に確かめる', () => {
  const failing = (async () => {
    throw new Error('connect ECONNREFUSED');
  }) as typeof fetch;

  for (const json of ['{', '[]', '"text"', 'null', '3']) {
    test(`つながらない状態で JSON ${json} を渡しても、3 ではなく 2`, async () => {
      const result = await sg(['call', 'lantern-set', json], { fetcher: failing });
      assert.equal(result.code, 2, result.stderr);
      assert.equal(JSON.parse(result.stderr).error.code, 'usage');
    });
  }
});

describe('空の環境変数は未設定として扱う', () => {
  test('SG_URL、SG_TOKEN、SG_ORG、SG_WORKSPACE、SG_PROFILE が空なら、設定の値を使う', async () => {
    const result = await sg(['call', 'lantern-ws'], {
      env: { SG_URL: '', SG_TOKEN: '', SG_ORG: '', SG_WORKSPACE: '', SG_PROFILE: '' },
    });
    assert.equal(result.code, 0, result.stderr);
    const last = result.calls.at(-1)!;
    assert.equal(last.url, `${URL_A}/api/aoba/lantern-ws`);
    assert.equal(last.authorization, `Bearer ${TOKEN_A}`);
    assert.deepEqual(last.body, { workspace_id: 'ws-aoba' });
  });
});

describe('URL とトークンは同じ出どころから取る', () => {
  for (const [label, env] of [
    ['SG_URL だけ', { SG_URL: URL_B }],
    ['SG_TOKEN だけ', { SG_TOKEN: TOKEN_ENV }],
  ] as const) {
    test(`${label}を設定すると 2 で、値を出さず、送らない`, async () => {
      const result = await sg(['ops'], { env });
      usageError(result, [URL_B, TOKEN_ENV, TOKEN_A]);
      assert.equal(JSON.parse(result.stderr).error.message, 'SG_URL と SG_TOKEN は両方を設定する');
    });
  }

  test('両方あれば環境変数の組を使い、設定の token と混ぜない', async () => {
    const result = await sg(['ops'], { env: { SG_URL: URL_B, SG_TOKEN: TOKEN_ENV } });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.calls[0]!.url, `${URL_B}/api/operation-list`);
    assert.equal(result.calls[0]!.authorization, `Bearer ${TOKEN_ENV}`);
  });

  test('空でない SG_URL と SG_TOKEN のどちらも無ければ、接続先の設定の組を使う', async () => {
    const result = await sg(['ops'], { env: { SG_URL: '', SG_TOKEN: '' } });
    assert.equal(result.calls[0]!.authorization, `Bearer ${TOKEN_A}`);
  });
});

describe('接続先の名前は自分の項目だけを引く', () => {
  for (const name of ['__proto__', 'constructor', 'prototype']) {
    // 修正前は __proto__ への書き込みが Object.prototype を汚すので、後始末を入れる
    const restore = () => {
      delete (Object.prototype as Record<string, unknown>).url;
      delete (Object.prototype as Record<string, unknown>).token;
    };
    test(`config set url --profile ${name} は 2 で、書かない`, async () => {
      const config = memoryStore(twoProfiles());
      try {
        const result = await sg(['config', 'set', 'url', URL_B, '--profile', name], { config });
        usageError(result);
        assert.deepEqual(config.current(), twoProfiles());
        assert.equal(({} as Record<string, unknown>).url, undefined);
      } finally {
        restore();
      }
    });
    test(`config use ${name} は 2 で、default_profile を変えない`, async () => {
      const config = memoryStore(twoProfiles());
      usageError(await sg(['config', 'use', name], { config }));
      assert.equal(config.current()!.default_profile, 'main');
    });
    test(`ops --profile ${name} と SG_PROFILE=${name} は 2`, async () => {
      usageError(await sg(['ops', '--profile', name]));
      usageError(await sg(['ops'], { env: { SG_PROFILE: name } }));
    });
    test(`default_profile が ${name} の設定は 2`, async () => {
      const config: Config = { default_profile: name, profiles: { main: { url: URL_A, token: TOKEN_A } } };
      usageError(await sg(['ops'], { config: memoryStore(config) }));
    });
    test(`profiles に ${name} を持つ設定は不正で 2`, async () => {
      const text = `{"profiles":{"main":{"url":"${URL_A}","token":"${TOKEN_A}"},"${name}":{"url":"${URL_B}"}}}`;
      usageError(await sg(['ops'], { config: memoryStore(JSON.parse(text) as Config) }), [TOKEN_A]);
    });
  }
});

describe('URL を確かめる', () => {
  const bad = [
    'ftp://guild.example',
    'file:///etc/passwd',
    'not a url',
    'https://reader:hunter2@guild.example',
    'http://guild.example',
    'http://localhost.evil.example',
    'http://127.0.0.1.evil.example',
  ];
  for (const url of bad) {
    test(`config set url ${url} は 2 で、保存せず、URL を出さない`, async () => {
      const config = memoryStore(twoProfiles());
      usageError(await sg(['config', 'set', 'url', url], { config }), ['hunter2', 'evil.example']);
      assert.deepEqual(config.current(), twoProfiles());
    });
    test(`使うときも ${url} は 2 で、送らず、URL を出さない`, async () => {
      const viaEnv = await sg(['ops'], { env: { SG_URL: url, SG_TOKEN: TOKEN_ENV } });
      usageError(viaEnv, ['hunter2', 'evil.example', TOKEN_ENV]);
      const config: Config = { profiles: { main: { url, token: TOKEN_A } } };
      usageError(await sg(['ops'], { config: memoryStore(config) }), ['hunter2', 'evil.example', TOKEN_A]);
    });
  }

  for (const url of ['http://localhost:5173', 'http://127.0.0.1:8787', 'http://[::1]:5173', URL_A]) {
    test(`${url} は受け付ける`, async () => {
      const config = memoryStore(twoProfiles());
      assert.equal((await sg(['config', 'set', 'url', url], { config })).code, 0);
      assert.equal(config.current()!.profiles.main!.url, url);
      const result = await sg(['ops'], { env: { SG_URL: url, SG_TOKEN: TOKEN_ENV } });
      assert.equal(result.code, 0, result.stderr);
    });
  }

  test('url の末尾の / は二重にならない', async () => {
    const result = await sg(['ops'], { env: { SG_URL: `${URL_A}///`, SG_TOKEN: TOKEN_ENV } });
    assert.equal(result.calls[0]!.url, `${URL_A}/api/operation-list`);
  });
});

describe('fetch の呼び方', () => {
  test('30 秒の中断の signal を付け、リダイレクトを追わない', async () => {
    const result = await sg(['call', 'lantern-set', '--count', '1']);
    for (const call of result.calls) {
      assert.ok(call.init.signal instanceof AbortSignal);
      assert.equal(call.init.signal.aborted, false);
      assert.equal(call.init.redirect, 'manual');
    }
  });

  test('3xx は API のエラーとして 1 で、Location を追わない', async () => {
    const result = await sg(['call', 'lantern-set'], {
      handler: () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/steal' } }),
    });
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).status, 302);
    assert.equal(result.calls.length, 2);
  });

  test('中断（TimeoutError）は connection_failed で 3', async () => {
    const result = await sg(['ops'], {
      fetcher: (async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      }) as typeof fetch,
    });
    assert.equal(result.code, 3);
    assert.equal(JSON.parse(result.stderr).error.code, 'connection_failed');
  });
});

describe('config set token', () => {
  for (const stdin of ['', '\n', '\r\n\r\n']) {
    test(`標準入力が ${JSON.stringify(stdin)} なら 2 で、保存しない`, async () => {
      const config = memoryStore(twoProfiles());
      usageError(await sg(['config', 'set', 'token'], { config, stdin }));
      assert.deepEqual(config.current(), twoProfiles());
    });
  }
});

describe('数を厳しくする', () => {
  for (const [key, values] of [
    ['count', ['0x10', '0b11', 'Infinity', '1e400', '-', '1.5', '9007199254740993', '1_000', '+1', '.5']],
    ['brightness', ['0x10', '0b11', 'Infinity', '-Infinity', '1e400', 'NaN', '1.', '1,5']],
  ] as const) {
    for (const value of values) {
      test(`--${key} ${value} は 2`, async () => {
        usageError(
          await sg(['call', 'lantern-set', `--${key}`, value]).then((r) => ({ ...r, calls: r.calls.slice(2) })),
        );
      });
    }
  }

  for (const [key, value, expected] of [
    ['count', '1e3', 1000],
    ['count', '-7', -7],
    ['count', '2.0', 2],
    ['brightness', '-2.5', -2.5],
    ['brightness', '1E-2', 0.01],
    ['brightness', '10', 10],
  ] as const) {
    test(`--${key} ${value} は ${expected}`, async () => {
      const result = await sg(['call', 'lantern-set', `--${key}`, value]);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(result.calls.at(-1)!.body, { [key]: expected });
    });
  }

  for (const json of ['{"count":1e400}', '{"label":"x","brightness":-1e999}', '{"nested":{"list":[1,2e500]}}']) {
    test(`JSON の入力に有限でない数（${json}）があれば 2 で、送らない`, async () => {
      usageError(await sg(['call', 'lantern-set', json]));
    });
  }
});

describe('余分な引数を断る', () => {
  for (const argv of [
    ['ops', '--foo', 'bar'],
    ['ops', '--count', '1'],
    ['config', 'show', 'extra'],
    ['config', 'show', '--foo', 'bar'],
    ['config', 'use', 'main', '--foo', 'bar'],
    ['config', 'use', 'main', 'sub'],
    ['config', 'set', 'url', URL_B, '--foo', 'bar'],
    ['config', 'set', 'url', URL_B, 'extra'],
    ['config', 'set', 'org', 'kaede', '--org', 'x'],
    ['config', 'set', 'token', '--foo', 'bar'],
    ['call', 'lantern-set', '--count', '1', '--count', '2'],
    ['call', 'lantern-set', '--label', 'a', '--label', 'a'],
    ['call', 'lantern-set', '{}', 'extra'],
  ]) {
    test(argv.join(' '), async () => {
      const config = memoryStore(twoProfiles());
      const result = await sg(argv, { config, stdin: `${TOKEN_B}\n` });
      assert.equal(result.code, 2, result.stderr);
      assert.equal(JSON.parse(result.stderr).error.code, 'usage');
      assert.deepEqual(config.current(), twoProfiles());
      assert.ok(result.calls.every((call) => !call.url.includes('/api/lantern')));
    });
  }
});

describe('想定外の失敗を connection_failed（3）にしない', () => {
  const html = () => new Response('<html>gateway</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });

  test('一覧の応答が 2xx で JSON でなければ invalid_response で 1', async () => {
    const result = await sg(['ops'], {
      fetcher: (async () => html()) as typeof fetch,
    });
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).error.code, 'invalid_response');
    assert.ok(!result.stderr.includes(TOKEN_A));
  });

  for (const body of [{ operations: 'x' }, { nope: [] }, { operations: [null] }, { operations: [{ name: 1 }] }]) {
    test(`一覧の形が不正（${JSON.stringify(body)}）なら invalid_response で 1`, async () => {
      const result = await sg(['ops'], { fetcher: (async () => Response.json(body)) as typeof fetch });
      assert.equal(result.code, 1);
      assert.equal(JSON.parse(result.stderr).error.code, 'invalid_response');
    });
  }

  test('操作の応答が 2xx で JSON でなければ invalid_response で 1', async () => {
    const result = await sg(['call', 'lantern-set'], { handler: html });
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).error.code, 'invalid_response');
  });

  test('3 は fetch が投げたときだけ', async () => {
    const result = await sg(['ops'], {
      fetcher: (async () => {
        throw new Error('connect ECONNREFUSED');
      }) as typeof fetch,
    });
    assert.equal(result.code, 3);
  });
});

describe('一覧に無い操作', () => {
  test('message は、無い操作かこのトークンでは呼べない操作と示し、終了コードは 2', async () => {
    for (const argv of [
      ['call', 'ghost-op'],
      ['ops', 'ghost-op'],
    ]) {
      const result = await sg(argv);
      assert.equal(result.code, 2);
      assert.equal(
        JSON.parse(result.stderr).error.message,
        '操作が一覧に無い（無い操作か、このトークンでは呼べない操作）',
      );
    }
  });
});

describe('変異で生き残った箇所', () => {
  test('一覧の取得が 401 なら sg ops は 1 で、status を出す', async () => {
    const result = await sg(['ops'], {
      fetcher: (async () => Response.json({ error: { code: 'unauthorized' } }, { status: 401 })) as typeof fetch,
    });
    assert.equal(result.code, 1);
    assert.deepEqual(JSON.parse(result.stderr), { status: 401, error: { code: 'unauthorized' } });
  });

  test('壊れた設定ファイルへの config set は 2 で、設定を変えない', async () => {
    let writes = 0;
    const config: ConfigStore = {
      read: async () => {
        throw new SyntaxError(`Unexpected token in ${TOKEN_A}`);
      },
      write: async () => {
        writes += 1;
      },
    };
    const result = await sg(['config', 'set', 'url', URL_B], { config });
    usageError(result, [TOKEN_A]);
    assert.equal(writes, 0);
  });

  test('偽 fetch が token を含む誤りを投げても、出力にトークンが出ない', async () => {
    const result = await sg(['ops'], {
      env: { SG_URL: URL_A, SG_TOKEN: TOKEN_ENV },
      fetcher: (async () => {
        throw new Error(`bad Bearer ${TOKEN_ENV}`);
      }) as typeof fetch,
    });
    assert.equal(result.code, 3);
    assert.ok(!result.stderr.includes(TOKEN_ENV), result.stderr);
    assert.ok(!result.stdout.includes(TOKEN_ENV));
  });

  test('"token": 123 の設定ファイルは 2', async () => {
    const config = { profiles: { main: { url: URL_A, token: 123 } } } as unknown as Config;
    usageError(await sg(['ops'], { config: memoryStore(config) }));
  });

  test('入力の workspace_id が空の文字列なら、補わずにそのまま送る', async () => {
    const result = await sg(['call', 'lantern-ws', '{"workspace_id":""}']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.calls.at(-1)!.body, { workspace_id: '' });
  });
});
