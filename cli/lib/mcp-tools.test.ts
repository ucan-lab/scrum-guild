// sg mcp の道具の一覧と呼び出し（mcp-tools.ts）を、偽の fetch と操作の一覧の見本で確かめる。決まりは Issue #583 の前提
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CliDeps, Connection } from './main.ts';
import { callTool, listTools } from './mcp-tools.ts';

const URL_MAIN = 'https://guild.example';
const TOKEN = `sgp_${'M'.repeat(43)}`;

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties,
  required,
});

const catalog = {
  operations: [
    {
      name: 'task-edit',
      description: 'タスクを書き換える',
      mode: 'write',
      scope: 'workspace',
      permission: 'member',
      input_schema: object({ workspace_id: { type: 'string' }, task_id: { type: 'string' } }, [
        'workspace_id',
        'task_id',
      ]),
      output_schema: object({ task_id: { type: 'string' } }, ['task_id']),
    },
    {
      name: 'task-get',
      description: 'タスクを返す',
      mode: 'read',
      scope: 'organization',
      permission: 'organization',
      input_schema: object({ task_id: { type: 'string' }, workspace_id: { type: 'string' } }, [
        'task_id',
        'workspace_id',
      ]),
      output_schema: object({ title: { type: 'string' } }, ['title']),
    },
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
      // 最上位が oneOf の入力（discriminatedUnion）。type が無い
      name: 'pick',
      description: '分岐の入力',
      mode: 'write',
      scope: 'workspace',
      permission: 'member',
      input_schema: {
        oneOf: [
          object({ workspace_id: { type: 'string' }, kind: { const: 'a' } }, ['workspace_id', 'kind']),
          object({ workspace_id: { type: 'string' }, kind: { const: 'b' } }, ['workspace_id', 'kind']),
        ],
      },
      output_schema: object({}),
    },
  ],
};

type Recorded = { path: string; authorization: string | null; body: unknown };
type Reply = { status: number; body: unknown };

function fakeServer(options: { reply?: (request: Recorded) => Reply; throws?: boolean; operations?: unknown } = {}) {
  const requests: Recorded[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (options.throws) throw new TypeError(`fetch failed ${TOKEN}`);
    const request = new Request(input, init);
    const text = await request.text();
    const recorded: Recorded = {
      path: new URL(request.url).pathname,
      authorization: request.headers.get('Authorization'),
      body: text === '' ? undefined : JSON.parse(text),
    };
    requests.push(recorded);
    const reply: Reply = recorded.path.endsWith('/api/operation-list')
      ? { status: 200, body: options.operations ?? catalog }
      : (options.reply?.(recorded) ?? { status: 200, body: { ok: true } });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  const calls = () => requests.filter((request) => !request.path.endsWith('/api/operation-list'));
  return { fetcher, requests, calls };
}

const depsOf = (server: ReturnType<typeof fakeServer>): CliDeps => ({
  fetch: server.fetcher,
  env: {},
  stdout: () => assert.fail('標準出力に書かない'),
  stderr: () => assert.fail('標準エラーに書かない'),
  readStdin: async () => '',
  config: { read: async () => undefined, write: async () => {} },
});

const connectionOf = (extra: Partial<Connection> = {}): Connection => ({ url: URL_MAIN, token: TOKEN, ...extra });

describe('listTools', () => {
  test('一覧の操作が道具になる。名前、説明、入力の Schema、readOnlyHint', async () => {
    const server = fakeServer();
    const tools = await listTools(depsOf(server), connectionOf());
    assert.deepEqual(
      tools.map((tool) => [tool.name, tool.description, tool.annotations.readOnlyHint]),
      [
        ['task-edit', 'タスクを書き換える', false],
        ['task-get', 'タスクを返す', true],
        ['who-am-i', 'ログインしているアカウントを返す', true],
        ['pick', '分岐の入力\n分岐: kind=a の必須: workspace_id, kind / kind=b の必須: workspace_id, kind', false],
      ],
    );
    const expected: Record<string, unknown> = { ...catalog.operations[0]!.input_schema };
    delete expected.$schema;
    assert.deepEqual(tools[0]!.inputSchema, expected);
    assert.ok(tools.every((tool) => tool.inputSchema.type === 'object'));
    assert.ok(tools.every((tool) => !('outputSchema' in tool)));
  });

  test('最上位が oneOf の入力にも type: object を付ける', async () => {
    const tools = await listTools(depsOf(fakeServer()), connectionOf());
    const pick = tools.find((tool) => tool.name === 'pick')!;
    assert.equal(pick.inputSchema.type, 'object');
    assert.ok(!('oneOf' in pick.inputSchema));
  });

  test('tools/list のたびに一覧を取る（キャッシュしない）', async () => {
    const server = fakeServer();
    const deps = depsOf(server);
    await listTools(deps, connectionOf());
    await listTools(deps, connectionOf());
    assert.equal(server.requests.length, 2);
    assert.ok(server.requests.every((request) => request.authorization === `Bearer ${TOKEN}`));
  });

  test('接続先がワークスペースを持つと、workspace の操作の workspace_id が required から外れる', async () => {
    const tools = await listTools(depsOf(fakeServer()), connectionOf({ org: 'aoba', workspace: 'ws-1' }));
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    assert.deepEqual(byName['task-edit']!.inputSchema.required, ['task_id']);
    // properties には残り、AI は上書きできる
    assert.ok('workspace_id' in (byName['task-edit']!.inputSchema.properties as object));
    // 補わない scope の操作は、そのまま
    assert.deepEqual(byName['task-get']!.inputSchema.required, ['task_id', 'workspace_id']);
    // 平らにした pick の required からも外れる
    assert.deepEqual(byName['pick']!.inputSchema.required, ['kind']);
  });

  test('ワークスペースを持たない接続先では required のまま', async () => {
    const tools = await listTools(depsOf(fakeServer()), connectionOf({ org: 'aoba' }));
    assert.deepEqual(tools[0]!.inputSchema.required, ['workspace_id', 'task_id']);
  });

  test('required が空になるときは required を外す', async () => {
    const operations = {
      operations: [
        {
          name: 'ws-only',
          description: 'ワークスペースだけ',
          mode: 'read',
          scope: 'workspace',
          permission: 'member',
          input_schema: object({ workspace_id: { type: 'string' } }, ['workspace_id']),
          output_schema: object({}),
        },
      ],
    };
    const tools = await listTools(depsOf(fakeServer({ operations })), connectionOf({ org: 'aoba', workspace: 'ws-1' }));
    assert.ok(!('required' in tools[0]!.inputSchema));
  });
});

// 本物の invitation-create と adminNomineeInput（discriminatedUnion('provider', …)）の入力の Schema の形
const providerBranch = (provider: string, fields: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties: {
    workspace_id: { type: 'string' },
    role: { enum: ['leader', 'member'] },
    provider: { const: provider },
    ...fields,
  },
  required: ['workspace_id', 'role', 'provider', ...required],
  additionalProperties: false,
});
const invitationCreate = {
  name: 'invitation-create',
  description: '人を招待する',
  mode: 'write',
  scope: 'workspace',
  permission: 'leader',
  input_schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    oneOf: [
      providerBranch('github', { username: { type: 'string' }, login_subject: { type: 'string' } }, [
        'username',
        'login_subject',
      ]),
      providerBranch('google', { email: { type: 'string' } }, ['email']),
    ],
  },
  output_schema: object({}),
};
const adminNominee = {
  name: 'nominee',
  description: '管理者の候補',
  mode: 'write',
  scope: 'outside',
  permission: 'operator',
  input_schema: {
    anyOf: [
      object({ provider: { const: 'github' }, username: { type: 'string' } }, ['provider', 'username']),
      object({ provider: { const: 'google' }, email: { type: 'string' } }, ['provider', 'email']),
    ],
  },
  output_schema: object({}),
};
const forbiddenTop = ['oneOf', 'anyOf', 'allOf'];

describe('最上位が oneOf と anyOf の入力は、1つの object に平らにする', () => {
  test('invitation-create: 最上位に oneOf/anyOf/allOf が無く、各分岐の項目が全部 properties にある', async () => {
    const operations = { operations: [invitationCreate, adminNominee] };
    const tools = await listTools(depsOf(fakeServer({ operations })), connectionOf({ org: 'aoba' }));
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object');
      for (const key of forbiddenTop) assert.ok(!(key in tool.inputSchema), `${tool.name} の最上位に ${key}`);
      assert.ok(!('$schema' in tool.inputSchema));
    }
    const invitation = tools[0]!.inputSchema;
    const properties = invitation.properties as Record<string, unknown>;
    for (const key of ['workspace_id', 'role', 'provider', 'username', 'login_subject', 'email']) {
      assert.ok(key in properties, key);
    }
    // 全分岐に共通のものだけ必須
    assert.deepEqual(invitation.required, ['workspace_id', 'role', 'provider']);
    // 同名の項目で Schema が分かれる provider は anyOf でまとめる
    assert.deepEqual(properties.provider, { anyOf: [{ const: 'github' }, { const: 'google' }] });
    // 同じ Schema の項目はそのまま
    assert.deepEqual(properties.workspace_id, { type: 'string' });
    // 分岐ごとの条件を description の末尾に足す
    assert.ok(tools[0]!.description.startsWith('人を招待する'));
    assert.ok(tools[0]!.description.includes('分岐'));
    assert.ok(tools[0]!.description.includes('provider=github'));
    assert.ok(tools[0]!.description.includes('email'));

    const nominee = tools[1]!.inputSchema;
    assert.deepEqual(Object.keys(nominee.properties as object).sort(), ['email', 'provider', 'username']);
    assert.deepEqual(nominee.required, ['provider']);
  });

  test('workspace_id の required を外す処理が、平らにした後の形でも効く', async () => {
    const operations = { operations: [invitationCreate] };
    const tools = await listTools(depsOf(fakeServer({ operations })), connectionOf({ org: 'aoba', workspace: 'ws-1' }));
    assert.deepEqual(tools[0]!.inputSchema.required, ['role', 'provider']);
    assert.ok('workspace_id' in (tools[0]!.inputSchema.properties as object));
    assert.ok(!tools[0]!.description.includes('workspace_id'));
  });

  test('最上位の allOf も平らにする', async () => {
    const operations = {
      operations: [
        {
          name: 'merged',
          description: '合成',
          mode: 'read',
          scope: 'outside',
          permission: 'login',
          input_schema: {
            allOf: [object({ a: { type: 'string' } }, ['a']), object({ b: { type: 'number' } }, ['b'])],
          },
          output_schema: object({}),
        },
      ],
    };
    const [tool] = await listTools(depsOf(fakeServer({ operations })), connectionOf());
    for (const key of forbiddenTop) assert.ok(!(key in tool!.inputSchema));
    assert.deepEqual(Object.keys(tool!.inputSchema.properties as object), ['a', 'b']);
    assert.deepEqual(tool!.inputSchema.required, ['a', 'b']);
  });
});

describe('callTool', () => {
  const parseText = (result: { content: { text: string }[] }) => JSON.parse(result.content[0]!.text);

  test('組織の外の操作は /api/<name> を呼び、本文の JSON を text で返す', async () => {
    const server = fakeServer({ reply: () => ({ status: 200, body: { account_id: 'a-1' } }) });
    const result = await callTool(depsOf(server), connectionOf(), 'who-am-i', undefined);
    assert.equal(result.isError, undefined);
    assert.deepEqual(parseText(result), { account_id: 'a-1' });
    assert.equal(server.calls()[0]!.path, '/api/who-am-i');
    assert.equal(server.calls()[0]!.authorization, `Bearer ${TOKEN}`);
  });

  test('組織は接続先から補い、ワークスペースは入力に無いときだけ補う', async () => {
    const server = fakeServer();
    const connection = connectionOf({ org: 'aoba', workspace: 'ws-1' });
    await callTool(depsOf(server), connection, 'task-edit', { task_id: 't-1' });
    await callTool(depsOf(server), connection, 'task-edit', { task_id: 't-2', workspace_id: 'ws-2' });
    assert.deepEqual(
      server.calls().map((call) => [call.path, call.body]),
      [
        ['/api/aoba/task-edit', { task_id: 't-1', workspace_id: 'ws-1' }],
        ['/api/aoba/task-edit', { task_id: 't-2', workspace_id: 'ws-2' }],
      ],
    );
  });

  test('入力の org では組織を切り替えられない（接続先の組織で呼ぶ）', async () => {
    const server = fakeServer();
    await callTool(depsOf(server), connectionOf({ org: 'aoba' }), 'task-get', { task_id: 't-1', org: 'other' });
    assert.equal(server.calls()[0]!.path, '/api/aoba/task-get');
  });

  test('接続先がワークスペースを持つとき、入力の workspace_id が null か空文字なら省いたものとして補う', async () => {
    for (const empty of [null, '']) {
      const server = fakeServer();
      await callTool(depsOf(server), connectionOf({ org: 'aoba', workspace: 'W1' }), 'task-edit', {
        task_id: 't-1',
        workspace_id: empty,
      });
      assert.deepEqual(server.calls()[0]!.body, { task_id: 't-1', workspace_id: 'W1' }, JSON.stringify(empty));
    }
  });

  test('scope が workspace でない操作の null の workspace_id は、接続先がワークスペースを持っても補わずそのまま送る', async () => {
    const server = fakeServer();
    await callTool(depsOf(server), connectionOf({ org: 'aoba', workspace: 'W1' }), 'task-get', {
      task_id: 't-1',
      workspace_id: null,
    });
    assert.deepEqual(server.calls()[0]!.body, { task_id: 't-1', workspace_id: null });
  });

  test('接続先がワークスペースを持たないとき、null の workspace_id はそのまま送る', async () => {
    const server = fakeServer();
    await callTool(depsOf(server), connectionOf({ org: 'aoba' }), 'task-edit', { task_id: 't-1', workspace_id: null });
    assert.deepEqual(server.calls()[0]!.body, { task_id: 't-1', workspace_id: null });
  });

  test('渡された引数を書き換えない', async () => {
    const args = { task_id: 't-1' };
    await callTool(depsOf(fakeServer()), connectionOf({ org: 'aoba', workspace: 'ws-1' }), 'task-edit', args);
    assert.deepEqual(args, { task_id: 't-1' });
  });

  test('API のエラーは isError で、{"status","error"} の JSON を返す', async () => {
    const body = { error: { code: 'forbidden', message: '権限が無い' } };
    const server = fakeServer({ reply: () => ({ status: 403, body }) });
    const result = await callTool(depsOf(server), connectionOf({ org: 'aoba' }), 'task-get', { task_id: 't-1' });
    assert.equal(result.isError, true);
    assert.deepEqual(parseText(result), { status: 403, error: body.error });
  });

  test('一覧に無い操作は、呼ばずに isError', async () => {
    const server = fakeServer();
    const result = await callTool(depsOf(server), connectionOf({ org: 'aoba' }), 'admin-ping', {});
    assert.equal(result.isError, true);
    assert.equal(parseText(result).error.code, 'usage');
    assert.equal(server.calls().length, 0);
  });

  test('組織が要る操作で接続先に組織が無いと isError', async () => {
    const server = fakeServer();
    const result = await callTool(depsOf(server), connectionOf(), 'task-get', { task_id: 't-1' });
    assert.equal(result.isError, true);
    assert.equal(parseText(result).error.code, 'usage');
    assert.equal(server.calls().length, 0);
  });

  test('つながらないときも isError で、トークンは伏せる。投げない', async () => {
    const result = await callTool(depsOf(fakeServer({ throws: true })), connectionOf(), 'who-am-i', {});
    assert.equal(result.isError, true);
    assert.equal(parseText(result).error.code, 'connection_failed');
    assert.ok(!result.content[0]!.text.includes(TOKEN));
  });

  test('一覧が不正な形でも isError', async () => {
    const result = await callTool(depsOf(fakeServer({ operations: { nope: 1 } })), connectionOf(), 'who-am-i', {});
    assert.equal(result.isError, true);
    assert.equal(parseText(result).error.code, 'invalid_response');
  });
});
