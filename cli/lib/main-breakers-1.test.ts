// sg の本体（main）を崩しにいくテスト。期待は Issue #582 の前提と受け入れ条件に照らす
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileConfigStore } from './config-file.ts';
import { main, type CliDeps, type Config, type ConfigStore } from './main.ts';

const URL_MAIN = 'https://guild.example';
const TOKEN = `sgp_${'K'.repeat(43)}`;

const catalog = {
  operations: [
    {
      name: 'lantern-set',
      description: '灯りの数を決める',
      mode: 'write',
      scope: 'outside',
      permission: 'login',
      input_schema: {
        type: 'object',
        properties: { count: { type: 'integer' }, brightness: { type: 'number' } },
        required: [],
      },
      output_schema: { type: 'object', properties: {} },
    },
  ],
};

// node の fetch と同じく、送る前に new Request でヘッダーを確かめる偽のサーバー（実際には外へ出ない）
function fakeServer() {
  const bodies: unknown[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === '/api/operation-list') return Response.json(catalog);
    bodies.push(JSON.parse(await request.text()));
    return Response.json({ ok: true });
  }) as typeof fetch;
  return { fetcher, bodies };
}

function memoryStore(initial?: Config): ConfigStore {
  let saved = initial === undefined ? undefined : structuredClone(initial);
  return {
    read: async () => (saved === undefined ? undefined : structuredClone(saved)),
    write: async (config) => {
      saved = structuredClone(config);
    },
  };
}

async function sg(
  argv: string[],
  options: {
    config: ConfigStore;
    env?: Record<string, string>;
    stdin?: string;
    server?: ReturnType<typeof fakeServer>;
  },
) {
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
    config: options.config,
  };
  const code = await main(argv, deps);
  return { code, stdout, stderr, server };
}

const oneProfile = (): Config => ({ default_profile: 'main', profiles: { main: { url: URL_MAIN, token: TOKEN } } });

describe('引数の数の変換', () => {
  // 前提「number と integer は数 … 変えられない値 … は使い方の誤り（2）」。空の文字列は数ではないが、Number('') は 0 になる
  for (const key of ['count', 'brightness']) {
    test(`--${key} に空の文字列を渡すと 0 を送らず使い方の誤り（2）`, async () => {
      const result = await sg(['call', 'lantern-set', `--${key}`, ''], { config: memoryStore(oneProfile()) });
      assert.deepEqual(result.server.bodies, []);
      assert.equal(result.code, 2, result.stderr);
    });
  }
});

describe('トークンを出力に出さない', () => {
  // 受け入れ条件「トークンが標準出力、ログ、シェルの履歴に出ない」と前提「どの出力にもトークンを含めない」。
  // 改行を含むトークン（2 行目にメモのあるファイルを貼った、など）は fetch がヘッダーの誤りとして投げ、その message に値がそのまま入る。
  // メモが ASCII でないと ByteString の誤り（値を含まない message）になるので、ASCII のメモで確かめる
  const MEMO = '# expires 2026-12-31';
  for (const [label, run] of [
    [
      '標準入力から config set token で入れたとき',
      async () => {
        const config = memoryStore({ default_profile: 'main', profiles: { main: { url: URL_MAIN } } });
        const set = await sg(['config', 'set', 'token'], { config, stdin: `${TOKEN}\n${MEMO}\n` });
        assert.equal(set.code, 0);
        return sg(['ops'], { config });
      },
    ],
    [
      '環境変数 SG_TOKEN で渡したとき',
      () =>
        sg(['ops'], {
          config: memoryStore(),
          env: { SG_URL: URL_MAIN, SG_TOKEN: `${TOKEN}\n${MEMO}` },
        }),
    ],
  ] as const) {
    test(`改行を含むトークンを${label}も、標準エラーにトークンが出ない`, async () => {
      const result = await run();
      assert.notEqual(result.code, 0);
      assert.ok(!result.stdout.includes(TOKEN), result.stdout);
      assert.ok(!result.stderr.includes(TOKEN), result.stderr);
    });
  }
});

describe('壊れた設定ファイル', () => {
  // 終了コードは「API のエラー 1、使い方の誤り（…設定が無い）2、サーバーにつながらない 3」。
  // 設定ファイルが読めないのはつながらないことではなく、サーバーへ送る前の設定の誤り
  test('JSON として読めない設定ファイルは、つながらない（3）ではなく使い方の誤り（2）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sg-breakers-'));
    const path = join(dir, 'config.json');
    await writeFile(path, `{"profiles":{"main":{"url":"${URL_MAIN}","token":"${TOKEN}",}}}`, { mode: 0o600 });
    const server = fakeServer();
    const result = await sg(['ops'], { config: fileConfigStore(path), server });
    assert.ok(!result.stderr.includes(TOKEN), result.stderr);
    assert.equal(result.code, 2, result.stderr);
  });
});
