// sg の入口（cli/sg.ts）を子プロセスで動かし、設定ファイルのストアの書き込みを崩しにいくテスト。期待は Issue #582 の前提と受け入れ条件に照らす
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fileConfigStore } from './config-file.ts';
import { main, type CliDeps } from './main.ts';

const ENTRY = fileURLToPath(new URL('../sg.ts', import.meta.url));
const TOKEN = `sgp_${'M'.repeat(43)}`;

const catalog = {
  operations: [
    {
      name: 'lantern-set',
      description: '灯りの数を決める',
      mode: 'write',
      scope: 'outside',
      permission: 'login',
      input_schema: { type: 'object', properties: { count: { type: 'integer' } }, required: [] },
      output_schema: { type: 'object', properties: {} },
    },
    {
      name: 'lantern-forbidden',
      description: '権限の無い人には 403 を返す',
      mode: 'write',
      scope: 'outside',
      permission: 'login',
      input_schema: { type: 'object', properties: {}, required: [] },
      output_schema: { type: 'object', properties: {} },
    },
  ],
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sg-breakers-3-'));
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

// 子プロセスの sg から呼ばれる小さなサーバー。受けた Authorization と本文を記録する
const received: { path: string; authorization: string | undefined; body: string }[] = [];
let server: Server;
let serverUrl: string;

before(async () => {
  server = createServer(async (request, response) => {
    const body = await bodyOf(request);
    received.push({ path: request.url ?? '', authorization: request.headers.authorization, body });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/operation-list') return response.end(JSON.stringify(catalog));
    if (request.url === '/api/lantern-forbidden') {
      response.statusCode = 403;
      return response.end(JSON.stringify({ error: { code: 'forbidden' } }));
    }
    response.end(JSON.stringify({ lit: (JSON.parse(body) as { count?: number }).count ?? 0 }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// 本物の入口を子プロセスで動かす。サーバーが同じプロセスにいるので、同期の spawnSync は使わない
function sg(
  argv: string[],
  env: Record<string, string | undefined>,
  stdin = '',
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [ENTRY, ...argv],
      { env: { PATH: process.env.PATH, ...env } as NodeJS.ProcessEnv },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
        resolve({ code, stdout, stderr });
      },
    );
    child.stdin!.end(stdin);
  });
}

describe('入口（cli/sg.ts）を子プロセスで動かす', () => {
  test('標準入力から設定したトークンで ops と call を呼べ、終了コードがプロセスに渡り、出力にトークンが出ない', async () => {
    const home = tempDir();
    try {
      const env = { HOME: home, XDG_CONFIG_HOME: join(home, 'xdg') };
      assert.equal((await sg(['config', 'set', 'url', serverUrl], env)).code, 0);
      const setToken = await sg(['config', 'set', 'token'], env, `${TOKEN}\n`);
      assert.equal(setToken.code, 0);
      assert.ok(!setToken.stdout.includes(TOKEN) && !setToken.stderr.includes(TOKEN));

      const path = join(home, 'xdg', 'scrum-guild', 'config.json');
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(JSON.parse(readFileSync(path, 'utf8')).profiles.main.token, TOKEN);

      received.length = 0;
      const call = await sg(['call', 'lantern-set', '--count', '4'], env);
      assert.equal(call.code, 0, call.stderr);
      assert.deepEqual(JSON.parse(call.stdout), { lit: 4 });
      assert.ok(received.every((request) => request.authorization === `Bearer ${TOKEN}`));
      assert.deepEqual(JSON.parse(received.at(-1)!.body), { count: 4 });

      const forbidden = await sg(['call', 'lantern-forbidden'], env);
      assert.equal(forbidden.code, 1);
      assert.deepEqual(JSON.parse(forbidden.stderr), { status: 403, error: { code: 'forbidden' } });

      const show = await sg(['config', 'show'], env);
      assert.equal(show.code, 0);
      for (const result of [call, forbidden, show]) {
        assert.ok(!result.stdout.includes(TOKEN) && !result.stderr.includes(TOKEN));
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('つながらない URL では終了コード 3 がプロセスに渡り、トークンが出ない', async () => {
    const home = tempDir();
    try {
      const result = await sg(['ops'], { HOME: home, SG_URL: 'http://127.0.0.1:9', SG_TOKEN: TOKEN });
      assert.equal(result.code, 3);
      assert.equal(JSON.parse(result.stderr).error.code, 'connection_failed');
      assert.ok(!result.stdout.includes(TOKEN) && !result.stderr.includes(TOKEN));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // XDG Base Directory の決まり: XDG_CONFIG_HOME が空なら、未設定と同じく $HOME/.config を使う。
  // docs/development.md も「未設定なら ~/.config/scrum-guild/config.json」、Issue の前提も ~/.config/scrum-guild/config.json
  test('XDG_CONFIG_HOME が空の文字列なら、~/.config/scrum-guild/config.json に書く', async () => {
    const home = tempDir();
    try {
      const result = await sg(['config', 'set', 'url', serverUrl], { HOME: home, XDG_CONFIG_HOME: '' });
      assert.equal(result.code, 0, result.stderr);
      assert.ok(existsSync(join(home, '.config', 'scrum-guild', 'config.json')));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('設定ファイルの書き込み（前提「設定ファイルは本人だけが読める権限で書く」）', () => {
  // writeFile の mode は新しく作るときにしか効かない。既にある 0644 のファイルには、トークンを書いた後で chmod するまで
  // 他人が読める。書き込みの直後（chmod の前）のファイルの権限とその中身を見る
  test('既にある 0644 のファイルに書くときも、トークンが他人に読める権限のファイルに置かれる瞬間が無い', async () => {
    const dir = tempDir();
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ profiles: {} }));
    chmodSync(path, 0o644);
    const exposed: number[] = [];
    const original = fsPromises.writeFile;
    const observed = async (...args: Parameters<typeof original>) => {
      await original(...args);
      if (args[0] === path && readFileSync(path, 'utf8').includes(TOKEN)) exposed.push(statSync(path).mode & 0o777);
    };
    fsPromises.writeFile = observed as typeof original;
    syncBuiltinESMExports();
    try {
      await fileConfigStore(path).write({ profiles: { main: { url: 'https://guild.example', token: TOKEN } } });
    } finally {
      fsPromises.writeFile = original;
      syncBuiltinESMExports();
      rmSync(dir, { recursive: true, force: true });
    }
    assert.ok(exposed.length > 0, 'writeFile を観察できた');
    for (const mode of exposed) assert.equal(mode & 0o077, 0, `トークンを持つファイルが ${mode.toString(8)} だった`);
  });
});

describe('設定ファイルを書けないとき（Issue: 終了コード 3 は「サーバーにつながらないとき」）', () => {
  function depsFor(path: string): CliDeps & { output: () => string } {
    let stderr = '';
    return {
      fetch: (async () => {
        throw new Error('呼ばない');
      }) as typeof fetch,
      env: {},
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      readStdin: async () => `${TOKEN}\n`,
      config: fileConfigStore(path),
      output: () => stderr,
    };
  }

  test('読めない設定ファイルは 2（実装の既存の扱い）', async (context) => {
    if (process.getuid?.() === 0) return context.skip('root は権限を無視する');
    const dir = tempDir();
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ profiles: {} }));
    chmodSync(path, 0o000);
    try {
      assert.equal(await main(['config', 'set', 'url', 'https://guild.example'], depsFor(path)), 2);
    } finally {
      chmodSync(path, 0o600);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // サーバーに何も送っていないのに connection_failed と 3 を返すと、呼び手はつながらないと誤る。読めないときの 2 とも食い違う
  test('書けない場所の設定ファイルへの config set は、つながらない（3、connection_failed）にしない', async (context) => {
    if (process.getuid?.() === 0) return context.skip('root は権限を無視する');
    const dir = tempDir();
    const locked = join(dir, 'scrum-guild');
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      for (const argv of [
        ['config', 'set', 'url', 'https://guild.example'],
        ['config', 'set', 'token'],
      ]) {
        const deps = depsFor(join(locked, 'config.json'));
        const code = await main(argv, deps);
        assert.notEqual(code, 0, argv.join(' '));
        assert.notEqual(code, 3, `${argv.join(' ')}: ${deps.output()}`);
        assert.ok(!deps.output().includes('connection_failed'), deps.output());
        assert.ok(!deps.output().includes(TOKEN));
      }
    } finally {
      chmodSync(locked, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
