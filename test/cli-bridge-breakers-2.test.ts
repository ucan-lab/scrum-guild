// 本物の app が返す本番の操作の一覧を CLI に渡し、最上位の単純な項目をすべて引数で渡せるかを崩しにいく。
// Issue #582 の受け入れ条件「入力（JSON か、最上位の単純な項目の引数）で、画面でできる操作を実行できる」と、
// 前提「引数の値は入力の JSON Schema の型で変える（string はそのまま、number と integer は数、boolean は true / false、null を許す項目は null）」
import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { main, type CliDeps, type Config, type ConfigStore } from '../cli/lib/main.ts';
import { createTask } from './factories.ts';
import { insertApiToken } from './operations/api-token.ts';
import { createLoginPerson, createTarget, testEnv } from './operations/world.ts';

const BASE_URL = 'https://cli-breakers-2.guild.example';
const app = createApp();

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  const?: unknown;
  enum?: unknown[];
};
type CatalogOperation = { name: string; scope: string; input_schema: JsonSchema };

function memoryStore(initial: Config): ConfigStore {
  let saved = structuredClone(initial);
  return {
    read: async () => structuredClone(saved),
    write: async (config) => {
      saved = structuredClone(config);
    },
  };
}

// 項目の Schema の型と、const / enum の値を集める（テストの側で独立に辿る）
function walk(schema: JsonSchema, types: Set<string>, literals: unknown[]) {
  for (const type of Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []) types.add(type);
  if ('const' in schema) literals.push(schema.const);
  literals.push(...(schema.enum ?? []));
  for (const branch of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) walk(branch, types, literals);
}

// 引数で渡す見本の値と、送られるはずの値。object と array の項目は引数にできないので undefined
function samplesOf(schema: JsonSchema): { raw: string; expected: unknown }[] | undefined {
  const types = new Set<string>();
  const literals: unknown[] = [];
  walk(schema, types, literals);
  if (types.has('object') || types.has('array')) return undefined;
  const samples: { raw: string; expected: unknown }[] = [];
  const literal = literals.find((value) => value !== null);
  if (typeof literal === 'string') samples.push({ raw: literal, expected: literal });
  else if (typeof literal === 'number') samples.push({ raw: String(literal), expected: literal });
  else if (types.has('boolean')) samples.push({ raw: 'true', expected: true });
  else if (types.has('integer')) samples.push({ raw: '3', expected: 3 });
  else if (types.has('number')) samples.push({ raw: '2.5', expected: 2.5 });
  else if (types.has('string')) samples.push({ raw: 'kogane', expected: 'kogane' });
  if (types.has('null') || literals.includes(null)) samples.push({ raw: 'null', expected: null });
  return samples;
}

async function productionCatalog(): Promise<CatalogOperation[]> {
  const person = await createLoginPerson();
  const token = (await insertApiToken(person.accountId, { scope: 'write' })).raw;
  const response = await app.fetch(
    new Request(`${BASE_URL}/api/operation-list`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    }),
    testEnv,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { operations: CatalogOperation[] }).operations;
}

// 一覧は本番のものを返し、操作の呼び出しは送った本文を記録するだけの fetch で、CLI が作る本文を見る
async function bodySentBy(catalog: CatalogOperation[], argv: string[]) {
  const bodies: Record<string, unknown>[] = [];
  let stderr = '';
  const deps: CliDeps = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/api/operation-list') return Response.json({ operations: catalog });
      bodies.push((await request.json()) as Record<string, unknown>);
      return Response.json({});
    }) as typeof fetch,
    env: {},
    stdout: () => {},
    stderr: (text) => {
      stderr += text;
    },
    readStdin: async () => '',
    config: memoryStore({
      default_profile: 'main',
      profiles: { main: { url: BASE_URL, token: `sgp_${'B'.repeat(43)}`, org: 'kogane', workspace: 'ws-kogane' } },
    }),
  };
  const code = await main(argv, deps);
  return { code, stderr, body: bodies[0] };
}

describe('本番の一覧の、最上位の単純な項目', () => {
  test('どの操作のどの項目も、入力の JSON Schema の型で変えた値を送る', async () => {
    const catalog = await productionCatalog();
    const failures: string[] = [];
    let checked = 0;
    for (const operation of catalog) {
      const schema = operation.input_schema;
      for (const branch of [schema, ...(schema.oneOf ?? []), ...(schema.anyOf ?? [])]) {
        for (const [key, property] of Object.entries(branch.properties ?? {})) {
          for (const { raw, expected } of samplesOf(property) ?? []) {
            checked++;
            const result = await bodySentBy(catalog, ['call', operation.name, `--${key}`, raw]);
            if (result.code !== 0 || result.body?.[key] !== expected)
              failures.push(`${operation.name} --${key} ${raw}: ${result.code} ${result.stderr.trim()}`);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(failures).toEqual([]);
  });
});

describe('入れ子の anyOf の const を本物の app で呼ぶ', () => {
  test('backlog-tree の --assignee_user_id me で、自分が担当のタスクだけが返る', async () => {
    const target = await createTarget();
    const mine = await createTask(target.organization, target.workspace.id, target.leader.userId!, {
      assignee_user_id: target.leader.userId!,
    });
    const others = await createTask(target.organization, target.workspace.id, target.leader.userId!, {
      assignee_user_id: target.member.userId!,
    });
    const token = (await insertApiToken(target.leader.accountId, { scope: 'read' })).raw;
    let stdout = '';
    let stderr = '';
    const code = await main(['call', 'backlog-tree', '--assignee_user_id', 'me'], {
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
    });
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout).toContain(mine.id);
    expect(stdout).not.toContain(others.id);
  });
});
