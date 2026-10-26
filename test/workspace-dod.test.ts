// ワークスペースの完成の定義（workspace-dod-update と、workspace の definition_of_done_md）の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts も確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import {
  DEFINITION_OF_DONE_MAX_LENGTH,
  workspaceDodUpdate,
} from '../src/shared/operations/workspace/workspace-dod-update.ts';
import { workspaceInfo } from '../src/shared/operations/workspace/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { createWorkspace } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

function update(target: Target, value: string, person: Person = target.leader, workspaceId = target.workspace.id) {
  return post(app, workspaceDodUpdate, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: workspaceId, definition_of_done_md: value },
  });
}

async function read(target: Target, person: Person = target.member) {
  const res = await post(app, workspaceInfo, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { definition_of_done_md: string | null }).definition_of_done_md;
}

async function stored(target: Target, workspaceId = target.workspace.id) {
  const db = orgDb(env, target.organization.verified);
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('workspaces')
        .select('definition_of_done_md')
        .where('id', '=', workspaceId)
        .where('organization_id', '=', target.organization.id),
    ),
  );
  return row?.definition_of_done_md;
}

async function logsOf(target: Target, workspaceId = target.workspace.id) {
  const db = orgDb(env, target.organization.verified);
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .select(['action', 'changes_json', 'workspace_id', 'actor_user_id'])
        .where('organization_id', '=', target.organization.id)
        .where('entity_type', '=', 'workspace')
        .where('entity_id', '=', workspaceId)
        .orderBy('created_at')
        .orderBy('id'),
    ),
  );
  return rows.map((row) => ({ ...row, changes: JSON.parse(row.changes_json) as Record<string, unknown> }));
}

describe('workspace-dod-update', () => {
  test('リーダーが書くと保存され、workspace の操作が返し、変更の履歴が残る。末尾の空白と前後の空行は落とす', async () => {
    const target = await createTarget();
    expect(await read(target)).toBeNull();

    const res = await update(target, '\n\n- レビューを通した\r\n- テストが通る  \n\n');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ definition_of_done_md: '- レビューを通した\n- テストが通る' });
    expect(await stored(target)).toBe('- レビューを通した\n- テストが通る');
    // メンバーも読める
    expect(await read(target, target.member)).toBe('- レビューを通した\n- テストが通る');
    expect(await logsOf(target)).toMatchObject([
      {
        action: 'update',
        workspace_id: target.workspace.id,
        actor_user_id: target.leader.userId,
        changes: { definition_of_done_md: [null, '- レビューを通した\n- テストが通る'] },
      },
    ]);
  });

  test('空白だけを送ると空（null）にし、前の値を履歴に残す。管理者も書ける', async () => {
    const target = await createTarget();
    expect((await update(target, '- レビューを通した')).status).toBe(200);
    const res = await update(target, '  \n\t\n ', target.admin);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ definition_of_done_md: null });
    expect(await stored(target)).toBeNull();
    expect(await read(target)).toBeNull();
    const logs = await logsOf(target);
    expect(logs).toHaveLength(2);
    expect(logs[1]).toMatchObject({
      actor_user_id: target.admin.userId,
      changes: { definition_of_done_md: ['- レビューを通した', null] },
    });
  });

  test('今の値と同じなら何も書かない（履歴も増えない）', async () => {
    const target = await createTarget();
    expect((await update(target, '- レビューを通した')).status).toBe(200);
    const again = await update(target, '- レビューを通した\n');
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ definition_of_done_md: '- レビューを通した' });
    expect(await logsOf(target)).toHaveLength(1);
    // 空のまま空を送っても書かない
    const empty = await createTarget();
    expect((await update(empty, '')).status).toBe(200);
    expect(await logsOf(empty)).toHaveLength(0);
  });

  test('上限の 10 万字は書け、それを超えると 400。見えない文字も 400。どちらも書かない', async () => {
    const target = await createTarget();
    const longest = 'あ'.repeat(DEFINITION_OF_DONE_MAX_LENGTH);
    expect((await update(target, longest)).status).toBe(200);
    expect(await stored(target)).toBe(longest);

    const tooLong = await update(target, 'い'.repeat(DEFINITION_OF_DONE_MAX_LENGTH + 1));
    expect(tooLong.status).toBe(400);
    expect(await errorCodeOf(tooLong)).toBe('invalid_input');
    const hidden = await update(target, '- レビュー​を通した');
    expect(hidden.status).toBe(400);
    expect(await stored(target)).toBe(longest);
    expect(await logsOf(target)).toHaveLength(1);
  });

  test('一般のメンバーは書けない（403）。読むことはできる', async () => {
    const target = await createTarget();
    const res = await update(target, '- レビューを通した', target.member);
    expect(res.status).toBe(403);
    expect(await stored(target)).toBeNull();
    expect(await read(target, target.member)).toBeNull();
  });

  test('閉じたワークスペースは 409 の workspace_closed で、書かない', async () => {
    const target = await createTarget({ closed: true });
    const res = await update(target, '- レビューを通した');
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
    expect(await stored(target)).toBeNull();
    expect(await logsOf(target)).toHaveLength(0);
  });

  test('別の組織のワークスペースと、存在しない ID は 404 で、どちらも書かない', async () => {
    const [target, other] = await Promise.all([createTarget(), createTarget()]);
    for (const id of [other.workspace.id, crypto.randomUUID()]) {
      const res = await update(target, '- レビューを通した', target.admin, id);
      expect(res.status).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    }
    expect(await stored(other)).toBeNull();
    expect(await logsOf(other)).toHaveLength(0);
  });

  test('同じ組織の別のワークスペースの値は変えない', async () => {
    const target = await createTarget();
    const sibling = await createWorkspace(target.organization, target.admin.userId!, {
      definition_of_done_md: '- 別のチームの掟',
    });
    expect((await update(target, '- レビューを通した')).status).toBe(200);
    expect(await stored(target, sibling.id)).toBe('- 別のチームの掟');
  });
});
