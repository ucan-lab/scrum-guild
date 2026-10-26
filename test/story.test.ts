// ストーリーの作成と変更の振る舞い。
// 組織の分離と権限の種類ごとの許可と拒否は、一覧を回す test/operation-registry.test.ts が確かめる
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { storyCreate, storyGet, storyUpdate } from '../src/shared/operations/story/index.ts';
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
