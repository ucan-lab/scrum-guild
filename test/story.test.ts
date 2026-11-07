// ストーリーの作成と変更の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { setFixedNow } from '../src/shared/clock.ts';
import { storyCreate, storyGet, storyUpdate } from '../src/shared/operations/story/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb, verifyWorkspace } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { storyUpdateOperation } from '../src/server/operations/story.ts';
import { createCategory, createEpic, createStory, createTask } from './factories.ts';
import { errorCodeOf, post } from './operations/harness.ts';
import { createTarget, testEnv, type Person, type Target } from './operations/world.ts';

const app = createApp(implementedOperations);

type StoryBody = {
  story: {
    id: string;
    title: string;
    acceptance_criteria_md: string | null;
    body_md: string | null;
    due_on: string | null;
    link_url: string | null;
    epic_id: string | null;
  };
};

function create(target: Target, body: Record<string, unknown>, person: Person = target.member) {
  return post(app, storyCreate, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, ...body },
  });
}

function update(
  target: Target,
  storyId: string,
  body: Record<string, unknown>,
  person: Person = target.member,
  requestEnv?: Env,
) {
  return post(app, storyUpdate, {
    slug: target.slug,
    token: person.token,
    body: { workspace_id: target.workspace.id, story_id: storyId, ...body },
    ...(requestEnv === undefined ? {} : { env: requestEnv }),
  });
}

// 開発用の時計（DEV_NOW）を置いた環境（ループバックの公開 URL のときだけ使える。src/server/dev-clock.ts）
const FROZEN_ISO = '2026-10-26T01:00:00.000Z';
function frozenEnv(devNow: string): Env {
  return Object.assign({}, testEnv, { PUBLIC_ORIGIN: 'http://localhost:8787', DEV_NOW: devNow });
}

function actorOf(person: Person) {
  return { accountId: person.accountId, userId: person.userId, isAdmin: false, invitedOnly: false };
}

async function rowOf(target: Target, storyId: string) {
  const db = orgDb(env, target.organization.verified);
  return db.first(
    db.statement((q) =>
      q.selectFrom('stories').selectAll().where('id', '=', storyId).where('workspace_id', '=', target.workspace.id),
    ),
  );
}

async function storyCount(target: Target): Promise<number> {
  const db = orgDb(env, target.organization.verified);
  const rows = await db.rows(
    db.statement((q) => q.selectFrom('stories').select('id').where('workspace_id', '=', target.workspace.id)),
  );
  return rows.length;
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
      body_md: '\n\n  本文  \n',
      due_on: '2026-10-30',
      link_url: ' HTTPS://Example.com/spec ',
    });
    expect(first.status).toBe(200);
    const { story } = (await first.json()) as StoryBody;
    expect(story).toMatchObject({
      title: 'ポイント制度を公開する',
      acceptance_criteria_md: '- 残高が見える\n- 失効日が見える',
      // 先頭の字下げは残し、前後の空行と末尾の空白を落とす。リンクは URL を解釈した形にそろえる
      body_md: '  本文',
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
      body_md: [null, '  本文'],
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
    ['リンクにユーザー名とパスワード', { title: 'x', link_url: 'https://user:pass@example.com/' }],
    ['リンクにユーザー名', { title: 'x', link_url: 'https://user@example.com/' }],
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

  test('親のエピックを指すと、そのエピックの配下の末尾に置き、親のないストーリーの並びには混ぜない', async () => {
    const target = await createTarget();
    const adminId = target.admin.userId!;
    const epic = await createEpic(target.organization, target.workspace.id, adminId);
    const other = await createEpic(target.organization, target.workspace.id, adminId, { position: 'a1' });
    const rootBefore = await create(target, { title: '親なし' });
    const rootId = ((await rootBefore.json()) as StoryBody).story.id;

    const first = await create(target, { title: '一つ目', epic_id: epic.id });
    expect(first.status).toBe(200);
    const firstStory = ((await first.json()) as StoryBody).story;
    expect(firstStory.epic_id).toBe(epic.id);
    const second = ((await (await create(target, { title: '二つ目', epic_id: epic.id })).json()) as StoryBody).story;
    const inOther = ((await (await create(target, { title: '別のエピック', epic_id: other.id })).json()) as StoryBody)
      .story;

    const a = (await rowOf(target, firstStory.id))!;
    const b = (await rowOf(target, second.id))!;
    const c = (await rowOf(target, inOther.id))!;
    expect(a.epic_id).toBe(epic.id);
    expect(b.epic_id).toBe(epic.id);
    expect(b.position > a.position).toBe(true);
    expect(c.epic_id).toBe(other.id);
    // 親のないストーリーの末尾は、エピックの下に作っても動かない
    const root = (await rowOf(target, rootId))!;
    const next = ((await (await create(target, { title: '親なし二つ目' })).json()) as StoryBody).story;
    expect((await rowOf(target, next.id))!.position > root.position).toBe(true);
    expect(JSON.parse((await logsOf(target, firstStory.id))[0]!.changes_json)).toEqual({
      title: [null, '一つ目'],
      epic: [null, { id: epic.id, title: epic.title }],
    });
  });

  test('エピックの下に作ると、エピックの区分を引き継いで返す', async () => {
    const target = await createTarget();
    const adminId = target.admin.userId!;
    const category = await createCategory(target.organization, target.workspace.id);
    const epic = await createEpic(target.organization, target.workspace.id, adminId, { category_id: category.id });
    const res = await create(target, { title: '引き継ぐ', epic_id: epic.id });
    expect(res.status).toBe(200);
    const { story } = (await res.json()) as StoryBody & {
      story: { category: { id: string; inherited: boolean } | null };
    };
    expect(story.category).toMatchObject({ id: category.id, inherited: true });
    expect((await rowOf(target, story.id))!.category_id).toBeNull();
  });

  test('エピックと区分を一緒に送ると 409 の conflict（has_parent）で、何も書かない', async () => {
    const target = await createTarget();
    const category = await createCategory(target.organization, target.workspace.id);
    const epic = await createEpic(target.organization, target.workspace.id, target.admin.userId!);
    const res = await create(target, { title: 'x', epic_id: epic.id, category_id: category.id });
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('conflict');
    expect(await storyCount(target)).toBe(0);
  });

  test.each([
    ['完了した', { completed_at: '2026-10-21T00:00:00.000Z' }],
    ['中止した', { canceled_at: '2026-10-21T00:00:00.000Z' }],
  ])('%sエピックの下には 409 の conflict（parent_completed）で作らない', async (_name, overrides) => {
    const target = await createTarget();
    const epic = await createEpic(target.organization, target.workspace.id, target.admin.userId!, overrides);
    const res = await create(target, { title: 'x', epic_id: epic.id });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe('conflict');
    expect(body.error.details?.reason).toBe('parent_completed');
    expect(await storyCount(target)).toBe(0);
  });

  test.each([
    ['クリア', { completed_at: '2026-10-21T00:00:00.000Z' }, 409],
    ['中止', { canceled_at: '2026-10-21T00:00:00.000Z' }, 409],
    ['削除', { deleted_at: '2026-10-21T00:00:00.000Z' }, 404],
  ])(
    '読んでから書くまでに親のエピックが%sされたら、何も書かず、読み直して %d を返す',
    async (_name, change, status) => {
      const target = await createTarget();
      const epic = await createEpic(target.organization, target.workspace.id, target.admin.userId!);
      let done = false;
      const requestEnv = envWithD1Hooks(testEnv, {
        afterQuery: async (sql) => {
          // 親のエピックを読んだ直後に、別の要求がクリアか削除を通す
          if (done || !sql.startsWith('select "epics"."id", "epics"."title"')) return;
          done = true;
          const db = orgDb(env, target.organization.verified);
          await db.batch([db.statement((q) => q.updateTable('epics').set(change).where('id', '=', epic.id))]);
        },
      });
      const res = await post(app, storyCreate, {
        slug: target.slug,
        token: target.member.token,
        body: { workspace_id: target.workspace.id, title: 'x', epic_id: epic.id },
        env: requestEnv,
      });
      expect(done).toBe(true);
      expect(res.status).toBe(status);
      expect(await storyCount(target)).toBe(0);
    },
  );

  test('閉じたワークスペースでは、完了したエピックを指しても 409 の workspace_closed で断る', async () => {
    const target = await createTarget({ closed: true });
    const epic = await createEpic(target.organization, target.workspace.id, target.admin.userId!, {
      completed_at: '2026-10-21T00:00:00.000Z',
    });
    const res = await create(target, { title: 'x', epic_id: epic.id }, target.admin);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe('workspace_closed');
  });

  test('別の組織・別のワークスペース・削除済み・存在しないエピックは 404 で、何も書かない', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const foreignEpic = await createEpic(foreign.organization, foreign.workspace.id, foreign.admin.userId!);
    const elsewhere = await createEpic(target.organization, target.otherWorkspace.id, target.admin.userId!);
    const deleted = await createEpic(target.organization, target.workspace.id, target.admin.userId!, {
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    for (const id of [foreignEpic.id, elsewhere.id, deleted.id, '019a0000-0000-7000-8000-00000000ffff']) {
      const res = await create(target, { title: 'x', epic_id: id });
      expect(res.status, id).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    }
    expect(await storyCount(target)).toBe(0);
    expect(await storyCount(foreign)).toBe(0);
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

  test('変わる欄が無い要求も、読んでから閉じたワークスペースなら 409 の workspace_closed', async () => {
    const target = await createTarget();
    const story = await seeded(target);
    const db = orgDb(env, target.organization.verified);
    const actor = actorOf(target.member);
    const workspace = await verifyWorkspace(db, actor, target.workspace.id);
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
      input: { workspace_id: target.workspace.id, story_id: story.id, title: story.title },
      defer: () => {},
    } as never;
    await expect(storyUpdateOperation.handler(context)).rejects.toMatchObject({
      status: 409,
      code: 'workspace_closed',
    });
  });

  describe('書き始める前の値（expected）', () => {
    test('書く欄の値がサーバーの今の値と違えば、何も書かず 409 の conflict で今の値を返す', async () => {
      const target = await createTarget();
      const story = await seeded(target);
      expect((await update(target, story.id, { acceptance_criteria_md: '先に直した基準' }, target.leader)).status).toBe(
        200,
      );
      const res = await update(
        target,
        story.id,
        {
          title: '新しいタイトル',
          acceptance_criteria_md: '自分の基準',
          expected: { title: '元のタイトル', acceptance_criteria_md: '元の基準' },
        },
        target.member,
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string; details: unknown } };
      expect(body.error.code).toBe('conflict');
      expect(body.error.details).toEqual({ reason: 'stale', current: { acceptance_criteria_md: '先に直した基準' } });
      expect(await rowOf(target, story.id)).toMatchObject({
        title: '元のタイトル',
        acceptance_criteria_md: '先に直した基準',
      });
      expect(await logsOf(target, story.id)).toHaveLength(1);
    });

    test('書かない欄の前の値が違っても、断らない', async () => {
      const target = await createTarget();
      const story = await seeded(target);
      expect((await update(target, story.id, { due_on: '2026-12-01' }, target.leader)).status).toBe(200);
      const res = await update(target, story.id, {
        title: '新しいタイトル',
        expected: { title: '元のタイトル', due_on: '2026-10-30' },
      });
      expect(res.status).toBe(200);
      expect(await rowOf(target, story.id)).toMatchObject({ title: '新しいタイトル', due_on: '2026-12-01' });
    });

    test('添えない保存は、今のまま後の保存が勝つ', async () => {
      const target = await createTarget();
      const story = await seeded(target);
      expect((await update(target, story.id, { title: '先に直した' }, target.leader)).status).toBe(200);
      expect((await update(target, story.id, { title: '後の保存' })).status).toBe(200);
      expect((await rowOf(target, story.id))!.title).toBe('後の保存');
    });

    test('正規化の前に保存された値でも、同じ値を添えれば断らない', async () => {
      const target = await createTarget();
      const story = await createStory(target.organization, target.workspace.id, target.admin.userId!, {
        title: '  元のタイトル  ',
        body_md: 'a\r\nb  ',
        link_url: 'https://Example.com/Old',
      });
      const res = await update(target, story.id, {
        title: '新しいタイトル',
        body_md: 'a\nb\nc',
        link_url: 'https://example.org/',
        expected: { title: '元のタイトル', body_md: 'a\nb', link_url: 'https://example.com/Old' },
      });
      expect(res.status).toBe(200);
    });

    test('欄が空だったと思って送っても、先に誰かが書いていれば 409 の stale', async () => {
      const target = await createTarget();
      const story = await seeded(target);
      const res = await update(target, story.id, { link_url: 'https://example.org/', expected: { link_url: '' } });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { details: unknown } };
      expect(body.error.details).toEqual({ reason: 'stale', current: { link_url: 'https://example.com/old' } });
    });

    test('閉じたワークスペースでは、前の値が古くても stale より先に workspace_closed で断る', async () => {
      const target = await createTarget({ closed: true });
      const story = await seeded(target);
      const res = await update(
        target,
        story.id,
        { title: '新しいタイトル', expected: { title: '別の値' } },
        target.admin,
      );
      expect(res.status).toBe(409);
      expect(await errorCodeOf(res)).toBe('workspace_closed');
    });

    test('別の組織のストーリーは、前の値を添えても 404', async () => {
      const target = await createTarget();
      const foreign = await createTarget();
      const foreignStory = await seeded(foreign);
      const res = await update(target, foreignStory.id, { title: '書き換える', expected: { title: '元のタイトル' } });
      expect(res.status).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    });
  });

  describe('続けて直した分の履歴のまとめ', () => {
    const at = (minutes: number) => frozenEnv(new Date(Date.parse(FROZEN_ISO) + minutes * 60_000).toISOString());

    test('同じ人が数分以内に同じ欄を続けて直すと、行は1つのままで「前」は最初の値、「後」は最後の値になる', async () => {
      const target = await createTarget();
      const story = await seeded(target);
      expect((await update(target, story.id, { body_md: '一回目' }, target.member, at(0))).status).toBe(200);
      expect((await update(target, story.id, { body_md: '二回目' }, target.member, at(2))).status).toBe(200);
      expect((await update(target, story.id, { body_md: '三回目' }, target.member, at(5))).status).toBe(200);
      const logs = await logsOf(target, story.id);
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0]!.changes_json)).toEqual({ body_md: ['元の本文', '三回目'] });
      expect(logs[0]!.created_at).toBe(new Date(Date.parse(FROZEN_ISO) + 5 * 60_000).toISOString());
    });

    test.each([
      ['別の人', { body_md: '別の人が直した' }, 'leader', 1],
      ['間が空いた', { body_md: '間が空いた' }, 'member', 6],
      ['別の欄', { title: '別の欄' }, 'member', 1],
      ['2つの欄', { body_md: '2つ', title: '2つの欄' }, 'member', 1],
    ] as const)('%s なら、新しい行を足す', async (_name, body, who, minutes) => {
      const target = await createTarget();
      const story = await seeded(target);
      expect((await update(target, story.id, { body_md: '一回目' }, target.member, at(0))).status).toBe(200);
      expect((await update(target, story.id, body, target[who], at(minutes))).status).toBe(200);
      const logs = await logsOf(target, story.id);
      expect(logs).toHaveLength(2);
      expect(JSON.parse(logs[0]!.changes_json)).toEqual({ body_md: ['元の本文', '一回目'] });
    });

    test('間は最初に書いた時刻から数える。まとめるたびに延びない', async () => {
      const target = await createTarget();
      const story = await seeded(target);
      for (const [minutes, value] of [
        [0, '一回目'],
        [4, '二回目'],
        [6, '三回目'],
      ] as const) {
        expect((await update(target, story.id, { body_md: value }, target.member, at(minutes))).status).toBe(200);
      }
      const logs = (await logsOf(target, story.id)).map((log) => JSON.parse(log.changes_json));
      expect(logs).toEqual([{ body_md: ['元の本文', '二回目'] }, { body_md: ['二回目', '三回目'] }]);
    });

    test('間に別の人の履歴が挟まっていれば、まとめない', async () => {
      const target = await createTarget();
      const story = await seeded(target);
      expect((await update(target, story.id, { body_md: '一回目' }, target.member, at(0))).status).toBe(200);
      expect((await update(target, story.id, { title: '別の人の題' }, target.leader, at(1))).status).toBe(200);
      expect((await update(target, story.id, { body_md: '二回目' }, target.member, at(2))).status).toBe(200);
      expect(await logsOf(target, story.id)).toHaveLength(3);
    });

    test('元の値へ戻す変更は、まとめずに新しい行にする', async () => {
      const target = await createTarget();
      const story = await seeded(target);
      expect((await update(target, story.id, { body_md: '一回目' }, target.member, at(0))).status).toBe(200);
      expect((await update(target, story.id, { body_md: '元の本文' }, target.member, at(1))).status).toBe(200);
      const logs = (await logsOf(target, story.id)).map((log) => JSON.parse(log.changes_json));
      expect(logs).toEqual([{ body_md: ['元の本文', '一回目'] }, { body_md: ['一回目', '元の本文'] }]);
    });

    test('時計が最初に書いた時刻より戻っていても、まとめない', async () => {
      const target = await createTarget();
      const story = await seeded(target);
      expect((await update(target, story.id, { body_md: '一回目' }, target.member, at(10))).status).toBe(200);
      expect((await update(target, story.id, { body_md: '二回目' }, target.member, at(0))).status).toBe(200);
      expect(await logsOf(target, story.id)).toHaveLength(2);
    });
  });

  describe('同じ欄を同時に変える要求', () => {
    // 処理を直に呼ぶ。ストーリーを読む文が答えを返した直後に、race を呼ぶ（n は何回目の読み取りか）。
    // 「同じ値を読んだ2つの要求が、順に書く」状況を、読み取りの後に別の更新を挟んで作る
    async function updateWithRace(
      target: Target,
      person: Person,
      input: Record<string, unknown>,
      race: (n: number, db: ReturnType<typeof orgDb>) => Promise<void>,
    ) {
      const db = orgDb(env, target.organization.verified);
      const actor = actorOf(person);
      const workspace = await verifyWorkspace(db, actor, target.workspace.id);
      let reads = 0;
      const racing = new Proxy(db, {
        get(base, key) {
          // 入口は #private を持つので、メソッドは本物の入口に結んで返す
          const value = Reflect.get(base, key, base);
          if (typeof value !== 'function') return value;
          if (key !== 'first') return value.bind(base);
          return async (...args: unknown[]) => {
            const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(base, args);
            // ストーリーの行を返した読み取りだけを数える（閉じたかどうかの読み取りは数えない）
            if ((result as { title?: string } | undefined)?.title !== undefined) await race(++reads, base);
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
      return storyUpdateOperation.handler(context) as Promise<StoryBody>;
    }

    test('先に別の要求が同じ欄を変えたら、読み直してやり直し、履歴が [元, A]、[A, B] と連なる', async () => {
      const target = await createTarget();
      const story = await createStory(target.organization, target.workspace.id, target.admin.userId!, {
        title: '元のタイトル',
      });
      // 要求 B は「元のタイトル」を読んだ。書く前に、要求 A が先に A へ変える
      const result = await updateWithRace(target, target.member, { story_id: story.id, title: 'B' }, async (n) => {
        if (n === 1) expect((await update(target, story.id, { title: 'A' }, target.leader)).status).toBe(200);
      });
      expect(result.story.title).toBe('B');
      expect((await rowOf(target, story.id))!.title).toBe('B');

      const logs = await logsOf(target, story.id);
      const pairs = logs.map((log) => ({
        actor: log.actor_user_id,
        title: JSON.parse(log.changes_json).title as [string, string],
      }));
      expect(pairs).toHaveLength(2);
      expect(pairs).toContainEqual({ actor: target.leader.userId, title: ['元のタイトル', 'A'] });
      // B の履歴の「前」は、読み直した A。元のタイトルを前にしない
      expect(pairs).toContainEqual({ actor: target.member.userId, title: ['A', 'B'] });
    });

    test('先に別の要求が同じ値へ変えていたら、書くものが無くなり、履歴は1件のまま', async () => {
      const target = await createTarget();
      const story = await createStory(target.organization, target.workspace.id, target.admin.userId!, {
        title: '元のタイトル',
      });
      const result = await updateWithRace(target, target.member, { story_id: story.id, title: 'X' }, async (n) => {
        if (n === 1) expect((await update(target, story.id, { title: 'X' }, target.leader)).status).toBe(200);
      });
      expect(result.story.title).toBe('X');
      const logs = await logsOf(target, story.id);
      expect(logs).toHaveLength(1);
      expect(logs[0]!.actor_user_id).toBe(target.leader.userId);
      expect(JSON.parse(logs[0]!.changes_json)).toEqual({ title: ['元のタイトル', 'X'] });
    });

    test('同じ値を続けて2回送っても、履歴は1件', async () => {
      const target = await createTarget();
      const story = await seeded(target);
      expect((await update(target, story.id, { title: '同じ値' })).status).toBe(200);
      expect((await update(target, story.id, { title: '同じ値' }, target.leader)).status).toBe(200);
      expect(await logsOf(target, story.id)).toHaveLength(1);
    });

    test('別の欄を先に変えた要求とは、やり直しにならず、両方の変更と履歴が残る', async () => {
      const target = await createTarget();
      const story = await seeded(target);
      let updates = 0;
      const result = await updateWithRace(
        target,
        target.member,
        { story_id: story.id, title: 'Bのタイトル' },
        async (n) => {
          if (n === 1) {
            const res = await update(target, story.id, { link_url: 'https://example.com/a' }, target.leader);
            expect(res.status).toBe(200);
            updates++;
          }
        },
      );
      expect(updates).toBe(1);
      expect(result.story).toMatchObject({ title: 'Bのタイトル', link_url: 'https://example.com/a' });
      expect(await logsOf(target, story.id)).toHaveLength(2);
    });

    test('止めた時計で、同じ値を書く2つの更新が競っても、履歴は1行だけ', async () => {
      setFixedNow(new Date(FROZEN_ISO));
      try {
        const target = await createTarget();
        const story = await createStory(target.organization, target.workspace.id, target.admin.userId!, {
          title: '元のタイトル',
        });
        // 要求 B は「元のタイトル」を読んだ。書く前に、要求 A が同じ時刻に同じ値へ変える。B の更新は通らず、読み直すと変える欄が無い
        await updateWithRace(target, target.member, { story_id: story.id, title: '新' }, async (n) => {
          if (n === 1)
            expect((await update(target, story.id, { title: '新' }, target.leader, frozenEnv(FROZEN_ISO))).status).toBe(
              200,
            );
        });
        const logs = await logsOf(target, story.id);
        expect(logs).toHaveLength(1);
        expect(JSON.parse(logs[0]!.changes_json)).toEqual({ title: ['元のタイトル', '新'] });
      } finally {
        setFixedNow(undefined);
      }
    });

    test('負け続けて3回やり直しても書けなければ、409 の conflict で、履歴は書かない', async () => {
      const target = await createTarget();
      const story = await seeded(target);
      let rounds = 0;
      await expect(
        updateWithRace(target, target.member, { story_id: story.id, title: 'Z' }, async (n, base) => {
          rounds = n;
          await base.run(
            base.statement((q) =>
              q
                .updateTable('stories')
                .set({ title: `割り込み ${n}` })
                .where('id', '=', story.id)
                .where('workspace_id', '=', target.workspace.id),
            ),
          );
        }),
      ).rejects.toMatchObject({ status: 409, code: 'conflict' });
      expect(rounds).toBeGreaterThanOrEqual(3);
      expect(await logsOf(target, story.id)).toEqual([]);
      expect((await rowOf(target, story.id))!.title).toMatch(/^割り込み /);
    });
  });
});

describe('story-get', () => {
  function get(target: Target, storyId: string, person: Person = target.member) {
    return post(app, storyGet, {
      slug: target.slug,
      token: person.token,
      body: { workspace_id: target.workspace.id, story_id: storyId },
    });
  }

  test('ダイアログに出す欄を全部返す', async () => {
    const target = await createTarget();
    const story = await createStory(target.organization, target.workspace.id, target.admin.userId!, {
      title: '読む',
      acceptance_criteria_md: '- 基準',
      body_md: '本文',
      due_on: '2026-10-30',
      link_url: 'https://example.com/a',
    });
    const res = await get(target, story.id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as StoryBody).story).toEqual({
      id: story.id,
      title: '読む',
      acceptance_criteria_md: '- 基準',
      body_md: '本文',
      due_on: '2026-10-30',
      link_url: 'https://example.com/a',
      epic_id: null,
      category: null,
    });
  });

  test('完了の状態を返す。未完了の件数は、完了と削除したタスクを数えない', async () => {
    const target = await createTarget();
    const adminId = target.admin.userId!;
    const epic = await createEpic(target.organization, target.workspace.id, adminId);
    const story = await createStory(target.organization, target.workspace.id, adminId, { epic_id: epic.id });
    const under = { story_id: story.id };
    await createTask(target.organization, target.workspace.id, adminId, under);
    await createTask(target.organization, target.workspace.id, adminId, under);
    await createTask(target.organization, target.workspace.id, adminId, {
      ...under,
      completed_at: '2026-10-21T00:00:00.000Z',
    });
    await createTask(target.organization, target.workspace.id, adminId, {
      ...under,
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    const body = (await (await get(target, story.id)).json()) as {
      completed_at: string | null;
      open_task_count: number;
      parent_finished: boolean;
    };
    expect(body).toMatchObject({ completed_at: null, open_task_count: 2, parent_finished: false });
  });

  test('完了したストーリーは完了した日時を、親のエピックが完了か中止していれば parent_finished を返す', async () => {
    const target = await createTarget();
    const adminId = target.admin.userId!;
    const cleared = await createEpic(target.organization, target.workspace.id, adminId, {
      completed_at: '2026-10-20T00:00:00.000Z',
    });
    const canceled = await createEpic(target.organization, target.workspace.id, adminId, {
      canceled_at: '2026-10-20T00:00:00.000Z',
    });
    const done = await createStory(target.organization, target.workspace.id, adminId, {
      epic_id: cleared.id,
      completed_at: '2026-10-21T00:00:00.000Z',
    });
    const inCanceled = await createStory(target.organization, target.workspace.id, adminId, { epic_id: canceled.id });
    const first = (await (await get(target, done.id)).json()) as Record<string, unknown>;
    const second = (await (await get(target, inCanceled.id)).json()) as Record<string, unknown>;
    expect(first).toMatchObject({
      completed_at: '2026-10-21T00:00:00.000Z',
      open_task_count: 0,
      parent_finished: true,
    });
    expect(second).toMatchObject({ completed_at: null, parent_finished: true });
  });

  test('未完了の件数は、別のストーリーのタスクと、削除したタスクを数えない', async () => {
    const target = await createTarget();
    const adminId = target.admin.userId!;
    const story = await createStory(target.organization, target.workspace.id, adminId);
    const other = await createStory(target.organization, target.workspace.id, adminId);
    await createTask(target.organization, target.workspace.id, adminId, { story_id: story.id });
    await createTask(target.organization, target.workspace.id, adminId, {
      story_id: story.id,
      deleted_at: '2026-10-21T00:00:00.000Z',
    });
    await createTask(target.organization, target.workspace.id, adminId, { story_id: other.id });
    await createTask(target.organization, target.workspace.id, adminId, { story_id: other.id });
    const body = (await (await get(target, story.id)).json()) as { open_task_count: number };
    expect(body.open_task_count).toBe(1);
  });

  test('削除したエピックの下のストーリーは、そのエピックが完了か中止していても parent_finished が偽', async () => {
    const target = await createTarget();
    const adminId = target.admin.userId!;
    const stamp = '2026-10-20T00:00:00.000Z';
    const deletedAt = '2026-10-21T00:00:00.000Z';
    const cleared = await createEpic(target.organization, target.workspace.id, adminId, {
      completed_at: stamp,
      deleted_at: deletedAt,
    });
    const canceled = await createEpic(target.organization, target.workspace.id, adminId, {
      canceled_at: stamp,
      deleted_at: deletedAt,
    });
    for (const epic of [cleared, canceled]) {
      const story = await createStory(target.organization, target.workspace.id, adminId, { epic_id: epic.id });
      const body = (await (await get(target, story.id)).json()) as { parent_finished: boolean };
      expect(body.parent_finished).toBe(false);
    }
  });

  test('閉じたワークスペースでも読める', async () => {
    const target = await createTarget({ closed: true });
    const story = await createStory(target.organization, target.workspace.id, target.admin.userId!);
    expect((await get(target, story.id, target.admin)).status).toBe(200);
  });

  test('別の組織・別のワークスペース・削除済み・存在しないストーリーは 404', async () => {
    const target = await createTarget();
    const foreign = await createTarget();
    const adminId = target.admin.userId!;
    const ids = [
      (await createStory(foreign.organization, foreign.workspace.id, foreign.admin.userId!)).id,
      (await createStory(target.organization, target.otherWorkspace.id, adminId)).id,
      (await createStory(target.organization, target.workspace.id, adminId, { deleted_at: '2026-10-21T00:00:00.000Z' }))
        .id,
      '019a0000-0000-7000-8000-00000000ffff',
    ];
    for (const id of ids) {
      const res = await get(target, id);
      expect(res.status, id).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    }
  });
});
