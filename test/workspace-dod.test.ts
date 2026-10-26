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
import { orgDb, verifyWorkspace } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { workspaceDodUpdateOperation } from '../src/server/operations/workspace.ts';
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

  test('空の文字列の行は、workspace の操作が null にそろえて返す', async () => {
    const target = await createTarget();
    const db = orgDb(env, target.organization.verified);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('workspaces')
          .set({ definition_of_done_md: '' })
          .where('id', '=', target.workspace.id)
          .where('organization_id', '=', target.organization.id),
      ),
    );
    expect(await read(target)).toBeNull();
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

// 処理を直に呼び、完成の定義を読む文が答えを返した直後に race を呼ぶ（n は何回目の読み取りか）。
// 「今の値を読んだ後、書く前に別の要求が書く」状況を作る（test/task-edit.test.ts の runWithRace と同じ作り）
async function runWithRace(target: Target, person: Person, value: string, race: (n: number) => Promise<void>) {
  const db = orgDb(env, target.organization.verified);
  const actor = { accountId: person.accountId, userId: person.userId, isAdmin: false, invitedOnly: false };
  const workspace = await verifyWorkspace(db, actor, target.workspace.id);
  let reads = 0;
  const racing = new Proxy(db, {
    get(base, key) {
      // 入口は #private を持つので、メソッドは本物の入口に結んで返す
      const method = Reflect.get(base, key, base);
      if (typeof method !== 'function') return method;
      if (key !== 'first') return method.bind(base);
      return async (...args: unknown[]) => {
        const result = await (method as (...a: unknown[]) => Promise<unknown>).apply(base, args);
        // 完成の定義を返した読み取りだけを数える（閉じたかどうかの読み取りは数えない）
        if (typeof result === 'object' && result !== null && 'definition_of_done_md' in result) await race(++reads);
        return result;
      };
    },
  });
  const context = {
    db: racing,
    actor,
    workspace,
    input: { workspace_id: target.workspace.id, definition_of_done_md: value },
    defer: () => {},
  } as never;
  return workspaceDodUpdateOperation.handler(context);
}

describe('workspace-dod-update の競合（読んだ後、書く前に別の要求が書く）', () => {
  test('負けた周は履歴を書かず、読み直してやり直す。最後に書いた値が残り、履歴の「前」は実際に上書きした値', async () => {
    const target = await createTarget();
    const result = await runWithRace(target, target.leader, '- 自分の掟', async (n) => {
      // 1回目の読み取りの後にだけ、管理者が別の値を書く
      if (n === 1) expect((await update(target, '- 先に書いた掟', target.admin)).status).toBe(200);
    });
    expect(result).toEqual({ definition_of_done_md: '- 自分の掟' });
    expect(await stored(target)).toBe('- 自分の掟');
    expect(await logsOf(target)).toMatchObject([
      { actor_user_id: target.admin.userId, changes: { definition_of_done_md: [null, '- 先に書いた掟'] } },
      { actor_user_id: target.leader.userId, changes: { definition_of_done_md: ['- 先に書いた掟', '- 自分の掟'] } },
    ]);
  });

  test('3回続けて負けたら 409 の conflict で、自分の履歴は書かない', async () => {
    const target = await createTarget();
    await expect(
      runWithRace(target, target.leader, '- 自分の掟', async (n) => {
        expect((await update(target, `- 別の掟 ${n}`, target.admin)).status).toBe(200);
      }),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });
    expect(await stored(target)).toBe('- 別の掟 3');
    const logs = await logsOf(target);
    expect(logs.map((log) => log.actor_user_id)).toEqual([
      target.admin.userId,
      target.admin.userId,
      target.admin.userId,
    ]);
  });

  test('読んだ後にワークスペースが閉じたら、何も書かず 409 の workspace_closed', async () => {
    const target = await createTarget();
    await expect(
      runWithRace(target, target.leader, '- 自分の掟', async (n) => {
        if (n !== 1) return;
        const db = orgDb(env, target.organization.verified);
        await db.run(
          db.statement((q) =>
            q
              .updateTable('workspaces')
              .set({ closed_at: '2026-10-22T00:00:00.000Z' })
              .where('id', '=', target.workspace.id)
              .where('organization_id', '=', target.organization.id),
          ),
        );
      }),
    ).rejects.toMatchObject({ status: 409, code: 'workspace_closed' });
    expect(await stored(target)).toBeNull();
    expect(await logsOf(target)).toHaveLength(0);
  });
});
