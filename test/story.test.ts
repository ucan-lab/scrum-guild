// ストーリーの作成と変更の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { storyCreate, storyUpdate } from '../src/shared/operations/story/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb, verifyWorkspace } from '../src/server/db/index.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { storyUpdateOperation } from '../src/server/operations/story.ts';
import { createStory } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

type StoryBody = {
  story: {
    id: string;
    title: string;
    acceptance_criteria_md: string | null;
    body_md: string | null;
    due_on: string | null;
    link_url: string | null;
  };
};

function create(target: Target, body: Record<string, unknown>, person: Person = target.member) {
  return post(app, storyCreate, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, ...body },
  });
}

function update(target: Target, storyId: string, body: Record<string, unknown>, person: Person = target.member) {
  return post(app, storyUpdate, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, story_id: storyId, ...body },
  });
}

async function rowOf(target: Target, storyId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.first(
    db.statement((q) =>
      q.selectFrom('stories').selectAll().where('id', '=', storyId).where('workspace_id', '=', target.workspace.id),
    ),
  );
}

async function logsOf(target: Target, storyId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .selectAll()
        .where('entity_type', '=', 'story')
        .where('entity_id', '=', storyId)
        .where('organization_id', '=', target.organization.id)
        .orderBy('created_at'),
    ),
  );
}

describe('story-create', () => {
  test('親のないストーリーを、親のないストーリーの末尾に書き、変更の履歴を残す', async () => {
    const target = await createTarget();
    const first = await create(target, {
      title: '  ポイント制度を公開する  ',
      acceptance_criteria_md: '- 残高が見える\r\n- 失効日が見える',
      body_md: '  本文  ',
      due_on: '2026-10-30',
      link_url: ' https://example.com/spec ',
    });
    expect(first.status).toBe(200);
    const { story } = (await first.json()) as StoryBody;
    expect(story).toMatchObject({
      title: 'ポイント制度を公開する',
      acceptance_criteria_md: '- 残高が見える\n- 失効日が見える',
      body_md: '本文',
      due_on: '2026-10-30',
      link_url: 'https://example.com/spec',
    });

    const second = await create(target, { title: '二つ目' });
    const secondStory = ((await second.json()) as StoryBody).story;
    // 省いた欄は null
    expect(secondStory).toMatchObject({
      acceptance_criteria_md: null,
      body_md: null,
      due_on: null,
      link_url: null,
    });

    const one = (await rowOf(target, story.id))!;
    const two = (await rowOf(target, secondStory.id))!;
    expect(one).toMatchObject({
      workspace_id: target.workspace.id,
      epic_id: null,
      category_id: null,
      created_by: target.member.userId,
      completed_at: null,
      deleted_at: null,
      title: 'ポイント制度を公開する',
    });
    expect(two.position > one.position).toBe(true);

    const logs = await logsOf(target, story.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      workspace_id: target.workspace.id,
      actor_user_id: target.member.userId,
      action: 'create',
    });
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({
      title: [null, 'ポイント制度を公開する'],
      acceptance_criteria_md: [null, '- 残高が見える\n- 失効日が見える'],
      body_md: [null, '本文'],
      due_on: [null, '2026-10-30'],
      link_url: [null, 'https://example.com/spec'],
    });
  });

  test('空や空白だけの欄は null になる', async () => {
    const target = await createTarget();
    const res = await create(target, {
      title: 'x',
      acceptance_criteria_md: '  \n ',
      body_md: '',
      due_on: null,
      link_url: '   ',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as StoryBody).story).toMatchObject({
      acceptance_criteria_md: null,
      body_md: null,
      link_url: null,
    });
  });

  test.each([
    ['タイトルが空', { title: '   ' }],
    ['タイトルが201字', { title: 'あ'.repeat(201) }],
    ['タイトルに制御文字', { title: 'a\nb' }],
    ['受け入れ基準が1万字を超える', { title: 'x', acceptance_criteria_md: 'あ'.repeat(10_001) }],
    ['本文が1万字を超える', { title: 'x', body_md: 'あ'.repeat(10_001) }],
    ['本文に改行とタブ以外の制御文字', { title: 'x', body_md: 'a\u0000b' }],
    ['本文が文字列でない', { title: 'x', body_md: 1 }],
    ['期日が暦に無い', { title: 'x', due_on: '2026-02-30' }],
    ['期日の書き方が違う', { title: 'x', due_on: '2026/10/30' }],
    ['リンクが ftp', { title: 'x', link_url: 'ftp://example.com/a' }],
    ['リンクが javascript', { title: 'x', link_url: 'javascript:alert(1)' }],
    ['リンクの // が欠けている', { title: 'x', link_url: 'http:/example.com' }],
    ['リンクにホストが無い', { title: 'x', link_url: 'https://' }],
    ['リンクに空白', { title: 'x', link_url: 'https://example.com/a b' }],
    ['リンクが2049字', { title: 'x', link_url: `https://example.com/${'a'.repeat(2030)}` }],
  ])('%s は 400', async (_name, body) => {
    const target = await createTarget();
    const res = await create(target, body);
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe('invalid_input');
  });

  test('1万字ちょうどの本文と、2048字ちょうどのリンクは通る', async () => {
    const target = await createTarget();
    const res = await create(target, {
      title: 'x',
      acceptance_criteria_md: 'あ'.repeat(10_000),
      body_md: '😀'.repeat(10_000),
      link_url: `https://example.com/${'a'.repeat(2048 - 'https://example.com/'.length)}`,
    });
    expect(res.status).toBe(200);
  });

  test('閉じたワークスペースでは 409 の workspace_closed で、何も書かない', async () => {
    const target = await createTarget({ closed: true });
    const res = await create(target, { title: 'x' }, target.admin);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
    const db = orgDb(env, target.organization.verified);
    expect(
      await db.rows(
        db.statement((q) => q.selectFrom('stories').select('id').where('workspace_id', '=', target.workspace.id)),
      ),
    ).toEqual([]);
  });
});

describe('story-update', () => {
  async function seeded(target: Target) {
    return createStory(target.organization, target.workspace.id, target.admin.userId!, {
      title: '元のタイトル',
      acceptance_criteria_md: '元の基準',
      body_md: '元の本文',
      due_on: '2026-10-30',
      link_url: 'https://example.com/old',
    });
  }

  test('送った欄のうち変わるものだけを書き、ほかの欄は残して、変えた欄だけ [前, 後] で履歴に残す', async () => {
    const target = await createTarget();
    const story = await seeded(target);
    const res = await update(target, story.id, { title: '  新しいタイトル  ', due_on: null, body_md: '元の本文' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as StoryBody;
    expect(body.story).toMatchObject({
      id: story.id,
      title: '新しいタイトル',
      acceptance_criteria_md: '元の基準',
      body_md: '元の本文',
      due_on: null,
      link_url: 'https://example.com/old',
    });

    const row = (await rowOf(target, story.id))!;
    expect(row).toMatchObject({ title: '新しいタイトル', due_on: null, acceptance_criteria_md: '元の基準' });
    expect(row.updated_at > story.updated_at).toBe(true);
    const logs = await logsOf(target, story.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'update', actor_user_id: target.member.userId });
    // 値が同じだった body_md は履歴に入らない
    expect(JSON.parse(logs[0]!.changes_json)).toEqual({
      title: ['元のタイトル', '新しいタイトル'],
      due_on: ['2026-10-30', null],
    });
  });

  test('欄を空にすると null になる', async () => {
    const target = await createTarget();
    const story = await seeded(target);
    const res = await update(target, story.id, { acceptance_criteria_md: '  ', link_url: '' });
    expect(res.status).toBe(200);
    expect((await rowOf(target, story.id))!).toMatchObject({
      acceptance_criteria_md: null,
      link_url: null,
      body_md: '元の本文',
    });
  });

  test('変わる欄が無ければ、何も書かず、履歴も残さない', async () => {
    const target = await createTarget();
    const story = await seeded(target);
    for (const body of [{}, { title: '元のタイトル', body_md: '元の本文' }]) {
      const res = await update(target, story.id, body);
      expect(res.status).toBe(200);
      expect(((await res.json()) as StoryBody).story.title).toBe('元のタイトル');
    }
    expect(await rowOf(target, story.id)).toEqual(story);
    expect(await logsOf(target, story.id)).toEqual([]);
  });

  test('別の人が別の欄を直した後に保存しても、その人の変更は残る。同じ欄は後の保存が勝つ', async () => {
    const target = await createTarget();
    const story = await seeded(target);
    // どちらも、同じ元の値から開いたダイアログ。変えた欄だけを送る
    expect((await update(target, story.id, { title: 'Aのタイトル' }, target.member)).status).toBe(200);
    expect((await update(target, story.id, { body_md: 'Bの本文' }, target.leader)).status).toBe(200);
    expect(await rowOf(target, story.id)).toMatchObject({ title: 'Aのタイトル', body_md: 'Bの本文' });

    // 同じ欄は後の保存が勝つ。前の値は履歴にある
    expect((await update(target, story.id, { title: 'Bのタイトル' }, target.leader)).status).toBe(200);
    expect((await rowOf(target, story.id))!.title).toBe('Bのタイトル');
    const titles = (await logsOf(target, story.id)).map((log) => JSON.parse(log.changes_json).title).filter(Boolean);
    expect(titles).toEqual([
      ['元のタイトル', 'Aのタイトル'],
      ['Aのタイトル', 'Bのタイトル'],
    ]);
  });

  test('同時に別の欄を直しても、両方が残る', async () => {
    const target = await createTarget();
    const story = await seeded(target);
    const results = await Promise.all([
      update(target, story.id, { title: 'Aのタイトル' }, target.member),
      update(target, story.id, { link_url: 'https://example.com/new' }, target.leader),
    ]);
    expect(results.map((res) => res.status)).toEqual([200, 200]);
    expect(await rowOf(target, story.id)).toMatchObject({
      title: 'Aのタイトル',
      link_url: 'https://example.com/new',
    });
    expect(await logsOf(target, story.id)).toHaveLength(2);
  });

  test('別の組織・別のワークスペース・削除済み・存在しないストーリーは 404 で、何も書かない', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const adminId = target.admin.userId!;
    const foreignStory = await createStory(foreign.organization, foreign.workspace.id, foreign.admin.userId!);
    const elsewhere = await createStory(target.organization, target.otherWorkspace.id, adminId);
    const deleted = await createStory(target.organization, target.workspace.id, adminId, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    for (const id of [foreignStory.id, elsewhere.id, deleted.id, '019a0000-0000-7000-8000-00000000ffff']) {
      const res = await update(target, id, { title: '書き換える' });
      expect(res.status, id).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    }
    expect((await rowOf(foreign, foreignStory.id))!.title).toBe(foreignStory.title);
    expect((await rowOf({ ...target, workspace: target.otherWorkspace }, elsewhere.id))!.title).toBe(elsewhere.title);
    expect((await rowOf(target, deleted.id))!.title).toBe(deleted.title);
  });

  test.each([
    ['タイトルが空', { title: ' ' }],
    ['期日が暦に無い', { due_on: '2026-13-01' }],
    ['リンクが ftp', { link_url: 'ftp://example.com' }],
    ['本文が1万字を超える', { body_md: 'あ'.repeat(10_001) }],
    ['タイトルが null', { title: null }],
  ])('%s は 400', async (_name, body) => {
    const target = await createTarget();
    const story = await seeded(target);
    const res = await update(target, story.id, body);
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe('invalid_input');
    expect(await rowOf(target, story.id)).toEqual(story);
  });

  test('閉じたワークスペースでは 409 の workspace_closed で、何も書かない', async () => {
    const target = await createTarget({ closed: true });
    const story = await seeded(target);
    const res = await update(target, story.id, { title: '書き換える' }, target.admin);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
    expect(await rowOf(target, story.id)).toEqual(story);
    expect(await logsOf(target, story.id)).toEqual([]);
  });

  test('読んでから書くまでにワークスペースが閉じたら、何も書かず 409 の workspace_closed', async () => {
    const target = await createTarget();
    const story = await seeded(target);
    const db = orgDb(env, target.organization.verified);
    const actor = {
      accountId: target.member.accountId,
      userId: target.member.userId,
      isAdmin: false,
      invitedOnly: false,
    };
    const workspace = await verifyWorkspace(db, actor, target.workspace.id);
    expect(workspace?.closed).toBe(false);
    await db.run(
      db.statement((q) =>
        q
          .updateTable('workspaces')
          .set({ closed_at: '2026-10-22T00:00:00.000Z' })
          .where('id', '=', target.workspace.id)
          .where('organization_id', '=', target.organization.id),
      ),
    );
    const context = {
      db,
      actor,
      workspace,
      input: { workspace_id: target.workspace.id, story_id: story.id, title: '書き換える' },
      defer: () => {},
    } as never;
    await expect(storyUpdateOperation.handler(context)).rejects.toMatchObject({
      status: 409,
      code: 'workspace_closed',
    });
    expect(await rowOf(target, story.id)).toEqual(story);
    expect(await logsOf(target, story.id)).toEqual([]);
  });
});
