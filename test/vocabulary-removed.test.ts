// 言葉づかいの切り替えを止めた後（#597）の、応答の全体と作成の入力の境界を崩す。
// DB の vocabulary 列に 'game' が残る組織とワークスペースを作っても、読み取りの応答のどこにも vocabulary が出ないこと、
// 作成の入力に vocabulary を何の形で送っても 400 / 500 にならず列が 'scrum' になること、
// 古い change_logs の vocabulary の行が履歴で今も 1 種類の文として返ることを、操作の一覧を回して確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { operations } from '../src/shared/operations/index.ts';
import { isOutsideOperation, type AnyOperationDefinition } from '../src/shared/operations/define.ts';
import { createOrganization as operatorCreateOrganization } from '../src/shared/operations/operator/index.ts';
import { organizationHistory } from '../src/shared/operations/organization/organization-history.ts';
import { workspaceCreate } from '../src/shared/operations/workspace/index.ts';
import { createApp } from '../src/server/app.ts';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { githubUser } from './auth/helpers.ts';
import { createChangeLog, createOrganization, createWorkspace } from './factories.ts';
import { credentialOf, inputFor, post, type Credential } from './operations/harness.ts';
import { operatorGithub, pointers } from './operations/pointers.ts';
import { createTarget, getOperator, withNewSession } from './operations/world.ts';

const app = createApp(implementedOperations, { fetcher: operatorGithub.fetcher });

// 応答の JSON を再帰的にたどり、vocabulary という名前の項目の場所を集める
function vocabularyPaths(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => vocabularyPaths(item, `${path}[${index}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(key.toLowerCase().includes('vocabular') ? [`${path}.${key}`] : []),
    ...vocabularyPaths(child, `${path}.${key}`),
  ]);
}

describe('読み取りの応答に vocabulary が出ない（列が game の組織とワークスペース）', () => {
  const readOperations = operations.filter((definition) => definition.mode === 'read');

  test('読み取りの操作がある', () => {
    expect(readOperations.length).toBeGreaterThan(10);
  });

  describe.each<Credential>(['cookie', 'bearer'])('%s で呼ぶ', (credential) => {
    test('すべての読み取りの操作の応答に、vocabulary を含む名前の項目が無い', async () => {
      const target = await createTarget();
      // ファクトリーの既定は 'game'。読み取りがその列を漏らさないことを見る
      expect(target.organization.vocabulary).toBe('game');
      const operator = await withNewSession(await getOperator());
      // 運用者の組織の一覧にも、列が game の組織が載るようにしておく
      await createOrganization({ vocabulary: 'game' });
      await createWorkspace(target.organization, target.admin.userId!, { vocabulary: 'game' });

      const leaks: string[] = [];
      let succeeded = 0;
      for (const definition of readOperations as AnyOperationDefinition[]) {
        const isOperator = definition.permission === 'operator';
        const caller = isOperator ? operator : target.admin;
        // 運用者の操作と cookieOnly は API トークンでは呼べない
        if (credential === 'bearer' && (isOperator || definition.cookieOnly === true)) continue;
        const res = await post(app, definition, {
          ...(isOrgScoped(definition) ? { slug: target.slug } : {}),
          ...(await credentialOf(caller, credential, 'read')),
          body: await inputFor(pointers, definition, target, caller),
        });
        expect(res.status, `${definition.name}: ${res.status}`).toBeLessThan(500);
        if (res.status !== 200) continue;
        succeeded += 1;
        const text = await res.text();
        for (const path of vocabularyPaths(JSON.parse(text))) leaks.push(`${definition.name} ${path}`);
      }
      expect(leaks).toEqual([]);
      expect(succeeded).toBeGreaterThan(readOperations.length / 2);
    });
  });
});

function isOrgScoped(definition: AnyOperationDefinition): boolean {
  return !isOutsideOperation(definition);
}

describe('ワークスペースの作成の入力の境界', () => {
  const garbage: [string, unknown][] = [
    ['game', 'game'],
    ['不正な文字列', 'pirate'],
    ['配列', ['game', 'scrum']],
    ['null', null],
    ['数値', 1],
    ['オブジェクト', { to: 'game' }],
    ['__proto__ を含むオブジェクト', JSON.parse('{"__proto__":{"vocabulary":"game"}}')],
  ];

  test.each(garbage)('vocabulary に %s を送っても作れ、列は scrum', async (_label, value) => {
    const target = await createTarget();
    const res = await post(app, workspaceCreate, {
      slug: target.slug,
      token: target.admin.token,
      body: { name: '保守チーム', timezone: 'Asia/Tokyo', vocabulary: value, leader_user_id: target.leader.userId! },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const created = (await res.json()) as { workspace_id?: string; id?: string };
    expect(vocabularyPaths(created)).toEqual([]);
    const db = orgDb(env, target.organization.verified);
    const rows = await db.rows(
      db.statement((q) =>
        q
          .selectFrom('workspaces')
          .select(['vocabulary', 'name'])
          .where('organization_id', '=', target.organization.id)
          .where('name', '=', '保守チーム'),
      ),
    );
    expect(rows).toEqual([{ vocabulary: 'scrum', name: '保守チーム' }]);
  });
});

describe('運用者の組織の作成の入力の境界', () => {
  test.each([
    ['game', 'game'],
    ['不正な文字列', 'pirate'],
    ['配列', ['game']],
  ])('vocabulary に %s を足しても作れ、列は scrum で、応答に vocabulary が無い', async (_label, value) => {
    const user = githubUser(`vocab-${crypto.randomUUID().slice(0, 8)}`);
    operatorGithub.addUser(user);
    const slug = `vocab-${crypto.randomUUID().slice(0, 8)}`;
    const operator = await withNewSession(await getOperator());
    const res = await post(app, operatorCreateOrganization, {
      token: operator.token,
      body: {
        slug,
        name: '言葉の確認',
        vocabulary: value,
        admin: { provider: 'github', username: user.login, login_subject: String(user.id) },
      },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(vocabularyPaths(await res.json())).toEqual([]);
    const db = commonDb(env);
    const row = await db.first(
      db.statement((q) => q.selectFrom('organizations').select('vocabulary').where('slug', '=', slug)),
    );
    expect(row).toEqual({ vocabulary: 'scrum' });
  });
});

describe('古い change_logs の vocabulary の行', () => {
  test('theme と並んだ行、vocabulary と別の列が並んだ行、値が壊れた行も、500 にせず履歴に出す', async () => {
    const target = await createTarget();
    const base = { actor_user_id: target.admin.userId, entity_type: 'organization', action: 'update' } as const;
    const bodies = [
      { vocabulary: ['game', 'scrum'], theme: ['simple', 'medieval'] },
      { vocabulary: ['scrum', 'game'] },
      { vocabulary: null },
      { vocabulary: 'game' },
    ];
    for (const [index, changes] of bodies.entries()) {
      await createChangeLog(target.organization, {
        ...base,
        entity_id: target.organization.id,
        changes_json: JSON.stringify(changes),
        created_at: new Date(Date.UTC(2030, 0, 1, 0, bodies.length - index)).toISOString(),
      });
    }
    const res = await post(app, organizationHistory, { slug: target.slug, token: target.admin.token, body: {} });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: { event: { kind: string } }[] };
    expect(body.entries.map((entry) => entry.event.kind)).toEqual(bodies.map(() => 'organization_settings_changed'));
    expect(vocabularyPaths(body)).toEqual([]);
  });
});
