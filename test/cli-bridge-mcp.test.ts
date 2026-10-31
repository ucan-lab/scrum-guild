// sg mcp の道具（cli/lib/mcp-tools.ts）と本物の app のつなぎ。app の fetch を渡し、テストで足した仮の操作が道具に出て呼べること、
// 読み取りのトークンでは書き込みの道具が出ず呼ぶと isError になること、別の組織の ID が API と同じエラーになること（Issue #583）
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { defineOperation } from '../src/shared/operations/define.ts';
import { createApp } from '../src/server/app.ts';
import { implement, type ImplementedOperation } from '../src/server/operations/implement.ts';
import { operationListOperationFor } from '../src/server/operations/operation-list.ts';
import type { CliDeps, Connection } from '../cli/lib/main.ts';
import { callTool, listTools, type McpToolResult } from '../cli/lib/mcp-tools.ts';
import { createTask, createWorkspace } from './factories.ts';
import { insertApiToken, type TokenScope } from './operations/api-token.ts';
import { provisionalOperations } from './operations/provisional.ts';
import { createLoginPerson, createTarget, testEnv, type Person } from './operations/world.ts';

const BASE_URL = 'https://mcp.guild.example';

// サーバーにだけ足した操作。MCP のコードには名前も入力の形も無い
const lanternLight = defineOperation({
  name: 'lantern-light',
  description: '灯りをともす仮の操作。ともした数を返す',
  mode: 'write',
  permission: 'login',
  input: z.object({ count: z.number().int(), color: z.string() }),
  output: z.object({ lit: z.number(), color: z.string() }),
});

const lanternCount = defineOperation({
  name: 'lantern-count',
  description: '灯りの数を返す仮の操作',
  mode: 'read',
  permission: 'login',
  input: z.object({}),
  output: z.object({ count: z.number() }),
});

const implemented: ImplementedOperation[] = [
  ...provisionalOperations,
  implement(lanternLight, async ({ input }) => ({ lit: input.count, color: input.color })),
  implement(lanternCount, async () => ({ count: 3 })),
];
const app = createApp([
  ...implemented,
  operationListOperationFor(implemented.map((operation) => operation.definition)),
]);

const outputs: string[] = [];
const depsOf = (): CliDeps => ({
  fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
    app.fetch(new Request(input, init), testEnv)) as typeof fetch,
  env: {},
  stdout: (text) => outputs.push(text),
  stderr: (text) => outputs.push(text),
  readStdin: async () => '',
  config: { read: async () => undefined, write: async () => {} },
});

async function connectionOf(
  person: Person,
  extra: { scope?: TokenScope; org?: string; workspace?: string } = {},
): Promise<Connection> {
  const { raw } = await insertApiToken(person.accountId, { scope: extra.scope ?? 'write' });
  return { url: BASE_URL, token: raw, org: extra.org, workspace: extra.workspace };
}

// どの出力にもトークンの生の値を出さない
function noToken(connection: Connection, ...texts: string[]) {
  for (const text of [...texts, ...outputs]) expect(text).not.toContain(connection.token);
}

const textOf = (result: McpToolResult) => result.content[0]!.text;

describe('sg mcp の道具の一覧', () => {
  test('サーバーにだけ足した仮の操作が道具に出る。運用者の操作は出ない', async () => {
    const person = await createLoginPerson();
    const connection = await connectionOf(person);
    const tools = await listTools(depsOf(), connection);
    const names = tools.map((tool) => tool.name);
    for (const name of ['lantern-light', 'lantern-count', 'who-am-i', 'rename-workspace']) {
      expect(names).toContain(name);
    }
    expect(names).not.toContain('operator-ping');
    const light = tools.find((tool) => tool.name === 'lantern-light')!;
    expect(light.description).toBe(lanternLight.description);
    expect(light.inputSchema).toMatchObject({ type: 'object', required: ['count', 'color'] });
    expect(light.annotations.readOnlyHint).toBe(false);
    expect(tools.find((tool) => tool.name === 'lantern-count')!.annotations.readOnlyHint).toBe(true);
    noToken(connection, JSON.stringify(tools));
  });

  test('接続先のワークスペースがあると、workspace_id が required から外れる', async () => {
    const target = await createTarget();
    const connection = await connectionOf(target.member, { org: target.slug, workspace: target.workspace.id });
    const tools = await listTools(depsOf(), connection);
    const rename = tools.find((tool) => tool.name === 'rename-workspace')!;
    expect(rename.inputSchema.required).not.toContain('workspace_id');
    expect(rename.inputSchema.required).toContain('name');
  });

  test('読み取りのトークンでは、書き込みの道具が一覧に出ない', async () => {
    const person = await createLoginPerson();
    const connection = await connectionOf(person, { scope: 'read' });
    const tools = await listTools(depsOf(), connection);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((tool) => tool.annotations.readOnlyHint)).toBe(true);
    expect(tools.map((tool) => tool.name)).toContain('lantern-count');
    expect(tools.map((tool) => tool.name)).not.toContain('lantern-light');
  });
});

describe('sg mcp の道具の呼び出し', () => {
  test('サーバーにだけ足した操作を呼べる', async () => {
    const person = await createLoginPerson();
    const connection = await connectionOf(person);
    const result = await callTool(depsOf(), connection, 'lantern-light', { count: 4, color: '琥珀' });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toEqual({ lit: 4, color: '琥珀' });
    noToken(connection, textOf(result));
  });

  test('組織の中の操作は、接続先の組織で呼ぶ', async () => {
    const target = await createTarget();
    const connection = await connectionOf(target.admin, { org: target.slug });
    const result = await callTool(depsOf(), connection, 'organization-profile', {});
    expect(JSON.parse(textOf(result))).toEqual({
      organization_id: target.organization.id,
      user_id: target.admin.userId,
    });
  });

  test('ワークスペースの下の操作は、接続先のワークスペースが workspace_id に補われる', async () => {
    const target = await createTarget();
    const connection = await connectionOf(target.leader, { org: target.slug, workspace: target.workspace.id });
    const result = await callTool(depsOf(), connection, 'rename-workspace', { name: '若葉チーム' });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toEqual({ workspace_id: target.workspace.id, name: '若葉チーム' });
  });

  test('権限の無い操作は API と同じ 403 を isError で返す', async () => {
    const target = await createTarget();
    const connection = await connectionOf(target.member, { org: target.slug, workspace: target.workspace.id });
    const result = await callTool(depsOf(), connection, 'rename-workspace', { name: '若葉チーム' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toMatchObject({ status: 403, error: { code: 'forbidden' } });
    noToken(connection, textOf(result));
  });

  test('別の組織のワークスペースの ID は 404', async () => {
    const [own, other] = await Promise.all([createTarget(), createTarget()]);
    const connection = await connectionOf(own.admin, { org: own.slug });
    const result = await callTool(depsOf(), connection, 'workspace-summary', { workspace_id: other.workspace.id });
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toMatchObject({ status: 404, error: { code: 'not_found' } });
  });

  test('別の組織の行の ID は 404', async () => {
    const [own, other] = await Promise.all([createTarget(), createTarget()]);
    const workspace = await createWorkspace(other.organization, other.admin.userId!);
    const task = await createTask(other.organization, workspace.id, other.admin.userId!);
    const connection = await connectionOf(own.admin, { org: own.slug });
    const result = await callTool(depsOf(), connection, 'task-title', { task_id: task.id });
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toMatchObject({ status: 404, error: { code: 'not_found' } });
  });

  test('入力の org で別の組織に切り替えられない', async () => {
    const [own, other] = await Promise.all([createTarget(), createTarget()]);
    const connection = await connectionOf(own.admin, { org: own.slug });
    const result = await callTool(depsOf(), connection, 'organization-profile', { org: other.slug });
    expect(JSON.parse(textOf(result))).toMatchObject({ organization_id: own.organization.id });
  });

  test('読み取りのトークンで書き込みの道具を呼ぶと isError で、実行されない', async () => {
    const person = await createLoginPerson();
    const connection = await connectionOf(person, { scope: 'read' });
    const result = await callTool(depsOf(), connection, 'lantern-light', { count: 1, color: '白' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result)).error.code).toBe('usage');
    noToken(connection, textOf(result));
    // 読み取りの道具は呼べる
    const read = await callTool(depsOf(), connection, 'lantern-count', {});
    expect(read.isError).toBeUndefined();
    expect(JSON.parse(textOf(read))).toEqual({ count: 3 });
  });
});
