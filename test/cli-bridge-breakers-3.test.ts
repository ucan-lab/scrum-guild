// 一覧（operation-list）と実際の呼び出しの可否を、本物の app の全操作で突き合わせる。
// Issue #582 の前提「トークンで呼べるかの判定を tokenAllows に切り出し、checkTokenScope と一覧が同じ関数を使う — 一覧の絞りと呼び出しの 403 を食い違わせない」と、
// 「一覧はトークンで絞り、役割では絞らない」。組織の管理者のトークンで呼ぶので、一覧に載る操作は役割の 403 にもならないはず
import { describe, expect, test } from 'vitest';
import { operations } from '../src/shared/operations/index.ts';
import { isOutsideOperation, isWorkspaceOperation } from '../src/shared/operations/define.ts';
import { createApp } from '../src/server/app.ts';
import { insertApiToken } from './operations/api-token.ts';
import { post } from './operations/harness.ts';
import { createTarget, testEnv } from './operations/world.ts';

const app = createApp();

describe('一覧に載る操作だけがトークンで呼べる（本物の app の全操作）', () => {
  for (const scope of ['read', 'write'] as const) {
    test(`${scope} のトークン: 一覧に載る操作は 403 にも 500 にもならず、載らない操作は 403`, async () => {
      const target = await createTarget();
      const bearer = (await insertApiToken(target.admin.accountId, { scope })).raw;
      const listRes = await app.request(
        '/api/operation-list',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
          body: '{}',
        },
        testEnv,
      );
      expect(listRes.status).toBe(200);
      const listed = new Set(
        ((await listRes.json()) as { operations: { name: string }[] }).operations.map((o) => o.name),
      );

      // 両側を回したことを確かめる（一覧に載らない操作は、運用者の操作と cookieOnly がどの範囲でもある）
      expect(listed.size).toBeGreaterThan(10);
      expect(operations.filter((definition) => !listed.has(definition.name)).length).toBeGreaterThan(0);

      const mismatches: string[] = [];
      for (const definition of operations) {
        const body = isWorkspaceOperation(definition) ? { workspace_id: target.workspace.id } : {};
        const res = await post(app, definition, {
          bearer,
          origin: null,
          body,
          ...(isOutsideOperation(definition) ? {} : { slug: target.slug }),
        });
        const forbidden = res.status === 403;
        if (listed.has(definition.name) && (forbidden || res.status >= 500)) {
          mismatches.push(`${definition.name}: 一覧に載るのに ${res.status}`);
        }
        if (!listed.has(definition.name) && !forbidden) {
          mismatches.push(`${definition.name}: 一覧に無いのに ${res.status}`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  }
});
