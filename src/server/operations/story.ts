import { generateKeyBetween } from 'fractional-indexing';
import { now } from '../../shared/clock.ts';
import { storyCreate, storyUpdate, type StoryDetail } from '../../shared/operations/story/index.ts';
import type { OrganizationDb } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { actorUserIdOf, changeLogColumns, openWorkspace, throwIfClosed } from './write-guards.ts';

// 変更の履歴と更新の対象になる欄。ストーリーのダイアログの欄と同じ
const EDITABLE_FIELDS = ['title', 'acceptance_criteria_md', 'body_md', 'due_on', 'link_url'] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];

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

export const storyUpdateOperation = implement(storyUpdate, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const storyId = input.story_id;

  const current = await readStory(db, workspaceId, storyId);
  if (current === undefined) throw new ApiError(404, 'not_found');

  // 送られた欄のうち、今の値と違うものだけを書く。同時に別の欄を直した人の変更は、送っていない欄なので残る
  const written: Partial<Record<EditableField, string | null>> = {};
  const changes: Partial<Record<EditableField, [string | null, string | null]>> = {};
  for (const field of EDITABLE_FIELDS) {
    const next = input[field];
    if (next === undefined || next === current[field]) continue;
    written[field] = next;
    changes[field] = [current[field], next];
  }
  if (Object.keys(written).length === 0) return { story: current };
  // タイトルは空にできない（入力の検証が通した値は 1 字以上）ので、列の型に合わせて null を外す
  const { title, ...rest } = written;
  const values = { ...rest, ...(title === undefined || title === null ? {} : { title }) };

  const at = now();
  const updatedAt = at.toISOString();
  const results = await db.batch([
    db.statement((q) =>
      q
        .updateTable('stories')
        .set({ ...values, updated_at: updatedAt })
        .where('id', '=', storyId)
        .where('workspace_id', '=', workspaceId)
        .where('deleted_at', 'is', null)
        .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId))),
    ),
    // 自分の更新が通ったときだけ履歴を書く。閉じたか削除されていれば、更新は通らず、この条件も偽になる
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
                    .where('stories.id', '=', storyId)
                    .where('stories.workspace_id', '=', workspaceId)
                    .where('stories.deleted_at', 'is', null)
                    .where('stories.updated_at', '=', updatedAt),
                ),
                eb.exists(openWorkspace(eb, organizationId, workspaceId)),
              ]),
            ),
        ),
    ),
  ]);

  if ((results[0]?.changes ?? 0) === 0) {
    await throwIfClosed(db, workspaceId);
    throw new ApiError(404, 'not_found');
  }
  const updated = await readStory(db, workspaceId, storyId);
  if (updated === undefined) throw new ApiError(404, 'not_found');
  return { story: updated };
});
