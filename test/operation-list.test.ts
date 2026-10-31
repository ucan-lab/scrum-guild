// 呼べる操作の一覧（operation-list）。一覧はトークンで絞り、役割では絞らない（Issue #582）。
// 除く条件は呼び出しの 403（register.ts の checkTokenScope）と同じ: 運用者の操作、cookieOnly、読み取りのトークンなら write
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { defineOperation, type AnyOperationDefinition } from '../src/shared/operations/define.ts';
import { operations } from '../src/shared/operations/index.ts';
import { logout, operationList, tokenCreate, tokenList, tokenRevoke } from '../src/shared/operations/session/index.ts';
import { createApp } from '../src/server/app.ts';
import { implement } from '../src/server/operations/implement.ts';
import { operationListOperationFor } from '../src/server/operations/operation-list.ts';
import { tokenAllows } from '../src/server/operations/token-scope.ts';
import { insertApiToken, type TokenScope } from './operations/api-token.ts';
import { post } from './operations/harness.ts';
import {
  closeWorkspace,
  operatorPing,
  organizationProfile,
  provisionalOperations,
  renameWorkspace,
  whoAmI,
  workspaceSummary,
} from './operations/provisional.ts';
import { createLoginPerson, getOperator, type Person } from './operations/world.ts';

// Cookie のセッションでしか呼べない仮の操作（本番の logout と token-* と同じ扱い）
const cookiePing = defineOperation({
  name: 'cookie-ping',
  description: 'Cookie のセッションだけが呼べる',
  mode: 'read',
  permission: 'login',
  cookieOnly: true,
  input: z.object({}),
  output: z.object({}),
});

// テストで足した仮の操作。一覧に載れば、定義を足すだけで CLI から使える
const lanternCount = defineOperation({
  name: 'lantern-count',
  description: '灯りの数を数える仮の操作',
  mode: 'read',
  permission: 'login',
  input: z.object({ color: z.string().optional() }),
  output: z.object({ count: z.number() }),
});

const extraOperations = [implement(cookiePing, async () => ({})), implement(lanternCount, async () => ({ count: 3 }))];
const provisional = [...provisionalOperations, ...extraOperations];
const provisionalApp = createApp([
  ...provisional,
  operationListOperationFor(provisional.map((operation) => operation.definition)),
]);
const realApp = createApp();

type Listed = {
  name: string;
  description: string;
  mode: 'read' | 'write';
  scope: 'outside' | 'organization' | 'workspace';
  permission: string;
  input_schema: unknown;
  output_schema: unknown;
};

type Credential = 'cookie' | TokenScope;

async function list(app: ReturnType<typeof createApp>, person: Person, credential: Credential): Promise<Listed[]> {
  const auth =
    credential === 'cookie'
      ? { token: person.token }
      : { bearer: (await insertApiToken(person.accountId, { scope: credential })).raw, origin: null };
  const res = await post(app, operationList, auth);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { operations: Listed[] };
  expect(operationList.output.safeParse(body).success).toBe(true);
  return body.operations;
}

const namesOf = (listed: Listed[]) => listed.map((operation) => operation.name);

type SchemaBranch = { type?: unknown; properties?: Record<string, unknown> };

// object の Schema はそのまま、union（oneOf か anyOf）は分岐の一覧を返す
function objectBranchesOf(schema: unknown): SchemaBranch[] {
  const { oneOf, anyOf } = schema as { oneOf?: SchemaBranch[]; anyOf?: SchemaBranch[] };
  return oneOf ?? anyOf ?? [schema as SchemaBranch];
}

// Issue の決まりで、一覧に載るはずの名前。Cookie は write のトークンと同じ
function expectedNames(definitions: readonly AnyOperationDefinition[], credential: Credential): string[] {
  const scope = credential === 'cookie' ? 'write' : credential;
  return definitions
    .filter((definition) => definition.permission !== 'operator' && definition.cookieOnly !== true)
    .filter((definition) => scope === 'write' || definition.mode === 'read')
    .map((definition) => definition.name)
    .sort();
}

const provisionalDefinitions = [...provisional.map((operation) => operation.definition), operationList];

describe('仮の操作を渡した一覧', () => {
  for (const credential of ['cookie', 'write', 'read'] as const) {
    test(`${credential} で呼ぶと、トークンで呼べうる操作だけを名前順に返す`, async () => {
      const person = await createLoginPerson();
      const listed = namesOf(await list(provisionalApp, person, credential));
      expect(listed).toEqual(expectedNames(provisionalDefinitions, credential));
      expect(listed).toEqual([...listed].sort());
      expect(listed).toContain('operation-list');
      expect(listed).not.toContain(operatorPing.name);
      expect(listed).not.toContain(cookiePing.name);
      const scope = credential === 'cookie' ? 'write' : credential;
      expect(listed).toEqual(
        provisionalDefinitions
          .filter((definition) => tokenAllows(definition, scope))
          .map((definition) => definition.name)
          .sort(),
      );
    });
  }

  test('読み取りのトークンの一覧に write の操作が無く、write のトークンの一覧にはある', async () => {
    const person = await createLoginPerson();
    const read = namesOf(await list(provisionalApp, person, 'read'));
    const write = namesOf(await list(provisionalApp, person, 'write'));
    for (const name of [renameWorkspace.name, closeWorkspace.name]) {
      expect(read).not.toContain(name);
      expect(write).toContain(name);
    }
    expect(read).toContain(workspaceSummary.name);
  });

  test('役割では絞らない: 組織に属さないログインの人にも、組織の中とワークスペースの下の操作が載る', async () => {
    const person = await createLoginPerson();
    const listed = namesOf(await list(provisionalApp, person, 'write'));
    expect(listed).toEqual(
      expect.arrayContaining([organizationProfile.name, workspaceSummary.name, renameWorkspace.name]),
    );
  });

  test('運用者がトークンで呼んでも、運用者の操作は載らない', async () => {
    const operator = await getOperator();
    expect(namesOf(await list(provisionalApp, operator, 'write'))).not.toContain(operatorPing.name);
  });

  test('テストで足した仮の操作が、範囲、権限、mode、説明、入力の形とともに載る', async () => {
    const person = await createLoginPerson();
    const listed = await list(provisionalApp, person, 'read');
    expect(listed.find((operation) => operation.name === lanternCount.name)).toMatchObject({
      description: lanternCount.description,
      mode: 'read',
      scope: 'outside',
      permission: 'login',
      input_schema: { type: 'object', properties: { color: { type: 'string' } } },
      output_schema: { type: 'object', properties: { count: { type: 'number' } } },
    });
  });

  test('入力の JSON Schema は入力の形（既定値のある項目は必須にしない）、範囲は組織の外・組織・ワークスペース', async () => {
    const person = await createLoginPerson();
    const listed = await list(provisionalApp, person, 'write');
    const byName = new Map(listed.map((operation) => [operation.name, operation]));
    const rename = byName.get(renameWorkspace.name)!;
    expect(rename.scope).toBe('workspace');
    const input = rename.input_schema as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(input.properties).sort()).toEqual(['count', 'name', 'workspace_id']);
    expect(input.required).toEqual(expect.arrayContaining(['workspace_id', 'name']));
    expect(input.required ?? []).not.toContain('count');
    expect(byName.get(whoAmI.name)!.scope).toBe('outside');
    expect(byName.get(organizationProfile.name)!.scope).toBe('organization');
    // workspace: true の admin の操作も workspace
    expect(byName.get(closeWorkspace.name)).toMatchObject({ scope: 'workspace', permission: 'admin' });
  });
});

describe('本番の一覧', () => {
  const scopeOf = (definition: AnyOperationDefinition) =>
    definition.permission === 'login' || definition.permission === 'operator'
      ? 'outside'
      : definition.workspace === true
        ? 'workspace'
        : 'organization';

  for (const credential of ['cookie', 'write', 'read'] as const) {
    test(`${credential} で呼ぶと、本番の定義のうちトークンで呼べうる操作を返す`, async () => {
      const person = await createLoginPerson();
      const listed = namesOf(await list(realApp, person, credential));
      expect(listed).toEqual(expectedNames(operations, credential));
      for (const name of [logout.name, tokenCreate.name, tokenList.name, tokenRevoke.name, 'create-organization']) {
        expect(listed).not.toContain(name);
      }
      expect(listed).toContain('operation-list');
    });
  }

  test('各項目の範囲、権限、mode、説明が定義と一致し、入力と出力の JSON Schema が object', async () => {
    const person = await createLoginPerson();
    const listed = await list(realApp, person, 'write');
    const definitions = new Map(operations.map((definition) => [definition.name, definition]));
    expect(listed.length).toBeGreaterThan(0);
    for (const item of listed) {
      const definition = definitions.get(item.name);
      expect(definition, item.name).toBeDefined();
      expect(item, item.name).toMatchObject({
        description: definition!.description,
        mode: definition!.mode,
        permission: definition!.permission,
        scope: scopeOf(definition!),
      });
      for (const schema of [item.input_schema, item.output_schema]) {
        expect(typeof schema, item.name).toBe('object');
        expect(schema, item.name).not.toBeNull();
        expect(Array.isArray(schema), item.name).toBe(false);
        // 入力が union の操作（invitation-create）は、最上位に type を持たず、分岐の1つずつが object になる
        for (const branch of objectBranchesOf(schema)) {
          expect(branch.type, item.name).toBe('object');
        }
      }
      if (definition!.workspace === true) {
        for (const branch of objectBranchesOf(item.input_schema)) {
          expect(Object.keys(branch.properties ?? {}), item.name).toContain('workspace_id');
        }
      }
    }
  });
});

describe('tokenAllows', () => {
  test('運用者の操作と cookieOnly の操作は、どの範囲でも false', () => {
    for (const definition of [operatorPing, cookiePing, logout, tokenCreate, tokenList, tokenRevoke]) {
      expect(tokenAllows(definition, 'read'), definition.name).toBe(false);
      expect(tokenAllows(definition, 'write'), definition.name).toBe(false);
    }
  });

  test('read の操作は read と write の両方で true', () => {
    for (const definition of [whoAmI, organizationProfile, workspaceSummary, operationList]) {
      expect(tokenAllows(definition, 'read'), definition.name).toBe(true);
      expect(tokenAllows(definition, 'write'), definition.name).toBe(true);
    }
  });

  test('write の操作は write だけ true', () => {
    for (const definition of [renameWorkspace, closeWorkspace]) {
      expect(tokenAllows(definition, 'read'), definition.name).toBe(false);
      expect(tokenAllows(definition, 'write'), definition.name).toBe(true);
    }
  });

  test('想定外の mode は read のトークンで false（許す側を列挙する）', () => {
    const odd = { ...whoAmI, mode: 'admin' } as unknown as AnyOperationDefinition;
    expect(tokenAllows(odd, 'read')).toBe(false);
  });
});
