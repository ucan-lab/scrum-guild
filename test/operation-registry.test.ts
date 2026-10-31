// 本番の操作の一覧を回して、組織の分離と権限を確かめる。新しい操作を足しても、このファイルは書き足さない。
// 組織の中の操作のテスト用の関数（test/operations/pointers.ts）が無いと落ちる。
// 一覧の各操作を回す検査は、塊に分けた test/operation-registry-production-<番号>.test.ts にある。
// このファイルは、仕組みの自己確認、テスト用の関数の確認、塊が全操作を覆うことの確認、運用者の操作の確認を持つ
import { describe, expect, test } from 'vitest';
import { isWorkspaceOperation, permissions } from '../src/shared/operations/define.ts';
import { operations } from '../src/shared/operations/index.ts';
import { createApp } from '../src/server/app.ts';
import { ApiError } from '../src/server/errors.ts';
import { implement } from '../src/server/operations/implement.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { operationChunk, productionChunkCount } from './operations/chunks.ts';
import { assertPointersCover, checkRowIsolation, defineOperationChecks, post } from './operations/harness.ts';
import { pointers } from './operations/pointers.ts';
import { provisionalOperations, provisionalPointers, renameWorkspace, taskTitle } from './operations/provisional.ts';
import { createTarget } from './operations/world.ts';

describe('本番の操作の一覧', () => {
  test('定義の一覧と、処理を結んだ一覧が同じ操作を持つ', () => {
    expect(implementedOperations.map((operation) => operation.definition.name).sort()).toEqual(
      operations.map((definition) => definition.name).sort(),
    );
  });

  test('組織の中のすべての操作にテスト用の関数がある', () => {
    expect(() => assertPointersCover(implementedOperations, pointers)).not.toThrow();
  });
});

describe('テスト用の関数の検査', () => {
  test('関数の無い組織の中の操作があると落ちる', () => {
    const withoutTaskTitle = Object.fromEntries(
      Object.entries(provisionalPointers).filter(([name]) => name !== 'task-title'),
    );
    expect(() => assertPointersCover(provisionalOperations, withoutTaskTitle)).toThrow(/task-title/);
  });

  test('組織の外の操作は関数が無くてもよい', () => {
    expect(() => assertPointersCover(provisionalOperations, provisionalPointers)).not.toThrow();
  });

  test('一覧に無い操作の関数があると落ちる', () => {
    expect(() =>
      assertPointersCover(provisionalOperations, { ...provisionalPointers, 'no-such': { noReference: {} } }),
    ).toThrow(/no-such/);
  });

  test('入力に _id で終わる項目がある操作に noReference を付けると落ちる', () => {
    expect(() =>
      assertPointersCover(provisionalOperations, {
        ...provisionalPointers,
        'task-title': { noReference: { task_id: 'x' } },
      }),
    ).toThrow(/task_id/);
    expect(() =>
      assertPointersCover(provisionalOperations, {
        ...provisionalPointers,
        'workspace-summary': { noReference: { workspace_id: 'x' } },
      }),
    ).toThrow(/workspace_id/);
  });

  test('仮の操作の一覧がすべての権限の種類を含む', () => {
    const covered = new Set(provisionalOperations.map((operation) => operation.definition.permission));
    expect([...covered].sort()).toEqual([...permissions].sort());
  });
});

describe('分離の検査の自己確認', () => {
  // 組織で絞らない処理（ID だけでタスクを引く）を、本物と同じ検査に通すと落ちる
  const unscopedTaskTitle = implement(taskTitle, async ({ db, input }) => {
    const task = await db.first(
      db.statement((q) => q.selectFrom('tasks').select('title').where('id', '=', input.task_id)),
    );
    if (task === undefined) throw new ApiError(404, 'not_found');
    return { title: task.title };
  });

  test('組織で絞らない処理は落ちる', async () => {
    const [own, other] = await Promise.all([createTarget(), createTarget()]);
    await expect(
      checkRowIsolation(createApp([unscopedTaskTitle]), taskTitle, provisionalPointers, own, other),
    ).rejects.toThrow(/別の組織の行を指す入力/);
  });

  test('組織で絞る処理は通る', async () => {
    const [own, other] = await Promise.all([createTarget(), createTarget()]);
    await expect(
      checkRowIsolation(createApp(provisionalOperations), taskTitle, provisionalPointers, own, other),
    ).resolves.toBeUndefined();
  });

  test('ワークスペースの下の操作に別の組織の workspace_id を渡すと、処理に届く前に 404 になる', async () => {
    const [own, other] = await Promise.all([createTarget(), createTarget()]);
    const res = await post(createApp(provisionalOperations), renameWorkspace, {
      slug: own.slug,
      token: own.admin.token,
      body: { workspace_id: other.workspace.id, name: '書き換え' },
    });
    expect(res.status).toBe(404);
  });
});

// 仕組みそのもの（登録の関数、権限の検査、分離の検査）を仮の操作で確かめる
describe('仮の操作の一覧', () => {
  assertPointersCover(provisionalOperations, provisionalPointers);
  defineOperationChecks(provisionalOperations, provisionalPointers);
});

describe('仮の操作の一覧（API トークン）', () => {
  defineOperationChecks(provisionalOperations, provisionalPointers, { credential: 'bearer' });
});

// 本番の一覧。関数の足し忘れは、ファイルの読み込みで落ちる。
// 一覧の各操作を回す検査（Cookie と API トークンの2通り。運用者の操作は、差し替えた GitHub に問い合わせる）は、
// 1つのファイルで回すと終わりが遅い尾になるので、操作の名前で決まる塊に分け、塊ごとに
// test/operation-registry-production-<番号>.test.ts で回す（割り方は test/operations/chunks.ts）
assertPointersCover(implementedOperations, pointers);

describe('本番の一覧の塊', () => {
  const names = implementedOperations.map((operation) => operation.definition.name);
  const chunks = Array.from({ length: productionChunkCount }, (_, index) =>
    operationChunk(implementedOperations, index, productionChunkCount).map((operation) => operation.definition.name),
  );

  test('塊を合わせると、一覧のすべての操作を1回ずつ覆う（抜けも重なりも無い）', () => {
    expect(chunks.flat().sort()).toEqual([...names].sort());
    expect(new Set(chunks.flat()).size).toBe(names.length);
  });

  test('どの塊にも操作がある', () => {
    for (const chunk of chunks) expect(chunk.length).toBeGreaterThan(0);
  });

  test('同じ入力なら、操作の並びが違っても同じ塊になる', () => {
    const reversed = [...implementedOperations].reverse();
    for (let index = 0; index < productionChunkCount; index++) {
      expect(
        operationChunk(reversed, index, productionChunkCount).map((operation) => operation.definition.name),
      ).toEqual(chunks[index]);
    }
  });

  test('塊の番号か数が正しくないと落ちる', () => {
    expect(() => operationChunk(implementedOperations, productionChunkCount, productionChunkCount)).toThrow();
    expect(() => operationChunk(implementedOperations, -1, productionChunkCount)).toThrow();
    expect(() => operationChunk(implementedOperations, 0, 0)).toThrow();
  });

  test('塊のファイルが、塊の数と同じだけある（番号は 1 から）', () => {
    const files = Object.keys(import.meta.glob('./operation-registry-production-*.test.ts')).sort();
    expect(files).toEqual(
      Array.from({ length: productionChunkCount }, (_, i) => `./operation-registry-production-${i + 1}.test.ts`),
    );
  });
});

// allowClosed の無いワークスペースの下の write を、閉じたワークスペースで呼んで 409 の workspace_closed になることは、
// 一覧の各操作に当てる検査（defineOperationChecks。test/operations/harness.ts）が確かめる。
// ここでは、その検査が対象にする操作の範囲が、期待どおりであることだけを見る
describe('本番の閉じたワークスペースへの書き込み', () => {
  const guarded = implementedOperations
    .map((operation) => operation.definition)
    .filter(isWorkspaceOperation)
    .filter((definition) => definition.mode === 'write' && definition.allowClosed !== true);

  test('止める書き込みの一覧は、タスクの作成と完了を含み、開き直す操作を含まない', () => {
    const names = guarded.map((definition) => definition.name);
    expect(names).toEqual(expect.arrayContaining(['task-create', 'task-complete', 'workspace-close']));
    expect(names).not.toContain('workspace-reopen');
  });
});

describe('本番の運用者の操作', () => {
  test('組織の一覧、GitHub のユーザー名の解決、組織の作成、停止、再開、管理者の指名し直し、上限の変更が、運用者の権限で一覧に載っている', () => {
    const operator = implementedOperations
      .map((operation) => operation.definition)
      .filter((definition) => definition.permission === 'operator')
      .map((definition) => definition.name)
      .sort();
    expect(operator).toEqual([
      'create-organization',
      'list-organizations',
      'organization-admin-reassign',
      'organization-quota-update',
      'organization-resume',
      'organization-suspend',
      'organization-suspension-update',
      'resolve-github-user',
    ]);
  });
});
