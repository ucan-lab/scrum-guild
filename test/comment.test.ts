// タスクのコメント（comment-list、comment-create、comment-update、comment-delete）の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { COMMENT_BODY_MAX_LENGTH } from '../src/shared/comment.ts';
import {
  commentCreate,
  commentDelete,
  commentList,
  commentUpdate,
  taskHistory,
  type Comment,
} from '../src/shared/operations/task/index.ts';
import type { AnyOperationDefinition } from '../src/shared/operations/define.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb, verifyWorkspace } from '../src/server/db/index.ts';
import { queryPlanForTest } from '../src/server/db/testing.ts';
import {
  commentDeleteOperation,
  commentPageStatement,
  commentUpdateOperation,
} from '../src/server/operations/comment.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { AT, createComment, createTask, createWorkspace } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

type ListBody = {
  comments: Comment[];
  next: { created_at: string; id: string } | null;
  count: number;
  timezone: string;
};

function call(target: Target, definition: AnyOperationDefinition, body: Record<string, unknown>, person: Person) {
  return post(app, definition, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, ...body },
  });
}

async function list(
  target: Target,
  taskId: string,
  person: Person = target.member,
  before?: ListBody['next'],
): Promise<ListBody> {
  const res = await call(target, commentList, { task_id: taskId, ...(before ? { before } : {}) }, person);
  expect(res.status).toBe(200);
  return (await res.json()) as ListBody;
}

async function commentRow(target: Target, commentId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.first(
    db.statement((q) =>
      q.selectFrom('comments').selectAll().where('id', '=', commentId).where('workspace_id', '=', target.workspace.id),
    ),
  );
}

async function commentLogs(target: Target, commentId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('entity_type', '=', 'comment')
        .where('entity_id', '=', commentId)
        .where('organization_id', '=', target.organization.id)
        .orderBy('created_at')
        .orderBy('id'),
    ),
  );
}

async function setName(target: Target, person: Person, name: string) {
  const db = orgDb(env, target.organization.verified);
  await db.run(
    db.statement((q) =>
      q
        .updateTable('users')
        .set({ name })
        .where('id', '=', person.userId!)
        .where('organization_id', '=', target.organization.id),
    ),
  );
}

async function nameOf(target: Target, person: Person) {
  const db = orgDb(env, target.organization.verified);
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('users')
        .select('name')
        .where('id', '=', person.userId!)
        .where('organization_id', '=', target.organization.id),
    ),
  );
  return row!.name;
}

async function closeWorkspace(db: ReturnType<typeof orgDb>, target: Target) {
  await db.run(
    db.statement((q) =>
      q
        .updateTable('workspaces')
        .set({ closed_at: '2026-10-22T00:00:00.000Z' })
        .where('id', '=', target.workspace.id)
        .where('organization_id', '=', target.organization.id),
    ),
  );
}

describe('comment-create', () => {
  test('本文を整えて書き、書いた行を返す。変更の履歴は書かない', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    const res = await call(
      target,
      commentCreate,
      { task_id: task.id, body_md: '\r\n\n  手順の **2** から\r\n進めます  \n\n' },
      target.member,
    );
    expect(res.status).toBe(200);
    const { comment } = (await res.json()) as { comment: Comment };
    expect(comment).toMatchObject({
      author: { id: target.member.userId, name: await nameOf(target, target.member) },
      body_md: '  手順の **2** から\n進めます',
      edited_at: null,
      deleted_at: null,
      deleted_by: null,
      can_edit: true,
      can_delete: true,
    });
    expect(await commentRow(target, comment.id)).toMatchObject({
      task_id: task.id,
      author_user_id: target.member.userId,
      body_md: '  手順の **2** から\n進めます',
    });
    expect(await commentLogs(target, comment.id)).toEqual([]);
  });

  test.each([
    ['空', ''],
    ['空白と改行だけ', ' \n\t\n '],
    ['10 万字を超える', 'あ'.repeat(COMMENT_BODY_MAX_LENGTH + 1)],
    ['見えない文字を含む', '確認​しました'],
  ])('本文が%sなら 400', async (_, body) => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    const res = await call(target, commentCreate, { task_id: task.id, body_md: body }, target.member);
    expect(res.status).toBe(400);
    expect((await list(target, task.id)).comments).toEqual([]);
  });

  test('10 万字ちょうどは書ける', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    const res = await call(
      target,
      commentCreate,
      { task_id: task.id, body_md: '😀'.repeat(COMMENT_BODY_MAX_LENGTH) },
      target.member,
    );
    expect(res.status).toBe(200);
  });

  test('受信箱、アーカイブ、完了したタスクにも書ける', async () => {
    const target = await createTarget();
    for (const overrides of [
      { is_imported: 1, tray: 'inbox' },
      { is_imported: 1, tray: 'archive' },
      { completed_at: AT, completed_by: target.admin.userId },
    ]) {
      const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, overrides);
      const res = await call(target, commentCreate, { task_id: task.id, body_md: '確認しました' }, target.member);
      expect(res.status, JSON.stringify(overrides)).toBe(200);
    }
  });

  test('削除したタスク、別のワークスペースのタスク、無いタスクは 404', async () => {
    const target = await createTarget();
    const deleted = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      deleted_at: AT,
    });
    const elsewhere = await createTask(target.organization, target.otherWorkspace.id, target.admin.userId!);
    for (const taskId of [deleted.id, elsewhere.id, '019a0000-0000-7000-8000-000000000001']) {
      const res = await call(target, commentCreate, { task_id: taskId, body_md: '確認しました' }, target.admin);
      expect(res.status).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    }
  });
});

describe('comment-list', () => {
  test('書いた順に並べ、消したコメントは本文を空にして残す。件数は消していないものだけ。名前は今の名前', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    const first = await createComment(target.organization, target.workspace.id, task.id, target.member.userId!);
    const second = await createComment(target.organization, target.workspace.id, task.id, target.leader.userId!, {
      edited_at: '2026-10-21T00:00:00.000Z',
    });
    const third = await createComment(target.organization, target.workspace.id, task.id, target.member.userId!, {
      body_md: '',
      deleted_at: '2026-10-21T00:00:00.000Z',
      deleted_by: target.leader.userId,
    });
    // 別のタスクのコメントは混ざらない
    const other = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    await createComment(target.organization, target.workspace.id, other.id, target.member.userId!);
    await setName(target, target.leader, 'ハルカ（改名）');

    const body = await list(target, task.id);
    expect(body.comments.map((comment) => comment.id)).toEqual([first.id, second.id, third.id]);
    expect(body.count).toBe(2);
    expect(body.next).toBeNull();
    expect(body.timezone).toBe('Asia/Tokyo');
    expect(body.comments[0]).toMatchObject({ body_md: first.body_md, can_edit: true, can_delete: true });
    expect(body.comments[1]).toMatchObject({
      author: { id: target.leader.userId, name: 'ハルカ（改名）' },
      edited_at: '2026-10-21T00:00:00.000Z',
      // 一般のメンバーは、人のコメントを直せず、消せない
      can_edit: false,
      can_delete: false,
    });
    expect(body.comments[2]).toMatchObject({
      body_md: '',
      deleted_by: { id: target.leader.userId, name: 'ハルカ（改名）' },
      can_edit: false,
      can_delete: false,
    });
  });

  test('リーダーと管理者は人のコメントを消せるが、直せない', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    await createComment(target.organization, target.workspace.id, task.id, target.member.userId!);
    for (const person of [target.leader, target.admin]) {
      const [comment] = (await list(target, task.id, person)).comments;
      expect(comment).toMatchObject({ can_edit: false, can_delete: true });
    }
  });

  test('初めは新しい 50 件を書いた順に返し、next で前の 50 件を読む。消したコメントも数える', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    const created = [];
    for (let i = 0; i < 52; i++) {
      created.push(
        await createComment(
          target.organization,
          target.workspace.id,
          task.id,
          target.member.userId!,
          i === 51 ? { body_md: '', deleted_at: AT, deleted_by: target.member.userId } : {},
        ),
      );
    }
    const page = await list(target, task.id);
    expect(page.comments.map((comment) => comment.id)).toEqual(created.slice(2).map((comment) => comment.id));
    expect(page.count).toBe(51);
    expect(page.next).toEqual({ created_at: created[2]!.created_at, id: created[2]!.id });
    const earlier = await list(target, task.id, target.member, page.next);
    expect(earlier.comments.map((comment) => comment.id)).toEqual(created.slice(0, 2).map((comment) => comment.id));
    expect(earlier.next).toBeNull();
  });

  test('同じ日時のコメントは id の順で、境目でも抜けも重なりも無い', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    const ids: string[] = [];
    for (let i = 0; i < 51; i++) {
      const row = await createComment(target.organization, target.workspace.id, task.id, target.member.userId!, {
        created_at: AT,
      });
      ids.push(row.id);
    }
    ids.sort();
    const page = await list(target, task.id);
    expect(page.comments.map((comment) => comment.id)).toEqual(ids.slice(1));
    const earlier = await list(target, task.id, target.member, page.next);
    expect(earlier.comments.map((comment) => comment.id)).toEqual(ids.slice(0, 1));
  });

  test('削除したタスク、別のワークスペースのタスクは 404', async () => {
    const target = await createTarget();
    const deleted = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      deleted_at: AT,
    });
    const elsewhere = await createTask(target.organization, target.otherWorkspace.id, target.admin.userId!);
    for (const taskId of [deleted.id, elsewhere.id]) {
      const res = await call(target, commentList, { task_id: taskId }, target.admin);
      expect(res.status).toBe(404);
    }
  });

  test('閉じたワークスペースでは読めるが、直す、消すの印は偽', async () => {
    const target = await createTarget({ closed: true });
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    await createComment(target.organization, target.workspace.id, task.id, target.member.userId!);
    const [comment] = (await list(target, task.id)).comments;
    expect(comment).toMatchObject({ can_edit: false, can_delete: false });
  });

  test('一覧の文は comments_task の索引で引き、表を走査しない', async () => {
    const target = await createTarget();
    const db = orgDb(env, target.organization.verified);
    for (const before of [undefined, { created_at: AT, id: '019a0000-0000-7000-8000-000000000001' }]) {
      const plan = (await queryPlanForTest(env, commentPageStatement(db, target.workspace.id, 'x', before))).join('\n');
      expect(plan).toMatch(/SEARCH comments USING INDEX comments_task \(task_id=\?/);
      expect(plan).not.toMatch(/SCAN comments\b/);
    }
  });
});

describe('comment-update', () => {
  test('本人は直せる。edited_at を書き、変更の履歴には誰のどのタスクのコメントかだけを残し、本文は入れない', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    const original = await createComment(target.organization, target.workspace.id, task.id, target.member.userId!, {
      body_md: '元の秘密の本文',
    });
    const res = await call(
      target,
      commentUpdate,
      { comment_id: original.id, body_md: '直した秘密の本文\n' },
      target.member,
    );
    expect(res.status).toBe(200);
    const { comment } = (await res.json()) as { comment: Comment };
    expect(comment.body_md).toBe('直した秘密の本文');
    expect(comment.edited_at).not.toBeNull();
    expect(await commentRow(target, original.id)).toMatchObject({ body_md: '直した秘密の本文' });

    const logs = await commentLogs(target, original.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      workspace_id: target.workspace.id,
      actor_user_id: target.member.userId,
      action: 'update',
      created_at: comment.edited_at,
    });
    const author = { id: target.member.userId, name: await nameOf(target, target.member) };
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({ task_id: [task.id, task.id], author: [author, author] });
    expect(logs[0]!.changes_json).not.toContain('秘密');
    // タスクの変更の履歴にはコメントの行を出さない
    const history = await call(target, taskHistory, { task_id: task.id }, target.member);
    expect(((await history.json()) as { entries: unknown[] }).entries).toEqual([]);
  });

  test('今と同じ本文なら何も書かない', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    const original = await createComment(target.organization, target.workspace.id, task.id, target.member.userId!);
    const res = await call(
      target,
      commentUpdate,
      { comment_id: original.id, body_md: `${original.body_md}  ` },
      target.member,
    );
    expect(res.status).toBe(200);
    expect(await commentRow(target, original.id)).toEqual(original);
    expect(await commentLogs(target, original.id)).toEqual([]);
  });

  test('本人でなければ、リーダーと管理者も 403', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    const original = await createComment(target.organization, target.workspace.id, task.id, target.member.userId!);
    for (const person of [target.leader, target.admin]) {
      const res = await call(target, commentUpdate, { comment_id: original.id, body_md: '書き換える' }, person);
      expect(res.status).toBe(403);
      expect(await errorCodeOf(res)).toBe('forbidden');
    }
    expect(await commentRow(target, original.id)).toEqual(original);
  });

  test('消えたコメントは 409 の conflict（deleted）。本人でなければ権限の 403 が先', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    const deleted = await createComment(target.organization, target.workspace.id, task.id, target.member.userId!, {
      body_md: '',
      deleted_at: AT,
      deleted_by: target.leader.userId,
    });
    const res = await call(target, commentUpdate, { comment_id: deleted.id, body_md: '書き戻す' }, target.member);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'conflict', details: { reason: 'deleted' } } });
    const other = await call(target, commentUpdate, { comment_id: deleted.id, body_md: '書き戻す' }, target.leader);
    expect(other.status).toBe(403);
    expect(await commentRow(target, deleted.id)).toEqual(deleted);
  });

  test('無いコメント、削除したタスクのコメント、別のワークスペースのコメントは、権限より先に 404', async () => {
    const target = await createTarget();
    const deletedTask = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      deleted_at: AT,
    });
    const onDeletedTask = await createComment(
      target.organization,
      target.workspace.id,
      deletedTask.id,
      target.admin.userId!,
    );
    // 別のワークスペース（同じ組織）のコメント。呼ぶ人はそのワークスペースに所属していない
    const elsewhereTask = await createTask(target.organization, target.otherWorkspace.id, target.admin.userId!);
    const elsewhere = await createComment(
      target.organization,
      target.otherWorkspace.id,
      elsewhereTask.id,
      target.admin.userId!,
    );
    for (const commentId of [onDeletedTask.id, elsewhere.id, '019a0000-0000-7000-8000-000000000001']) {
      for (const [definition, extra] of [
        [commentUpdate, { body_md: '書き換える' }],
        [commentDelete, {}],
      ] as const) {
        const res = await call(target, definition, { comment_id: commentId, ...extra }, target.member);
        expect(res.status, `${definition.name} ${commentId}`).toBe(404);
        expect(await errorCodeOf(res)).toBe('not_found');
      }
    }
  });

  test('読んだ後にリーダーが消したら、書く文が止めて 409 の conflict（deleted）。本文は戻らず、履歴も書かない', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    const original = await createComment(target.organization, target.workspace.id, task.id, target.member.userId!);
    await expect(
      runWithRace(
        target,
        target.member,
        commentUpdateOperation,
        { comment_id: original.id, body_md: '直した本文' },
        async () => {
          expect((await call(target, commentDelete, { comment_id: original.id }, target.leader)).status).toBe(200);
        },
      ),
    ).rejects.toMatchObject({ status: 409, code: 'conflict', details: { reason: 'deleted' } });
    expect(await commentRow(target, original.id)).toMatchObject({ body_md: '', deleted_by: target.leader.userId });
    expect((await commentLogs(target, original.id)).map((log) => log.action)).toEqual(['delete']);
  });

  test('読んだ後にワークスペースが閉じたら、何も書かず 409 の workspace_closed', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    const original = await createComment(target.organization, target.workspace.id, task.id, target.member.userId!);
    for (const [operation, extra] of [
      [commentUpdateOperation, { body_md: '直した本文' }],
      [commentDeleteOperation, {}],
    ] as const) {
      await expect(
        runWithRace(target, target.member, operation, { comment_id: original.id, ...extra }, (db) =>
          closeWorkspace(db, target),
        ),
      ).rejects.toMatchObject({ status: 409, code: 'workspace_closed' });
      await reopenWorkspace(target);
    }
    expect(await commentRow(target, original.id)).toEqual(original);
    expect(await commentLogs(target, original.id)).toEqual([]);
  });
});

describe('comment-delete', () => {
  test('本人が消すと、本文を空にして消した日時と人を書き、履歴に本文を入れない', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    const original = await createComment(target.organization, target.workspace.id, task.id, target.member.userId!, {
      body_md: '消したい秘密の本文',
    });
    const res = await call(target, commentDelete, { comment_id: original.id }, target.member);
    expect(res.status).toBe(200);
    const { comment } = (await res.json()) as { comment: Comment };
    expect(comment).toMatchObject({
      body_md: '',
      deleted_by: { id: target.member.userId },
      can_edit: false,
      can_delete: false,
    });
    expect(await commentRow(target, original.id)).toMatchObject({
      body_md: '',
      deleted_at: comment.deleted_at,
      deleted_by: target.member.userId,
    });
    const logs = await commentLogs(target, original.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'delete', actor_user_id: target.member.userId });
    const author = { id: target.member.userId, name: await nameOf(target, target.member) };
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({ task_id: [task.id, task.id], author: [author, author] });
    expect(logs[0]!.changes_json).not.toContain('秘密');
    // 一覧には「削除されました」として残り、件数から外れる
    const body = await list(target, task.id);
    expect(body.comments).toHaveLength(1);
    expect(body.count).toBe(0);
  });

  test('リーダーと管理者は人のコメントを消せる。一般のメンバーは 403', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    const another = await createComment(target.organization, target.workspace.id, task.id, target.leader.userId!);
    const forbidden = await call(target, commentDelete, { comment_id: another.id }, target.member);
    expect(forbidden.status).toBe(403);
    expect(await errorCodeOf(forbidden)).toBe('forbidden');
    for (const person of [target.leader, target.admin]) {
      const mine = await createComment(target.organization, target.workspace.id, task.id, target.member.userId!);
      const res = await call(target, commentDelete, { comment_id: mine.id }, person);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { comment: Comment }).comment.deleted_by?.id).toBe(person.userId);
    }
  });

  test('消えたコメントは 409 の conflict（deleted）で、履歴を二重に書かない', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    const original = await createComment(target.organization, target.workspace.id, task.id, target.member.userId!);
    expect((await call(target, commentDelete, { comment_id: original.id }, target.member)).status).toBe(200);
    const again = await call(target, commentDelete, { comment_id: original.id }, target.leader);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: 'conflict', details: { reason: 'deleted' } } });
    expect(await commentLogs(target, original.id)).toHaveLength(1);
  });

  test('読んだ後に別の要求が消したら、409 の conflict（deleted）で、履歴は1行だけ', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    const original = await createComment(target.organization, target.workspace.id, task.id, target.member.userId!);
    await expect(
      runWithRace(target, target.leader, commentDeleteOperation, { comment_id: original.id }, async () => {
        expect((await call(target, commentDelete, { comment_id: original.id }, target.member)).status).toBe(200);
      }),
    ).rejects.toMatchObject({ status: 409, code: 'conflict', details: { reason: 'deleted' } });
    expect(await commentRow(target, original.id)).toMatchObject({ deleted_by: target.member.userId });
    expect(await commentLogs(target, original.id)).toHaveLength(1);
  });
});

describe('回数の上限', () => {
  test('作成はアカウントと操作ごとに 10 分に 30 回まで。31 回目は 429 の rate_limited', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    for (let i = 0; i < 30; i++) {
      expect(
        (await call(target, commentCreate, { task_id: task.id, body_md: `${i} 回目` }, target.member)).status,
      ).toBe(200);
    }
    const res = await call(target, commentCreate, { task_id: task.id, body_md: '31 回目' }, target.member);
    expect(res.status).toBe(429);
    expect(await errorCodeOf(res)).toBe('rate_limited');
  });

  test('編集もアカウントと操作ごとに 10 分に 30 回まで。31 回目は 429 の rate_limited', async () => {
    const target = await createTarget();
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    const comment = await createComment(target.organization, target.workspace.id, task.id, target.member.userId!);
    for (let i = 0; i < 30; i++) {
      expect(
        (await call(target, commentUpdate, { comment_id: comment.id, body_md: `${i} 回目に直した` }, target.member))
          .status,
      ).toBe(200);
    }
    const res = await call(target, commentUpdate, { comment_id: comment.id, body_md: '31 回目' }, target.member);
    expect(res.status).toBe(429);
    expect(await errorCodeOf(res)).toBe('rate_limited');
  });
});

describe('閉じたワークスペース', () => {
  test('書く、直す、消すは 409 の workspace_closed で、行は変わらない', async () => {
    const target = await createTarget({ closed: true });
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    const original = await createComment(target.organization, target.workspace.id, task.id, target.member.userId!);
    for (const [definition, body] of [
      [commentCreate, { task_id: task.id, body_md: '書く' }],
      [commentUpdate, { comment_id: original.id, body_md: '直す' }],
      [commentDelete, { comment_id: original.id }],
    ] as const) {
      const res = await call(target, definition, body, target.member);
      expect(res.status, definition.name).toBe(409);
      expect(await errorCodeOf(res)).toBe('workspace_closed');
    }
    expect(await commentRow(target, original.id)).toEqual(original);
    expect((await list(target, task.id)).comments).toHaveLength(1);
  });

  // 登録の関数は閉じたワークスペースへの書き込みを入口で止める。処理を直に呼び、入口を通った後に閉じた（読んだ時点で閉じている）ときを見る
  test('処理の中では、無いコメントは閉じていても 404（存在を先に決める）', async () => {
    const target = await createTarget({ closed: true });
    const deletedTask = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      deleted_at: AT,
    });
    const onDeletedTask = await createComment(
      target.organization,
      target.workspace.id,
      deletedTask.id,
      target.member.userId!,
    );
    const elsewhereTask = await createTask(target.organization, target.otherWorkspace.id, target.admin.userId!);
    const elsewhere = await createComment(
      target.organization,
      target.otherWorkspace.id,
      elsewhereTask.id,
      target.member.userId!,
    );
    for (const commentId of [onDeletedTask.id, elsewhere.id, '019a0000-0000-7000-8000-000000000001']) {
      for (const [operation, extra] of [
        [commentUpdateOperation, { body_md: '直す' }],
        [commentDeleteOperation, {}],
      ] as const) {
        await expect(
          runWithRace(target, target.member, operation, { comment_id: commentId, ...extra }, async () => {}),
        ).rejects.toMatchObject({ status: 404, code: 'not_found' });
      }
    }
  });

  test('処理の中では、あるコメントへの同じ本文の更新も、閉じていれば 409 の workspace_closed', async () => {
    const target = await createTarget({ closed: true });
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    const original = await createComment(target.organization, target.workspace.id, task.id, target.member.userId!);
    await expect(
      runWithRace(
        target,
        target.member,
        commentUpdateOperation,
        { comment_id: original.id, body_md: original.body_md },
        async () => {},
      ),
    ).rejects.toMatchObject({ status: 409, code: 'workspace_closed' });
    expect(await commentRow(target, original.id)).toEqual(original);
  });

  test('読んでから書くまでにタスクが削除されたら、直す、消すは 404 で、履歴を書かない', async () => {
    const target = await createTarget();
    for (const [operation, extra] of [
      [commentUpdateOperation, { body_md: '直した本文' }],
      [commentDeleteOperation, {}],
    ] as const) {
      const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
      const original = await createComment(target.organization, target.workspace.id, task.id, target.member.userId!);
      await expect(
        runWithRace(target, target.member, operation, { comment_id: original.id, ...extra }, async (db) => {
          await db.run(
            db.statement((q) =>
              q
                .updateTable('tasks')
                .set({ deleted_at: AT })
                .where('id', '=', task.id)
                .where('workspace_id', '=', target.workspace.id),
            ),
          );
        }),
      ).rejects.toMatchObject({ status: 404, code: 'not_found' });
      expect(await commentRow(target, original.id)).toEqual(original);
      expect(await commentLogs(target, original.id)).toEqual([]);
    }
  });
});

describe('別のワークスペースの人', () => {
  test('同じ組織でも、所属していないワークスペースのコメントは読めない', async () => {
    const target = await createTarget();
    const workspace = await createWorkspace(target.organization, target.admin.userId!);
    const task = await createTask(target.organization, workspace.id, target.admin.userId!);
    const res = await post(app, commentList, {
      slug: target.slug,
      token: target.member.token,
      body: { workspace_id: workspace.id, task_id: task.id },
    });
    expect(res.status).toBe(403);
  });
});

async function reopenWorkspace(target: Target) {
  const db = orgDb(env, target.organization.verified);
  await db.run(
    db.statement((q) =>
      q
        .updateTable('workspaces')
        .set({ closed_at: null })
        .where('id', '=', target.workspace.id)
        .where('organization_id', '=', target.organization.id),
    ),
  );
}

// 処理を直に呼び、コメントの行を返した最初の読み取りの直後に race を呼ぶ。
// 「読んでから書くまでの間に、別の要求が消した（閉じた）」状況を作る
async function runWithRace(
  target: Target,
  person: Person,
  operation: { handler: (context: never) => Promise<unknown> },
  input: Record<string, unknown>,
  race: (db: ReturnType<typeof orgDb>) => Promise<void>,
) {
  const db = orgDb(env, target.organization.verified);
  const actor = { accountId: person.accountId, userId: person.userId, isAdmin: false, invitedOnly: false };
  const workspace = await verifyWorkspace(db, actor, target.workspace.id);
  let raced = false;
  const racing = new Proxy(db, {
    get(base, key) {
      // 入口は #private を持つので、メソッドは本物の入口に結んで返す
      const value = Reflect.get(base, key, base);
      if (typeof value !== 'function') return value;
      if (key !== 'first') return value.bind(base);
      return async (...args: unknown[]) => {
        const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(base, args);
        if (!raced && (result as { author_user_id?: string } | undefined)?.author_user_id !== undefined) {
          raced = true;
          await race(base);
        }
        return result;
      };
    },
  });
  const context = {
    db: racing,
    actor,
    workspace,
    input: { workspace_id: target.workspace.id, ...input },
    defer: () => {},
  } as never;
  return operation.handler(context);
}
