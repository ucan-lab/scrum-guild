// 本物の app（本番の操作の一覧）に CLI をつなぎ、z.toJSONSchema が実際に出す形の項目を引数で渡せるかを崩しにいく。
// zod 4 は .nullable() を anyOf: [{...}, {type: 'null'}] で、discriminatedUnion の入力を最上位の oneOf で出す。
// Issue #582 の前提「引数の値は入力の JSON Schema の型で変える（string はそのまま、number と integer は数、…、null を許す項目は null）」と
// 受け入れ条件「入力（JSON か、最上位の単純な項目の引数）で、画面でできる操作を実行できる」に照らす
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { main, type CliDeps, type Config, type ConfigStore } from '../cli/lib/main.ts';
import { createTask } from './factories.ts';
import { insertApiToken } from './operations/api-token.ts';
import { createTarget, testEnv, type Person, type Target } from './operations/world.ts';

const BASE_URL = 'https://cli-breakers.guild.example';
const app = createApp();

function memoryStore(initial: Config): ConfigStore {
  let saved = structuredClone(initial);
  return {
    read: async () => structuredClone(saved),
    write: async (config) => {
      saved = structuredClone(config);
    },
  };
}

async function sg(argv: string[], person: Person, target: Target) {
  const token = (await insertApiToken(person.accountId, { scope: 'write' })).raw;
  let stdout = '';
  let stderr = '';
  const deps: CliDeps = {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      app.fetch(new Request(input, init), testEnv)) as typeof fetch,
    env: {},
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    readStdin: async () => '',
    config: memoryStore({
      default_profile: 'main',
      profiles: { main: { url: BASE_URL, token, org: target.slug, workspace: target.workspace.id } },
    }),
  };
  const code = await main(argv, deps);
  return { code, stdout, stderr };
}

describe('null を許す項目（anyOf: [型, null]）を引数で渡す', () => {
  test('task-assign の --assignee_user_id に人の ID を渡すと、その人が担当になる', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.leader.userId!);
    const result = await sg(
      ['call', 'task-assign', '--task_id', task.id, '--assignee_user_id', target.member.userId!],
      target.leader,
      target,
    );
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).task.assignee).toMatchObject({ id: target.member.userId });
  });

  test('task-assign の --assignee_user_id null で担当を外せる', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.leader.userId!, {
      assignee_user_id: target.member.userId!,
    });
    const result = await sg(
      ['call', 'task-assign', '--task_id', task.id, '--assignee_user_id', 'null'],
      target.leader,
      target,
    );
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).task.assignee).toBeNull();
  });

  test('task-update の --points（null を許す、決まった数のどれか）に数を渡せる', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.leader.userId!);
    const result = await sg(['call', 'task-update', '--task_id', task.id, '--points', '5'], target.leader, target);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).task.points).toBe(5);
  });
});

describe('入力が union（最上位の oneOf）の操作を、最上位の単純な項目の引数で呼ぶ', () => {
  test('invitation-create を --provider google --email --role で呼べる', async () => {
    const target = await createTarget();
    const result = await sg(
      ['call', 'invitation-create', '--provider', 'google', '--email', 'kogane.hotaru@example.com', '--role', 'member'],
      target.leader,
      target,
    );
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ login_name: 'kogane.hotaru@example.com' });
  });
});
