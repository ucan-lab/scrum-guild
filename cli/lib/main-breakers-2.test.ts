// sg の本体（main）を崩しにいくテストの2周目。期待は Issue #582 の前提と受け入れ条件に照らす
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileConfigStore } from './config-file.ts';
import { main, type CliDeps, type Config, type ConfigStore } from './main.ts';

const URL_MAIN = 'https://lantern.guild.example';
const TOKEN = `sgp_${'L'.repeat(43)}`;
const TOKEN_ENV = `sgp_${'V'.repeat(43)}`;

const object = (properties: Record<string, unknown>) => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties,
  required: [],
});

// z.toJSONSchema（io: 'input'）が出しうる形の見本
const catalog = {
  operations: [
    {
      name: 'beacon-set',
      description: '目印を決める',
      mode: 'write',
      scope: 'outside',
      permission: 'login',
      input_schema: object({
        // z.enum(['1', '2'])。数に見える文字列の enum
        shelf: { type: 'string', enum: ['1', '2'] },
        // z.boolean().nullable()
        lit: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
        // z.union([z.literal('me'), z.string()]).nullable()（backlog-tree の assignee_user_id と同じ形）
        keeper: { anyOf: [{ anyOf: [{ type: 'string', const: 'me' }, { type: 'string' }] }, { type: 'null' }] },
        // z.string()。null を許さない
        label: { type: 'string' },
        // z.union([z.string(), z.boolean()])
        flag: { anyOf: [{ type: 'string' }, { type: 'boolean' }] },
        // z.union([z.string(), z.number()])
        size: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      }),
      output_schema: object({}),
    },
    {
      // z.discriminatedUnion で、分岐ごとに同じ名前の項目の型が違う
      name: 'beacon-aim',
      description: '目印の向きを決める',
      mode: 'write',
      scope: 'outside',
      permission: 'login',
      input_schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        oneOf: [
          {
            type: 'object',
            properties: { by: { type: 'string', const: 'name' }, target: { type: 'string' } },
            required: ['by', 'target'],
          },
          {
            type: 'object',
            properties: { by: { type: 'string', const: 'degree' }, target: { type: 'integer' } },
            required: ['by', 'target'],
          },
        ],
      },
      output_schema: object({}),
    },
  ],
};

function fakeServer() {
  const bodies: unknown[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === '/api/operation-list') return Response.json(catalog);
    bodies.push(JSON.parse(await request.text()));
    return Response.json({ ok: true });
  }) as typeof fetch;
  return { fetcher, bodies };
}

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

async function sg(
  argv: string[],
  options: { config?: ConfigStore; env?: Record<string, string>; stdin?: string } = {},
) {
  const server = fakeServer();
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
  return { code, stdout, stderr, server };
}

const oneProfile = (): Config => ({ default_profile: 'main', profiles: { main: { url: URL_MAIN, token: TOKEN } } });

function usageError(result: { code: number; stderr: string }) {
  assert.equal(result.code, 2, result.stderr);
  assert.equal(JSON.parse(result.stderr).error.code, 'usage');
}

describe('引数の型の変換の境目（前提「引数の値は入力の JSON Schema の型で変える」）', () => {
  for (const [label, args, expected] of [
    ['数に見える文字列の enum は文字列のまま', ['--shelf', '1'], { shelf: '1' }],
    ['boolean と null の組に null を渡すと null', ['--lit', 'null'], { lit: null }],
    ['boolean と null の組に false を渡すと false', ['--lit', 'false'], { lit: false }],
    ['入れ子の anyOf の文字列の const に一致する値は文字列', ['--keeper', 'me'], { keeper: 'me' }],
    ['入れ子の anyOf の null を許す項目に null を渡すと null', ['--keeper', 'null'], { keeper: null }],
    ['null を許さない string の項目に null を渡すと文字列の "null"', ['--label', 'null'], { label: 'null' }],
  ] as const) {
    test(label, async () => {
      const result = await sg(['call', 'beacon-set', ...args]);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(result.server.bodies, [expected]);
    });
  }

  test('boolean と null の組に true / false / null 以外を渡すと 2 で、操作を呼ばない', async () => {
    const result = await sg(['call', 'beacon-set', '--lit', 'yes']);
    usageError(result);
    assert.deepEqual(result.server.bodies, []);
  });

  // 前提「string はそのまま … 変えられない値 … は使い方の誤り（2）」と受け入れ条件「サーバーに操作の定義を足すと、CLI を作り直さずに使える」。
  // string を許す項目に渡した文字列は、そのまま string として送れる値で「変えられない値」ではない。
  // 今の valueOf は boolean / integer / number を string より先に見て、合わなければその場で使い方の誤りにする
  for (const [label, args, expected] of [
    ['string と boolean の union に文字列を渡すと、文字列のまま送る', ['--flag', 'auto'], { flag: 'auto' }],
    ['string と number の union に数でない文字列を渡すと、文字列のまま送る', ['--size', 'large'], { size: 'large' }],
  ] as const) {
    test(label, async () => {
      const result = await sg(['call', 'beacon-set', ...args]);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(result.server.bodies, [expected]);
    });
  }

  test('分岐ごとに型が違う項目（string と integer）に、string の分岐の値を渡せる', async () => {
    const result = await sg(['call', 'beacon-aim', '--by', 'name', '--target', 'north']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.server.bodies, [{ by: 'name', target: 'north' }]);
  });
});

describe('ops の使い方の誤り', () => {
  test('ops に操作名を2つ渡すと 2', async () => {
    usageError(await sg(['ops', 'beacon-set', 'beacon-aim']));
  });
});

describe('config の書き込みの経路', () => {
  test('config use に無い接続先を渡すと 2 で、default_profile を変えない', async () => {
    const config = memoryStore(oneProfile());
    usageError(await sg(['config', 'use', 'ghost'], { config }));
    assert.equal(config.current()!.default_profile, 'main');
    assert.deepEqual(Object.keys(config.current()!.profiles), ['main']);
  });

  // 前提「トークンと URL は環境変数か設定ファイルから読み」「環境変数が設定ファイルに勝つ」。環境変数は読むだけで、設定に書き写さない
  test('SG_TOKEN を付けたまま config set url しても、環境変数のトークンを設定に保存しない', async () => {
    const config = memoryStore({ default_profile: 'main', profiles: { main: {} } });
    const result = await sg(['config', 'set', 'url', URL_MAIN], { config, env: { SG_TOKEN: TOKEN_ENV } });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(config.current()!.profiles.main, { url: URL_MAIN });
  });

  test('SG_PROFILE を付けた config set は、その名前の接続先に書き、ほかの接続先と既定を変えない', async () => {
    const config = memoryStore(oneProfile());
    const result = await sg(['config', 'set', 'org', 'kaede'], { config, env: { SG_PROFILE: 'night' } });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(config.current(), {
      default_profile: 'main',
      profiles: { main: { url: URL_MAIN, token: TOKEN }, night: { org: 'kaede' } },
    });
  });
});

describe('JSON としては読めるが、形の違う設定ファイル', () => {
  // 受け入れ条件「使い方の誤り（無い操作名、壊れた JSON、設定が無い）は 2、サーバーにつながらないときは 3」。
  // 接続先を profiles の下に置かず、url と token を最上位に書いた設定（前提の形は { default_profile, profiles: { <名前>: {...} } }）は、
  // サーバーへ送る前の設定の誤り。今は config.profiles[name] の TypeError が main の最後の catch に落ち、connection_failed（3）になる
  async function flatConfig() {
    const dir = await mkdtemp(join(tmpdir(), 'sg-breakers-2-'));
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ url: URL_MAIN, token: TOKEN }), { mode: 0o600 });
    return { path, store: fileConfigStore(path) };
  }

  test('sg ops は、つながらない（3）ではなく使い方の誤り（2）で、トークンを出さない', async () => {
    const { store } = await flatConfig();
    const result = await sg(['ops'], { config: store });
    assert.ok(!result.stderr.includes(TOKEN), result.stderr);
    assert.deepEqual(result.server.bodies, []);
    usageError(result);
  });

  test('sg config set url は、つながらない（3）ではなく使い方の誤り（2）で、ファイルを書き換えない', async () => {
    const { path, store } = await flatConfig();
    const before = await readFile(path, 'utf8');
    const result = await sg(['config', 'set', 'url', 'https://other.guild.example'], { config: store });
    usageError(result);
    assert.equal(await readFile(path, 'utf8'), before);
  });
});
