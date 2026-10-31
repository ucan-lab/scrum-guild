// CLI（cli/lib/main.ts）と本物の app のつなぎ。app の fetch を CLI に渡し、テストで足した仮の操作を sg call で呼べることを確かめる。
// CLI は定義を import せず一覧を API から取るので、サーバーに定義を足せば CLI を作り直さずに使える（Issue #582）
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { defineOperation } from '../src/shared/operations/define.ts';
import { createApp } from '../src/server/app.ts';
import { implement, type ImplementedOperation } from '../src/server/operations/implement.ts';
import { operationListOperationFor } from '../src/server/operations/operation-list.ts';
import { main, type CliDeps, type Config, type ConfigStore } from '../cli/lib/main.ts';
import { createTask, createWorkspace } from './factories.ts';
import { insertApiToken, type TokenScope } from './operations/api-token.ts';
import { provisionalOperations } from './operations/provisional.ts';
import { createLoginPerson, createTarget, testEnv, type Person, type Target } from './operations/world.ts';

const BASE_URL = 'https://cli.guild.example';

// サーバーにだけ足した操作。CLI のコードには名前も入力の形も無い
const lanternLight = defineOperation({
  name: 'lantern-light',
  description: '灯りをともす仮の操作。ともした数を返す',
  mode: 'write',
  permission: 'login',
  input: z.object({ count: z.number().int(), color: z.string() }),
  output: z.object({ lit: z.number(), color: z.string() }),
});

function appWith(operations: readonly ImplementedOperation[]) {
  return createApp([...operations, operationListOperationFor(operations.map((operation) => operation.definition))]);
}

const app = appWith([
  ...provisionalOperations,
  implement(lanternLight, async ({ input }) => ({ lit: input.count, color: input.color })),
]);

function memoryStore(initial: Config): ConfigStore {
  let saved = structuredClone(initial);
  return {
    read: async () => structuredClone(saved),
    write: async (config) => {
      saved = structuredClone(config);
    },
  };
}

async function tokenOf(person: Person, scope: TokenScope = 'write'): Promise<string> {
  return (await insertApiToken(person.accountId, { scope })).raw;
}

type Profile = { token: string; org?: string; workspace?: string };

async function sg(argv: string[], profile: Profile, appToUse = app) {
  let stdout = '';
  let stderr = '';
  const deps: CliDeps = {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      appToUse.fetch(new Request(input, init), testEnv)) as typeof fetch,
    env: {},
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    readStdin: async () => '',
    config: memoryStore({ default_profile: 'main', profiles: { main: { url: BASE_URL, ...profile } } }),
  };
  const code = await main(argv, deps);
  // どの出力にもトークンの生の値を出さない
  expect(stdout).not.toContain(profile.token);
  expect(stderr).not.toContain(profile.token);
  return { code, stdout, stderr };
}

function apiError(result: { code: number; stdout: string; stderr: string }, status: number, code: string) {
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(JSON.parse(result.stderr)).toMatchObject({ status, error: { code } });
}

describe('sg ops', () => {
  test('サーバーに足した仮の操作が一覧に載り、運用者の操作は載らない', async () => {
    const person = await createLoginPerson();
    const { code, stdout } = await sg(['ops'], { token: await tokenOf(person) });
    expect(code).toBe(0);
    for (const name of ['lantern-light', 'who-am-i', 'workspace-summary', 'rename-workspace']) {
      expect(stdout).toContain(name);
    }
    expect(stdout).not.toContain('operator-ping');
  });

  test('sg ops <操作名> で説明と入力の形を見られる', async () => {
    const person = await createLoginPerson();
    const { code, stdout } = await sg(['ops', 'lantern-light'], { token: await tokenOf(person) });
    expect(code).toBe(0);
    expect(stdout).toContain(lanternLight.description);
    expect(stdout).toContain('count');
    expect(stdout).toContain('color');
  });
});

describe('sg call で本物の app の操作を呼べる', () => {
  test('組織の外の操作', async () => {
    const person = await createLoginPerson();
    const { code, stdout, stderr } = await sg(['call', 'who-am-i'], { token: await tokenOf(person) });
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ account_id: person.accountId });
  });

  test('サーバーにだけ足した操作を、引数の型を変えて呼べる', async () => {
    const person = await createLoginPerson();
    const { code, stdout } = await sg(['call', 'lantern-light', '--count', '4', '--color', '琥珀'], {
      token: await tokenOf(person),
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ lit: 4, color: '琥珀' });
  });

  test('JSON の入力でも呼べる', async () => {
    const person = await createLoginPerson();
    const { code, stdout } = await sg(['call', 'lantern-light', '{"count":2,"color":"若葉"}'], {
      token: await tokenOf(person),
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ lit: 2, color: '若葉' });
  });

  test('組織の中の操作は、設定の既定の組織で呼ぶ', async () => {
    const target = await createTarget();
    const { code, stdout } = await sg(['call', 'organization-profile'], {
      token: await tokenOf(target.admin),
      org: target.slug,
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ organization_id: target.organization.id, user_id: target.admin.userId });
  });

  test('ワークスペースの下の操作は、設定の既定のワークスペースが workspace_id に補われる', async () => {
    const target = await createTarget();
    const { code, stdout } = await sg(['call', 'workspace-summary'], {
      token: await tokenOf(target.member),
      org: target.slug,
      workspace: target.workspace.id,
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ workspace_id: target.workspace.id, role: 'member' });
  });

  test('ワークスペースの下の書き込みを、項目の引数で呼べる', async () => {
    const target = await createTarget();
    const { code, stdout } = await sg(['call', 'rename-workspace', '--name', '若葉チーム'], {
      token: await tokenOf(target.leader),
      org: target.slug,
      workspace: target.workspace.id,
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ workspace_id: target.workspace.id, name: '若葉チーム' });
  });
});

describe('--org と --workspace が設定の既定に勝つ', () => {
  test('--org', async () => {
    const [own, other] = await Promise.all([createTarget(), createTarget()]);
    const { code, stdout } = await sg(['call', 'organization-profile', '--org', own.slug], {
      token: await tokenOf(own.admin),
      org: other.slug,
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ organization_id: own.organization.id });
  });

  test('--workspace', async () => {
    const target = await createTarget();
    const { code, stdout } = await sg(['call', 'workspace-summary', '--workspace', target.otherWorkspace.id], {
      token: await tokenOf(target.bystander),
      org: target.slug,
      workspace: target.workspace.id,
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ workspace_id: target.otherWorkspace.id, role: 'member' });
  });
});

describe('API のエラーはそのまま表示し、終了コード 1', () => {
  test('権限の無い操作は 403', async () => {
    const target = await createTarget();
    const result = await sg(['call', 'rename-workspace', '--name', '若葉チーム'], {
      token: await tokenOf(target.member),
      org: target.slug,
      workspace: target.workspace.id,
    });
    apiError(result, 403, 'forbidden');
  });

  test('別の組織のワークスペースの ID は 404', async () => {
    const [own, other] = await Promise.all([createTarget(), createTarget()]);
    const result = await sg(['call', 'workspace-summary', '--workspace', other.workspace.id], {
      token: await tokenOf(own.admin),
      org: own.slug,
    });
    apiError(result, 404, 'not_found');
  });

  test('別の組織の行の ID は 404', async () => {
    const [own, other]: Target[] = await Promise.all([createTarget(), createTarget()]);
    const workspace = await createWorkspace(other.organization, other.admin.userId!);
    const task = await createTask(other.organization, workspace.id, other.admin.userId!);
    const result = await sg(['call', 'task-title', '--task_id', task.id], {
      token: await tokenOf(own.admin),
      org: own.slug,
    });
    apiError(result, 404, 'not_found');
  });

  test('入れない組織の slug は 404', async () => {
    const [own, other] = await Promise.all([createTarget(), createTarget()]);
    const result = await sg(['call', 'organization-profile'], { token: await tokenOf(own.admin), org: other.slug });
    apiError(result, 404, 'not_found');
  });
});

describe('一覧と呼び出しの範囲', () => {
  test('読み取りのトークンでは、書き込みの操作を呼べない（成功しない）', async () => {
    const person = await createLoginPerson();
    const result = await sg(['call', 'lantern-light', '--count', '1', '--color', '白'], {
      token: await tokenOf(person, 'read'),
    });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
  });
});
