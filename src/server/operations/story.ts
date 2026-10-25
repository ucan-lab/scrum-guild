import { generateKeyBetween } from 'fractional-indexing';
import { now } from '../../shared/clock.ts';
import { storyCreate, storyGet, storyUpdate, type StoryDetail } from '../../shared/operations/story/index.ts';
import type { OrganizationDb } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { actorUserIdOf, changeLogColumns, openWorkspace, throwIfClosed } from './write-guards.ts';

// ストーリーのダイアログの欄。作るときの履歴に使う
const EDITABLE_FIELDS = ['title', 'acceptance_criteria_md', 'body_md', 'due_on', 'link_url'] as const;

// 同時の更新に負けたときにやり直す回数の上限。超えたら 409 の conflict
const MAX_UPDATE_ATTEMPTS = 3;

// 削除していないストーリーの、ダイアログが出す欄。ワークスペースで必ず絞る
async function readStory(db: OrganizationDb, workspaceId: string, storyId: string): Promise<StoryDetail | undefined> {
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('stories')
        .select([
          'stories.id',
          'stories.title',
          'stories.acceptance_criteria_md',
          'stories.body_md',
          'stories.due_on',
          'stories.link_url',
        ])
        .where('stories.id', '=', storyId)
        .where('stories.workspace_id', '=', workspaceId)
        .where('stories.deleted_at', 'is', null),
    ),
  );
}

export const storyGetOperation = implement(storyGet, async ({ db, workspace, input }) => {
  const story = await readStory(db, workspace.workspaceId, input.story_id);
  if (story === undefined) throw new ApiError(404, 'not_found');
  return { story };
});

export const storyCreateOperation = implement(storyCreate, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;

  // 位置は親のないストーリーの末尾。完了したストーリーも並びに残っているので、それも含めた末尾に置く
  const last = await db.first(
    db.statement((q) =>
      q
        .selectFrom('stories')
        .select('stories.position')
        .where('stories.workspace_id', '=', workspaceId)
        .where('stories.epic_id', 'is', null)
        .where('stories.deleted_at', 'is', null)
        .orderBy('stories.position', 'desc')
        .limit(1),
    ),
  );
  const at = now();
  const createdAt = at.toISOString();
  const storyId = uuidv7(at);
  const position = generateKeyBetween(last?.position ?? null, null);

  const created: Record<string, [null, unknown]> = { title: [null, input.title] };
  for (const field of EDITABLE_FIELDS) {
    if (field !== 'title' && input[field] !== null) created[field] = [null, input[field]];
  }

  const results = await db.batch([
    db.statement((q) =>
      q
        .insertInto('stories')
        .columns([
          'id',
          'workspace_id',
          'epic_id',
          'title',
          'acceptance_criteria_md',
          'body_md',
          'due_on',
          'link_url',
          'created_by',
          'position',
          'created_at',
          'updated_at',
        ])
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(storyId).as('id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(null).as('epic_id'),
              eb.val(input.title).as('title'),
              eb.val(input.acceptance_criteria_md).as('acceptance_criteria_md'),
              eb.val(input.body_md).as('body_md'),
              eb.val(input.due_on).as('due_on'),
              eb.val(input.link_url).as('link_url'),
              eb.val(actorUserId).as('created_by'),
              eb.val(position).as('position'),
              eb.val(createdAt).as('created_at'),
              eb.val(createdAt).as('updated_at'),
            ])
            .where((eb) => eb.exists(openWorkspace(eb, organizationId, workspaceId))),
        ),
    ),
    // 作った行があるときだけ履歴を書く
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(uuidv7(at)).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(actorUserId).as('actor_user_id'),
              eb.val('story').as('entity_type'),
              eb.val(storyId).as('entity_id'),
              eb.val('create').as('action'),
              eb.val(JSON.stringify(created)).as('changes_json'),
              eb.val(createdAt).as('created_at'),
            ])
            .where((eb) =>
              eb.exists(
                eb
                  .selectFrom('stories')
                  .select('stories.id')
                  .where('stories.id', '=', storyId)
                  .where('stories.workspace_id', '=', workspaceId),
              ),
            ),
        ),
    ),
  ]);

  // 読んでから書くまでに、ワークスペースが閉じたら何も入らない
  if ((results[0]?.changes ?? 0) === 0) {
    await throwIfClosed(db, workspaceId);
    throw new ApiError(404, 'not_found');
  }
  return {
    story: {
      id: storyId,
      title: input.title,
      acceptance_criteria_md: input.acceptance_criteria_md,
      body_md: input.body_md,
      due_on: input.due_on,
      link_url: input.link_url,
    },
  };
});

// 書く欄。タイトルは空にできないので、欄ごとに型を分ける
type UpdatedFields = {
  title?: string;
  acceptance_criteria_md?: string | null;
  body_md?: string | null;
  due_on?: string | null;
  link_url?: string | null;
};

// 読んだ値と、送られた値の差。送られた欄のうち、読んだ値と違うものだけを書く
function diffOf(current: StoryDetail, input: UpdatedFields) {
  const values: UpdatedFields = {};
  const changes: Record<string, [string | null, string | null]> = {};
  if (input.title !== undefined && input.title !== current.title) {
    values.title = input.title;
    changes.title = [current.title, input.title];
  }
  for (const field of ['acceptance_criteria_md', 'body_md', 'due_on', 'link_url'] as const) {
    const next = input[field];
    if (next === undefined || next === current[field]) continue;
    values[field] = next;
    changes[field] = [current[field], next];
  }
  return { values, changes, isEmpty: Object.keys(changes).length === 0 };
}

export const storyUpdateOperation = implement(storyUpdate, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const storyId = input.story_id;

  // 読んだ値からの差を、「読んだ値のままなら」という条件つきで書く。読んでから書くまでに別の要求が同じ欄を変えていたら、
  // 更新は通らない（履歴の「前」がずれるのと、同じ値の指定が取りこぼされるのを防ぐ）。通らなかったら読み直して、差を作り直す。
  // 別の欄だけを変えた要求とは、条件がぶつからない（送っていない欄は条件にも書く値にも入れない）
  for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt++) {
    const current = await readStory(db, workspaceId, storyId);
    if (current === undefined) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(404, 'not_found');
    }
    const { values, changes, isEmpty } = diffOf(current, input);
    if (isEmpty) {
      // 書くものが無くても、閉じたワークスペースは断る
      await throwIfClosed(db, workspaceId);
      return { story: current };
    }

    const at = now();
    const updatedAt = at.toISOString();
    const results = await db.batch([
      db.statement((q) =>
        q
          .updateTable('stories')
          .set({ ...values, updated_at: updatedAt })
          .where((eb) =>
            eb.and([
              eb('id', '=', storyId),
              eb('workspace_id', '=', workspaceId),
              eb('deleted_at', 'is', null),
              eb.exists(openWorkspace(q, organizationId, workspaceId)),
              // 書く欄が、読んだときの値のまま
              ...(values.title === undefined ? [] : [eb('title', 'is', current.title)]),
              ...(values.acceptance_criteria_md === undefined
                ? []
                : [eb('acceptance_criteria_md', 'is', current.acceptance_criteria_md)]),
              ...(values.body_md === undefined ? [] : [eb('body_md', 'is', current.body_md)]),
              ...(values.due_on === undefined ? [] : [eb('due_on', 'is', current.due_on)]),
              ...(values.link_url === undefined ? [] : [eb('link_url', 'is', current.link_url)]),
            ]),
          ),
      ),
      // 自分の更新が通ったときだけ履歴を書く。更新が通らなかった（閉じた、削除された、別の要求が先に変えた）ときは、
      // 行が書いた値と同じになっていても、自分の更新ではない同じ時刻の行を拾わないよう、書いた値の一致も条件にする
      db.statement((q) =>
        q
          .insertInto('change_logs')
          .columns(changeLogColumns)
          .expression(
            q
              .selectNoFrom((eb) => [
                eb.val(uuidv7(at)).as('id'),
                eb.val(organizationId).as('organization_id'),
                eb.val(workspaceId).as('workspace_id'),
                eb.val(actorUserId).as('actor_user_id'),
                eb.val('story').as('entity_type'),
                eb.val(storyId).as('entity_id'),
                eb.val('update').as('action'),
                eb.val(JSON.stringify(changes)).as('changes_json'),
                eb.val(updatedAt).as('created_at'),
              ])
              .where((eb) =>
                eb.and([
                  eb.exists(
                    eb
                      .selectFrom('stories')
                      .select('stories.id')
                      .where((sb) =>
                        sb.and([
                          sb('stories.id', '=', storyId),
                          sb('stories.workspace_id', '=', workspaceId),
                          sb('stories.deleted_at', 'is', null),
                          sb('stories.updated_at', '=', updatedAt),
                          ...(values.title === undefined ? [] : [sb('stories.title', 'is', values.title)]),
                          ...(values.acceptance_criteria_md === undefined
                            ? []
                            : [sb('stories.acceptance_criteria_md', 'is', values.acceptance_criteria_md)]),
                          ...(values.body_md === undefined ? [] : [sb('stories.body_md', 'is', values.body_md)]),
                          ...(values.due_on === undefined ? [] : [sb('stories.due_on', 'is', values.due_on)]),
                          ...(values.link_url === undefined ? [] : [sb('stories.link_url', 'is', values.link_url)]),
                        ]),
                      ),
                  ),
                  eb.exists(openWorkspace(eb, organizationId, workspaceId)),
                ]),
              ),
          ),
      ),
    ]);

    if ((results[0]?.changes ?? 0) > 0) {
      const updated = await readStory(db, workspaceId, storyId);
      if (updated === undefined) throw new ApiError(404, 'not_found');
      return { story: updated };
    }
    // 閉じていれば 409 の workspace_closed。無ければ 404。どちらでもなければ、別の要求が先に同じ欄を変えたので、読み直してやり直す
    await throwIfClosed(db, workspaceId);
    if ((await readStory(db, workspaceId, storyId)) === undefined) throw new ApiError(404, 'not_found');
  }
  throw new ApiError(409, 'conflict');
});
