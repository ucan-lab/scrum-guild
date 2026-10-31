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

  test('接続先が無いと stderr に JSON を出して 2、stdout は空', async () => {
    const result = await run(['mcp'], {}, []);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, 'usage');
  });
});
