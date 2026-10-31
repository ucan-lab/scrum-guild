// sg mcp のサーバー（mcp-server.ts）を、SDK の Client と InMemoryTransport で tools/list と tools/call を通して確かめる
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CliDeps, Config } from './main.ts';
import { runMcp } from './mcp-server.ts';

const TOKEN = `sgp_${'M'.repeat(43)}`;
const OTHER_TOKEN = `sgp_${'E'.repeat(43)}`;

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties,
  required,
});

let operations: unknown[] = [];
const resetOperations = () => {
  operations = [
    {
      name: 'who-am-i',
      description: 'ログインしているアカウントを返す',
      mode: 'read',
      scope: 'outside',
      permission: 'login',
      input_schema: object({}),
      output_schema: object({ account_id: { type: 'string' } }, ['account_id']),
    },
    {
      name: 'task-edit',
      description: 'タスクを書き換える',
      mode: 'write',
      scope: 'workspace',
      permission: 'member',
      input_schema: object({ workspace_id: { type: 'string' }, title: { type: 'string' } }, ['workspace_id', 'title']),
      output_schema: object({}),
    },
  ];
};

type Seen = { path: string; authorization: string | null; body: unknown };

function setup(config: Config | undefined, env: Record<string, string> = {}) {
  const seen: Seen[] = [];
  let stdout = '';
  let stderr = '';
  const deps: CliDeps = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const text = await request.text();
      const path = new URL(request.url).pathname;
      seen.push({
        path,
        authorization: request.headers.get('Authorization'),
        body: text === '' ? undefined : JSON.parse(text),
      });
      const body = path.endsWith('/operation-list') ? { operations } : { path };
      return Response.json(body);
    }) as typeof fetch,
    env,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    readStdin: async () => '',
    config: { read: async () => config, write: async () => {} },
  };
  return { deps, seen, output: () => ({ stdout, stderr }) };
}

const profile = (extra: Record<string, string> = {}): Config => ({
  default_profile: 'main',
  profiles: { main: { url: 'https://guild.example', token: TOKEN, ...extra } },
});

async function connected(args: string[], world: ReturnType<typeof setup>) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const done = runMcp(args, world.deps, serverSide);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientSide);
  return { client, done };
}

describe('sg mcp', () => {
  test('tools/list で操作の一覧が道具として見える。サーバーに足すと次の tools/list で増える', async () => {
    resetOperations();
    const world = setup(profile({ org: 'aoba', workspace: 'ws-1' }));
    const { client, done } = await connected(['--allow-write'], world);
    const first = await client.listTools();
    assert.deepEqual(
      first.tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint]),
      [
        ['who-am-i', true],
        ['task-edit', false],
      ],
    );
    assert.deepEqual(first.tools[1]!.inputSchema.required, ['title']);

    operations.push({
      name: 'lantern-light',
      description: '灯りをともす',
      mode: 'write',
      scope: 'outside',
      permission: 'login',
      input_schema: object({ count: { type: 'integer' } }, ['count']),
      output_schema: object({}),
    });
    const second = await client.listTools();
    assert.deepEqual(
      second.tools.map((tool) => tool.name),
      ['who-am-i', 'task-edit', 'lantern-light'],
    );
    await client.close();
    assert.equal(await done, 0);
  });

  test('tools/call でトークン付きの API を呼び、本文の JSON を text で返す', async () => {
    resetOperations();
    const world = setup(profile({ org: 'aoba', workspace: 'ws-1' }));
    const { client, done } = await connected(['--allow-write'], world);
    const result = await client.callTool({ name: 'task-edit', arguments: { title: '新しい題名' } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify({ path: '/api/aoba/task-edit' }) }]);
    const call = world.seen.find((item) => item.path === '/api/aoba/task-edit')!;
    assert.equal(call.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(call.body, { title: '新しい題名', workspace_id: 'ws-1' });
    await client.close();
    await done;
  });

  test('一覧に無い道具を呼ぶと isError の結果で、サーバーは落ちない', async () => {
    resetOperations();
    const world = setup(profile({ org: 'aoba' }));
    const { client, done } = await connected([], world);
    const result = await client.callTool({ name: 'no-such-tool', arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse((result.content as { text: string }[])[0]!.text).error.code, 'usage');
    // 続けて呼べる
    assert.equal((await client.callTool({ name: 'who-am-i', arguments: {} })).isError, undefined);
    await client.close();
    await done;
  });

  test('--profile、--org、--workspace を sg call と同じ意味で受ける', async () => {
    resetOperations();
    const config: Config = {
      default_profile: 'main',
      profiles: {
        main: { url: 'https://guild.example', token: TOKEN, org: 'aoba' },
        sub: { url: 'https://sub.example', token: OTHER_TOKEN, org: 'sub-org' },
      },
    };
    const world = setup(config);
    const { client, done } = await connected(
      ['--profile', 'sub', '--org', 'momiji', '--workspace', 'ws-9', '--allow-write'],
      world,
    );
    const tools = await client.listTools();
    assert.deepEqual(tools.tools[1]!.inputSchema.required, ['title']);
    await client.callTool({ name: 'task-edit', arguments: { title: 'x' } });
    const call = world.seen.find((item) => item.path.endsWith('/task-edit'))!;
    assert.equal(call.path, '/api/momiji/task-edit');
    assert.equal(call.authorization, `Bearer ${OTHER_TOKEN}`);
    assert.deepEqual(call.body, { title: 'x', workspace_id: 'ws-9' });
    await client.close();
    await done;
  });

  test('標準出力と標準エラーに何も書かず、トークンはどこにも出ない', async () => {
    resetOperations();
    const world = setup(profile({ org: 'aoba' }));
    const { client, done } = await connected([], world);
    await client.listTools();
    await client.callTool({ name: 'who-am-i', arguments: {} });
    await client.callTool({ name: 'no-such-tool', arguments: {} });
    await client.close();
    await done;
    assert.deepEqual(world.output(), { stdout: '', stderr: '' });
  });

  test('一覧が取れないときの tools/list はプロトコルの誤りで、トークンを含まない', async () => {
    resetOperations();
    const world = setup(profile());
    world.deps.fetch = (async () => {
      throw new TypeError(`fetch failed ${TOKEN}`);
    }) as typeof fetch;
    const { client, done } = await connected([], world);
    await assert.rejects(client.listTools(), (error: Error) => {
      assert.ok(error.message.includes('connection_failed'));
      assert.ok(!error.message.includes(TOKEN));
      return true;
    });
    await client.close();
    await done;
  });
});

describe('sg mcp の起動の誤り', () => {
  const startupError = async (args: string[], world: ReturnType<typeof setup>) => {
    const [, serverSide] = InMemoryTransport.createLinkedPair();
    const code = await runMcp(args, world.deps, serverSide);
    return { code, ...world.output() };
  };

  test('接続先が無いと stderr に JSON を出して 2。stdout は空', async () => {
    const result = await startupError([], setup(undefined));
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, 'usage');
  });

  test('存在しない --profile は 2', async () => {
    const result = await startupError(['--profile', 'nope'], setup(profile()));
    assert.equal(result.code, 2);
  });

  test('余分な引数は 2', async () => {
    assert.equal((await startupError(['extra'], setup(profile()))).code, 2);
    assert.equal((await startupError(['--foo', 'bar'], setup(profile()))).code, 2);
  });

  test('エラーの出力にトークンを含めない', async () => {
    const result = await startupError([], setup(undefined, { SG_TOKEN: OTHER_TOKEN }));
    assert.equal(result.code, 2);
    assert.ok(!result.stderr.includes(OTHER_TOKEN));
  });
});

describe('sg mcp の --allow-write', () => {
  test('既定では読み取りの道具だけを出し、書き込みの道具の tools/call は isError', async () => {
    resetOperations();
    const world = setup(profile({ org: 'aoba', workspace: 'ws-1' }));
    const { client, done } = await connected([], world);
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ['who-am-i'],
    );
    const result = await client.callTool({ name: 'task-edit', arguments: { title: 'x' } });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse((result.content as { text: string }[])[0]!.text).error.code, 'usage');
    assert.ok(!world.seen.some((item) => item.path.endsWith('/task-edit')));
    await client.close();
    await done;
  });

  test('--allow-write が runMcp まで届き、書き込みの道具が出て呼べる。ほかのフラグと並べてもよい', async () => {
    resetOperations();
    const world = setup(profile({ org: 'aoba' }));
    const { client, done } = await connected(['--workspace', 'ws-9', '--allow-write'], world);
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ['who-am-i', 'task-edit'],
    );
    const result = await client.callTool({ name: 'task-edit', arguments: { title: 'x' } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(world.seen.find((item) => item.path.endsWith('/task-edit'))!.body, {
      title: 'x',
      workspace_id: 'ws-9',
    });
    await client.close();
    await done;
  });

  test('--allow-write が重なると 2', async () => {
    const world = setup(profile());
    const [, serverSide] = InMemoryTransport.createLinkedPair();
    assert.equal(await runMcp(['--allow-write', '--allow-write'], world.deps, serverSide), 2);
    assert.equal(JSON.parse(world.output().stderr).error.code, 'usage');
  });
});
