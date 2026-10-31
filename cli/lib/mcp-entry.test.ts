// sg の入口（cli/sg.ts）の mcp を、子プロセスで確かめる。標準入出力の MCP、標準入力が閉じたときの終了、起動の誤りの終了コード 2
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../sg.ts', import.meta.url));
const TOKEN = `sgp_${'M'.repeat(43)}`;

function run(args: string[], env: Record<string, string>, input: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'sg-mcp-home-'));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, ...args], {
      env: { PATH: process.env.PATH, HOME: home, ...env } as NodeJS.ProcessEnv,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('終わらない'));
    }, 20_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      rmSync(home, { recursive: true, force: true });
      resolve({ code, stdout, stderr });
    });
    // 入力を書き終えたら標準入力を閉じる（クライアントの終了と同じ）
    child.stdin.end(input.map((line) => line + '\n').join(''));
  });
}

describe('sg mcp（子プロセス）', () => {
  test('標準入力で initialize と tools/list を受け、標準出力にはプロトコルだけを出し、標準入力が閉じたら 0 で終わる', async () => {
    const server = createServer((request, response) => {
      assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          operations: [
            {
              name: 'who-am-i',
              description: '自分を返す',
              mode: 'read',
              scope: 'outside',
              permission: 'login',
              input_schema: { type: 'object', properties: {}, required: [] },
              output_schema: { type: 'object' },
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const result = await run(['mcp'], { SG_URL: url, SG_TOKEN: TOKEN }, [
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
        }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      ]);
      assert.equal(result.code, 0, result.stderr);
      const lines = result.stdout.trim().split('\n');
      // 標準出力の各行が JSON-RPC のメッセージ
      const messages = lines.map((line) => JSON.parse(line));
      assert.ok(messages.every((message) => message.jsonrpc === '2.0'));
      const list = messages.find((message) => message.id === 2);
      assert.deepEqual(
        list.result.tools.map((tool: { name: string }) => tool.name),
        ['who-am-i'],
      );
      assert.ok(!result.stdout.includes(TOKEN));
      assert.ok(!result.stderr.includes(TOKEN));
    } finally {
      server.close();
    }
  });

  test('クライアントが先に消えて標準出力が EPIPE になっても、スタックトレースを出さず静かに終わる', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sg-mcp-home-'));
    try {
      const child = spawn(process.execPath, [ENTRY, 'mcp'], {
        env: { PATH: process.env.PATH, HOME: home, SG_URL: 'http://127.0.0.1:9', SG_TOKEN: TOKEN } as NodeJS.ProcessEnv,
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += chunk));
      const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
      // 読み手を先に閉じる。標準入力は開けたままにして、サーバーが応答を書こうとして EPIPE になるようにする
      child.stdout.destroy();
      const timer = setTimeout(() => child.kill(), 20_000);
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
        }) + '\n',
      );
      const code = await exited;
      clearTimeout(timer);
      assert.equal(code, 0, stderr);
      assert.ok(!/EPIPE|\n\s+at /.test(stderr), stderr);
      assert.ok(!stderr.includes(TOKEN));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('--allow-write は子プロセスまで届く。既定は読み取りの道具だけで、付けると書き込みの道具も出る', async () => {
    const operation = (name: string, mode: string) => ({
      name,
      description: name,
      mode,
      scope: 'outside',
      permission: 'login',
      input_schema: { type: 'object', properties: {}, required: [] },
      output_schema: { type: 'object' },
    });
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ operations: [operation('reader', 'read'), operation('writer', 'write')] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const input = [
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    ];
    const toolNames = async (args: string[]) => {
      const result = await run(args, { SG_URL: url, SG_TOKEN: TOKEN }, input);
      assert.equal(result.code, 0, result.stderr);
      const list = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find((message) => message.id === 2);
      return list.result.tools.map((tool: { name: string }) => tool.name);
    };
    try {
      assert.deepEqual(await toolNames(['mcp']), ['reader']);
      assert.deepEqual(await toolNames(['mcp', '--allow-write']), ['reader', 'writer']);
    } finally {
      server.close();
    }
  });

  test('接続先が無いと stderr に JSON を出して 2、stdout は空', async () => {
    const result = await run(['mcp'], {}, []);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, 'usage');
  });
});
