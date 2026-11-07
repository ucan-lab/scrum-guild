// #738: 保存と添付は全部か何もしないか。公開 API と保存値から確かめる。
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { orgDb } from '../src/server/db/index.ts';
import { commentCreate, commentUpdate, taskFieldSet, taskUpdate } from '../src/shared/operations/task/index.ts';
import { app, attachmentRows, recordingBucket } from './attachment-helpers.ts';
import { download, expectDownloadHeaders, storedFile } from './attachment-download-helpers.ts';
import {
  createAttachment,
  createComment,
  createDetailField,
  createMembership,
  createTask,
  createTaskFieldValue,
  uuidv7,
} from './factories.ts';
import { post } from './operations/harness.ts';
import { createPerson, createTarget, type Person, type Target } from './operations/world.ts';

async function fixture() {
  const target = await createTarget();
  const task = await createTask(target.organization, target.workspace.id, target.member.userId!, { body_md: '保存前' });
  return { target, task };
}

function save(
  target: Target,
  taskId: string,
  ids: string[],
  body: Record<string, unknown> = { body_md: '保存後' },
  person: Person = target.member,
) {
  return post(app, taskUpdate, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, task_id: taskId, ...body, attachment_ids: ids },
  });
}

async function savedBody(target: Target, taskId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .select(['body_md', 'updated_at'])
        .where('workspace_id', '=', target.workspace.id)
        .where('id', '=', taskId),
    ),
  );
}

async function expectRejected(response: Response, status: number, ids?: string[], reason?: string) {
  expect(response.status).toBe(status);
  const error = (await response.json()) as {
    error: { code: string; details?: { attachment_ids?: string[]; reason?: string } };
  };
  expect(error.error.code).toBe(status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'invalid_input');
  if (ids !== undefined) expect(error.error.details?.attachment_ids).toEqual(ids);
  if (reason !== undefined) expect(error.error.details?.reason).toBe(reason);
}

describe('タスクの保存と一緒に添付を確定する', () => {
  test('画像と画像以外をまとめて付け、本文で参照しないファイルも残る', async () => {
    const { target, task } = await fixture();
    const image = await storedFile(target);
    const document = await storedFile(target, { contentType: 'application/octet-stream', fileName: '手順.pdf' });
    const response = await save(target, task.id, [image.row.id, document.row.id]);
    expect(response.status).toBe(200);
    expect((await savedBody(target, task.id))?.body_md).toBe('保存後');
    for (const file of [image, document]) {
      const row = (await attachmentRows(target)).find((item) => item.id === file.row.id)!;
      expect(row).toMatchObject({
        task_id: task.id,
        comment_id: null,
        story_id: null,
        epic_id: null,
        uploaded_by: target.member.userId,
        created_at: file.row.created_at,
      });
      expect(row.attached_at).not.toBeNull();
      expect(new Date(row.attached_at!).toISOString()).toBe(row.attached_at);
    }
  });

  test('本文が同じでも添付だけを追加できる', async () => {
    const { target, task } = await fixture();
    const { row } = await storedFile(target);
    expect((await save(target, task.id, [row.id], { body_md: '保存前' })).status).toBe(200);
    expect((await attachmentRows(target)).find((item) => item.id === row.id)?.task_id).toBe(task.id);
  });

  test('ほかの欄を送らず添付だけを追加できる', async () => {
    const { target, task } = await fixture();
    const { row } = await storedFile(target);
    expect((await save(target, task.id, [row.id], {})).status).toBe(200);
    expect((await savedBody(target, task.id))?.body_md).toBe('保存前');
    expect((await attachmentRows(target)).find((item) => item.id === row.id)?.task_id).toBe(task.id);
  });

  test('20件の保存が D1 の束縛上限内で成功する', async () => {
    const { target, task } = await fixture();
    const rows = await Promise.all(
      Array.from({ length: 20 }, () =>
        createAttachment(target.organization, target.workspace.id, target.member.userId!),
      ),
    );
    expect(
      (
        await save(
          target,
          task.id,
          rows.map((row) => row.id),
          {
            body_md: '20件を保存',
            title: '添付を確認する',
            points: 3,
            due_on: '2026-11-10',
            link_url: 'https://example.com/',
            repository_id: null,
            category_id: null,
          },
        )
      ).status,
    ).toBe(200);
    expect((await attachmentRows(target)).filter((row) => row.task_id === task.id)).toHaveLength(20);
  });

  test.each(['21件', '重複'] as const)('%s は本文も添付も変えず400', async (kind) => {
    const { target, task } = await fixture();
    const { row } = await storedFile(target);
    const ids = kind === '重複' ? [row.id, row.id] : [row.id, ...Array.from({ length: 20 }, () => uuidv7())];
    await expectRejected(await save(target, task.id, ids), 400);
    expect((await savedBody(target, task.id))?.body_md).toBe('保存前');
    expect((await attachmentRows(target)).find((item) => item.id === row.id)?.attached_at).toBeNull();
  });

  test.each(['存在しない', '別の組織', '別のワークスペース', 'ほかの人の未添付'] as const)(
    '%s の添付を含むと404で何も保存しない',
    async (kind) => {
      const { target, task } = await fixture();
      const valid = await storedFile(target);
      let invalidId: string;
      if (kind === '存在しない') invalidId = uuidv7();
      else if (kind === '別の組織') invalidId = (await storedFile(await createTarget())).row.id;
      else if (kind === '別のワークスペース')
        invalidId = (await storedFile(target, { workspaceId: target.otherWorkspace.id })).row.id;
      else invalidId = (await storedFile(target, { person: target.leader })).row.id;
      await expectRejected(await save(target, task.id, [valid.row.id, invalidId]), 404, [invalidId]);
      expect((await savedBody(target, task.id))?.body_md).toBe('保存前');
      expect((await attachmentRows(target)).find((row) => row.id === valid.row.id)?.attached_at).toBeNull();
    },
  );

  test.each(['同じタスク', '別のタスク'] as const)('すでに%sに付いた添付は409で再利用できない', async (kind) => {
    const { target, task } = await fixture();
    const attachedTask =
      kind === '同じタスク' ? task : await createTask(target.organization, target.workspace.id, target.member.userId!);
    const { row } = await storedFile(target, {
      row: { task_id: attachedTask.id, attached_at: '2026-11-03T00:00:00.000Z' },
    });
    await expectRejected(await save(target, task.id, [row.id]), 409, [row.id], 'attachment_attached');
    expect((await savedBody(target, task.id))?.body_md).toBe('保存前');
    expect((await attachmentRows(target)).find((item) => item.id === row.id)?.task_id).toBe(attachedTask.id);
  });

  test('409の添付と404の添付が混じれば404を先に返す', async () => {
    const { target, task } = await fixture();
    const { row } = await storedFile(target, { row: { task_id: task.id, attached_at: '2026-11-03T00:00:00.000Z' } });
    const missing = uuidv7();
    await expectRejected(await save(target, task.id, [row.id, missing]), 404, [missing]);
    expect((await savedBody(target, task.id))?.body_md).toBe('保存前');
  });

  test('付く先のないタスクへは添付を付けず404', async () => {
    const { target } = await fixture();
    const { row } = await storedFile(target);
    const response = await save(target, uuidv7(), [row.id]);
    expect(response.status).toBe(404);
    expect((await attachmentRows(target)).find((item) => item.id === row.id)?.attached_at).toBeNull();
  });
});

describe('保存した画像はワークスペースのメンバーにだけ返す', () => {
  test('本人・別のメンバー・リーダー・管理者に画像を返す', async () => {
    const { target, task } = await fixture();
    const otherMember = await createPerson({
      organization: target.organization,
      membership: { workspaceId: target.workspace.id, role: 'member' },
    });
    const { row, bytes } = await storedFile(target, {
      row: { task_id: task.id, attached_at: '2026-11-03T00:00:00.000Z' },
    });
    for (const person of [target.member, otherMember, target.leader, target.admin]) {
      const response = await download(target, row.id, { person });
      expect(response.status).toBe(200);
      expectDownloadHeaders(response);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    }
  });

  test('未所属と別の組織からは404、R2も読まない', async () => {
    const { target, task } = await fixture();
    const other = await createTarget();
    const { row } = await storedFile(target, { row: { task_id: task.id, attached_at: '2026-11-03T00:00:00.000Z' } });
    for (const person of [target.bystander, other.member]) {
      const { env: bindings, calls } = recordingBucket();
      const response = await download(target, row.id, { person, env: bindings });
      expect(response.status).toBe(404);
      expect(calls).toEqual([]);
    }
  });

  test('所属を抜けたアップロード本人も保存済み画像を見られない', async () => {
    const { target, task } = await fixture();
    const previous = await createPerson({ organization: target.organization });
    await createMembership(target.organization, target.workspace.id, previous.userId!, {
      left_at: '2026-11-03T00:00:00.000Z',
      left_on: '2026-11-03',
    });
    const { row } = await storedFile(target, {
      person: previous,
      row: { task_id: task.id, attached_at: '2026-11-03T00:00:00.000Z' },
    });
    expect((await download(target, row.id, { person: previous })).status).toBe(404);
  });

  test('未保存の画像はメンバー・リーダー・管理者にも公開しない', async () => {
    const { target } = await fixture();
    const { row } = await storedFile(target);
    for (const person of [target.leader, target.admin])
      expect((await download(target, row.id, { person })).status).toBe(404);
    const response = await download(target, row.id);
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  });
});

describe('コメントと決まった欄の保存も添付と同時に確定する', () => {
  test('新しいコメントへ付けるとcomment_idだけが埋まり、同僚も画像を読める', async () => {
    const { target, task } = await fixture();
    const { row, bytes } = await storedFile(target);
    const response = await post(app, commentCreate, {
      slug: target.slug,
      token: target.member.token,
      body: {
        workspace_id: target.workspace.id,
        task_id: task.id,
        body_md: '図を確認してください',
        attachment_ids: [row.id],
      },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { comment: { id: string } };
    expect((await attachmentRows(target)).find((item) => item.id === row.id)).toMatchObject({
      comment_id: body.comment.id,
      task_id: null,
    });
    const image = await download(target, row.id, { person: target.leader });
    expect(image.status).toBe(200);
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(bytes);
  });

  test('無い添付を含むコメント作成はコメント自体も残さない', async () => {
    const { target, task } = await fixture();
    const { row } = await storedFile(target);
    const missing = uuidv7();
    const response = await post(app, commentCreate, {
      slug: target.slug,
      token: target.member.token,
      body: {
        workspace_id: target.workspace.id,
        task_id: task.id,
        body_md: '残らないコメント',
        attachment_ids: [row.id, missing],
      },
    });
    await expectRejected(response, 404, [missing]);
    const db = orgDb(env, target.organization.verified);
    expect(
      await db.rows(
        db.statement((q) =>
          q
            .selectFrom('comments')
            .select('id')
            .where('workspace_id', '=', target.workspace.id)
            .where('task_id', '=', task.id),
        ),
      ),
    ).toEqual([]);
    expect((await attachmentRows(target)).find((item) => item.id === row.id)?.attached_at).toBeNull();
  });

  test('コメント本文が同じでも添付を付けられる', async () => {
    const { target, task } = await fixture();
    const comment = await createComment(target.organization, target.workspace.id, task.id, target.member.userId!);
    const { row } = await storedFile(target);
    const response = await post(app, commentUpdate, {
      slug: target.slug,
      token: target.member.token,
      body: {
        workspace_id: target.workspace.id,
        comment_id: comment.id,
        body_md: comment.body_md,
        attachment_ids: [row.id],
      },
    });
    expect(response.status).toBe(200);
    expect((await attachmentRows(target)).find((item) => item.id === row.id)).toMatchObject({
      comment_id: comment.id,
      task_id: null,
    });
  });

  test('コメント変更に無い添付を含めると本文も保存しない', async () => {
    const { target, task } = await fixture();
    const comment = await createComment(target.organization, target.workspace.id, task.id, target.member.userId!);
    const missing = uuidv7();
    const response = await post(app, commentUpdate, {
      slug: target.slug,
      token: target.member.token,
      body: {
        workspace_id: target.workspace.id,
        comment_id: comment.id,
        body_md: '保存しない',
        attachment_ids: [missing],
      },
    });
    await expectRejected(response, 404, [missing]);
    const db = orgDb(env, target.organization.verified);
    expect(
      await db.first(
        db.statement((q) =>
          q
            .selectFrom('comments')
            .select('body_md')
            .where('workspace_id', '=', target.workspace.id)
            .where('id', '=', comment.id),
        ),
      ),
    ).toEqual({ body_md: comment.body_md });
  });

  test.each([false, true])('決まった欄の保存（同じ値=%s）でtask_idへ付けられる', async (unchanged) => {
    const { target, task } = await fixture();
    const field = await createDetailField(target.organization, target.workspace.id);
    if (unchanged)
      await createTaskFieldValue(target.organization, task.id, field.id, target.member.userId!, { value_md: '条件' });
    const { row } = await storedFile(target);
    const response = await post(app, taskFieldSet, {
      slug: target.slug,
      token: target.member.token,
      body: {
        workspace_id: target.workspace.id,
        task_id: task.id,
        field_id: field.id,
        read_md: unchanged ? '条件' : null,
        value_md: '条件',
        attachment_ids: [row.id],
      },
    });
    expect(response.status).toBe(200);
    expect((await attachmentRows(target)).find((item) => item.id === row.id)).toMatchObject({
      task_id: task.id,
      comment_id: null,
    });
  });

  test('決まった欄の変更に無い添付を含めると欄も保存しない', async () => {
    const { target, task } = await fixture();
    const field = await createDetailField(target.organization, target.workspace.id);
    const missing = uuidv7();
    const response = await post(app, taskFieldSet, {
      slug: target.slug,
      token: target.member.token,
      body: {
        workspace_id: target.workspace.id,
        task_id: task.id,
        field_id: field.id,
        read_md: null,
        value_md: '保存しない',
        attachment_ids: [missing],
      },
    });
    await expectRejected(response, 404, [missing]);
    const db = orgDb(env, target.organization.verified);
    expect(
      await db.first(
        db.statement((q) =>
          q
            .selectFrom('task_field_values')
            .select('value_md')
            .where('task_id', '=', task.id)
            .where('field_id', '=', field.id),
        ),
      ),
    ).toBeUndefined();
  });
});

describe('添付つきの保存は、直前の履歴にまとめない（履歴の共通処理 change-log-merge.ts）', () => {
  test('同じ欄を続けて直しても、添付を付けた保存は新しい行になり、attachments を残す', async () => {
    const { target, task } = await fixture();
    expect((await save(target, task.id, [], { body_md: '一回目' })).status).toBe(200);
    const { row } = await storedFile(target);
    expect((await save(target, task.id, [row.id], { body_md: '二回目' })).status).toBe(200);
    const db = orgDb(env, target.organization.verified);
    const logs = await db.rows(
      db.statement((q) =>
        q
          .selectFrom('change_logs')
          .select('changes_json')
          .where('entity_type', '=', 'task')
          .where('entity_id', '=', task.id)
          .where('organization_id', '=', target.organization.id)
          .orderBy('created_at')
          .orderBy('id'),
      ),
    );
    // 2回の保存が同じミリ秒に入ると並びが入れ替わりうるので、並びに頼らず内容で確かめる
    expect(logs.map((log) => JSON.parse(log.changes_json))).toHaveLength(2);
    expect(logs.map((log) => JSON.parse(log.changes_json))).toEqual(
      expect.arrayContaining([
        { body_md: ['保存前', '一回目'] },
        { body_md: ['一回目', '二回目'], attachments: [null, [{ id: row.id }]] },
      ]),
    );
  });
});
