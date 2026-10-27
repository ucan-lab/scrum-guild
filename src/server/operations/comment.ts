import { now } from '../../shared/clock.ts';
import {
  COMMENT_PAGE_SIZE,
  commentCreate,
  commentDelete,
  commentList,
  commentUpdate,
  type Comment,
  type CommentCursor,
} from '../../shared/operations/task/index.ts';
import {
  previousStatementChanged,
  type OrganizationDb,
  type OrganizationTables,
  type QueryCreator,
  type VerifiedWorkspace,
} from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { actorUserIdOf, changeLogColumns, mayDeleteOwned, openWorkspace, throwIfClosed } from './write-guards.ts';

// タスクのコメント（comment-list、comment-create、comment-update、comment-delete）。
// 対象のタスクは task-detail と同じ（そのワークスペースの削除していないタスク）。コメントはワークスペースで絞り、
// 書いた人と消した人の名前は組織で絞った users から読む。書く文は、タスクがあること、ワークスペースが閉じていないこと、
// （直す、消すなら）コメントが消えていないことを条件に持ち、変わった行の数で 404、workspace_closed、deleted を見分ける

type Actor = { userId: string | null; isAdmin: boolean };

// 削除していない、そのワークスペースのタスク。書く文の条件（EXISTS）と、一覧の確かめに使う
function liveTask(from: Pick<QueryCreator<OrganizationTables>, 'selectFrom'>, workspaceId: string, taskId: string) {
  return from
    .selectFrom('tasks')
    .select('tasks.id')
    .where('tasks.id', '=', taskId)
    .where('tasks.workspace_id', '=', workspaceId)
    .where('tasks.deleted_at', 'is', null);
}

// コメントの行と、書いた人と消した人の今の名前。ワークスペースで絞り、タスクが削除されていれば読まない
function commentRows(q: QueryCreator<OrganizationTables>, organizationId: string, workspaceId: string) {
  return q
    .selectFrom('comments')
    .innerJoin('tasks', (join) =>
      join
        .onRef('tasks.id', '=', 'comments.task_id')
        .on('tasks.workspace_id', '=', workspaceId)
        .on('tasks.deleted_at', 'is', null),
    )
    .leftJoin('users as author', (join) =>
      join.onRef('author.id', '=', 'comments.author_user_id').on('author.organization_id', '=', organizationId),
    )
    .leftJoin('users as deleter', (join) =>
      join.onRef('deleter.id', '=', 'comments.deleted_by').on('deleter.organization_id', '=', organizationId),
    )
    .select([
      'comments.id',
      'comments.task_id',
      'comments.author_user_id',
      'comments.body_md',
      'comments.created_at',
      'comments.edited_at',
      'comments.deleted_at',
      'comments.deleted_by',
      'author.name as author_name',
      'deleter.name as deleter_name',
    ])
    .where('comments.workspace_id', '=', workspaceId);
}

// 一覧の1回分を、新しい順に 51 件（続きがあるかを知るため1件多く）読む文。索引 comments_task（task_id, created_at, id）を後ろから読む。
// 続きは (created_at, id) < before で読む（created_at が同じ行は id の降順で切る）
export function commentPageStatement(db: OrganizationDb, workspaceId: string, taskId: string, before?: CommentCursor) {
  return db.statement((q) =>
    commentRows(q, db.organizationId, workspaceId)
      .where('comments.task_id', '=', taskId)
      .$if(before !== undefined, (qb) =>
        qb.where((eb) =>
          eb.or([
            eb('comments.created_at', '<', before!.created_at),
            eb.and([eb('comments.created_at', '=', before!.created_at), eb('comments.id', '<', before!.id)]),
          ]),
        ),
      )
      .orderBy('comments.created_at', 'desc')
      .orderBy('comments.id', 'desc')
      .limit(COMMENT_PAGE_SIZE + 1),
  );
}

async function readComment(db: OrganizationDb, workspaceId: string, commentId: string) {
  return db.first(
    db.statement((q) => commentRows(q, db.organizationId, workspaceId).where('comments.id', '=', commentId)),
  );
}

type CommentRow = NonNullable<Awaited<ReturnType<typeof readComment>>>;

function commentOf(row: CommentRow, actor: Actor, workspace: VerifiedWorkspace): Comment {
  const live = row.deleted_at === null && !workspace.closed;
  return {
    id: row.id,
    author: { id: row.author_user_id, name: row.author_name ?? '' },
    // 消した行の本文は DB でも空だが、念のため返さない
    body_md: row.deleted_at === null ? row.body_md : '',
    created_at: row.created_at,
    edited_at: row.edited_at,
    deleted_at: row.deleted_at,
    deleted_by: row.deleted_by === null ? null : { id: row.deleted_by, name: row.deleter_name ?? '' },
    can_edit: live && actor.userId !== null && row.author_user_id === actor.userId,
    can_delete: live && mayDeleteOwned(row.author_user_id, actor, workspace),
  };
}

// 変更の履歴（entity_type = 'comment'）の changes_json。どのタスクの、誰のコメントかだけを残し、本文は入れない。
// コメントの行のこの2つは変わらないので、前と後に同じ値を入れる（{"列": [前, 後]} の形にそろえる）
function commentChanges(row: CommentRow): string {
  const author = { id: row.author_user_id, name: row.author_name ?? '' };
  return JSON.stringify({ task_id: [row.task_id, row.task_id], author: [author, author] });
}

// 条件で落ちた書き込み（直す、消す）の理由を、読み直して決める。存在を先に決め、コメント（かタスク）が無ければ 404、
// 閉じていれば workspace_closed、消されていれば deleted、どれでもなければ conflict
async function throwWriteMiss(db: OrganizationDb, workspaceId: string, commentId: string): Promise<never> {
  const current = await readComment(db, workspaceId, commentId);
  if (current === undefined) throw new ApiError(404, 'not_found');
  await throwIfClosed(db, workspaceId);
  if (current.deleted_at !== null) throw new ApiError(409, 'conflict', { reason: 'deleted' });
  throw new ApiError(409, 'conflict');
}

export const commentListOperation = implement(commentList, async ({ db, actor, workspace, input }) => {
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const before: CommentCursor | undefined = input.before;
  // タスクの確かめ、件数、行を並べて送る（引き出しを開くたびに読むので、待つ時間を1往復ぶんにする）。
  // 404 のときも件数と行の文は走るが、ワークスペースで絞っていて、結果は捨てる
  const [task, count, rows] = await Promise.all([
    // タスクがそのワークスペースにあるか（削除したものは 404）と、時刻を出すワークスペースのタイムゾーン
    db.first(
      db.statement((q) =>
        q
          .selectFrom('tasks')
          .innerJoin('workspaces', 'workspaces.id', 'tasks.workspace_id')
          .select(['tasks.id', 'workspaces.timezone'])
          .where('tasks.id', '=', input.task_id)
          .where('tasks.workspace_id', '=', workspaceId)
          .where('tasks.deleted_at', 'is', null)
          .where('workspaces.organization_id', '=', organizationId),
      ),
    ),
    // 消していないコメントの数（タブの「コメント N」）
    db.first(
      db.statement((q) =>
        q
          .selectFrom('comments')
          .select((eb) => eb.fn.countAll<number>().as('count'))
          .where('comments.task_id', '=', input.task_id)
          .where('comments.workspace_id', '=', workspaceId)
          .where('comments.deleted_at', 'is', null),
      ),
    ),
    db.rows(commentPageStatement(db, workspaceId, input.task_id, before)),
  ]);
  if (task === undefined) throw new ApiError(404, 'not_found');

  const page = rows.slice(0, COMMENT_PAGE_SIZE);
  const oldest = page.at(-1);
  return {
    // 書いた順（古い順）にして返す
    comments: page.reverse().map((row) => commentOf(row, actor, workspace)),
    next:
      rows.length > COMMENT_PAGE_SIZE && oldest !== undefined ? { created_at: oldest.created_at, id: oldest.id } : null,
    count: Number(count?.count ?? 0),
    timezone: task.timezone,
  };
});

export const commentCreateOperation = implement(commentCreate, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const taskId = input.task_id;
  const at = now();
  const createdAt = at.toISOString();
  const commentId = uuidv7(at);

  const results = await db.batch([
    db.statement((q) =>
      q
        .insertInto('comments')
        .columns(['id', 'workspace_id', 'task_id', 'author_user_id', 'body_md', 'created_at'])
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(commentId).as('id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(taskId).as('task_id'),
              eb.val(actorUserId).as('author_user_id'),
              eb.val(input.body_md).as('body_md'),
              eb.val(createdAt).as('created_at'),
            ])
            .where((eb) =>
              eb.and([
                eb.exists(liveTask(eb, workspaceId, taskId)),
                eb.exists(openWorkspace(eb, organizationId, workspaceId)),
              ]),
            ),
        ),
    ),
  ]);
  // 何も入らなければ、閉じていれば workspace_closed、そうでなければタスクが無い（別の組織とワークスペースを含む）
  if ((results[0]?.changes ?? 0) === 0) {
    await throwIfClosed(db, workspaceId);
    throw new ApiError(404, 'not_found');
  }
  const created = await readComment(db, workspaceId, commentId);
  if (created === undefined) throw new ApiError(404, 'not_found');
  return { comment: commentOf(created, actor, workspace) };
});

export const commentUpdateOperation = implement(commentUpdate, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const commentId = input.comment_id;

  // 存在（404）を、閉じたか（409）と権限（403）より先に決める
  const current = await readComment(db, workspaceId, commentId);
  if (current === undefined) throw new ApiError(404, 'not_found');
  // 直せるのは書いた本人だけ
  if (current.author_user_id !== actorUserId) throw new ApiError(403, 'forbidden');
  if (current.deleted_at !== null) throw new ApiError(409, 'conflict', { reason: 'deleted' });
  // 今と同じ本文なら何も書かない（編集済みにも、履歴にもしない）。書くものが無くても、閉じたワークスペースは断る
  if (current.body_md === input.body_md) {
    await throwIfClosed(db, workspaceId);
    return { comment: commentOf(current, actor, workspace) };
  }

  const at = now();
  const editedAt = at.toISOString();
  const results = await db.batch([
    // 版の番号は持たず、後から保存したほうを生かす（直せるのは本人だけなので、同時に直すのは同じ人の別の画面だけ）
    db.statement((q) =>
      q
        .updateTable('comments')
        .set({ body_md: input.body_md, edited_at: editedAt })
        .where((eb) =>
          eb.and([
            eb('id', '=', commentId),
            eb('workspace_id', '=', workspaceId),
            eb('author_user_id', '=', actorUserId),
            eb('deleted_at', 'is', null),
            eb.exists(liveTask(q, workspaceId, current.task_id)),
            eb.exists(openWorkspace(q, organizationId, workspaceId)),
          ]),
        ),
    ),
    // 直前の更新が行を変えたときだけ履歴を書く。本文は入れない
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
              eb.val('comment').as('entity_type'),
              eb.val(commentId).as('entity_id'),
              eb.val('update').as('action'),
              eb.val(commentChanges(current)).as('changes_json'),
              eb.val(editedAt).as('created_at'),
            ])
            .where(previousStatementChanged),
        ),
    ),
  ]);
  if ((results[0]?.changes ?? 0) === 0) return throwWriteMiss(db, workspaceId, commentId);
  const updated = await readComment(db, workspaceId, commentId);
  if (updated === undefined) throw new ApiError(404, 'not_found');
  return { comment: commentOf(updated, actor, workspace) };
});

export const commentDeleteOperation = implement(commentDelete, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const commentId = input.comment_id;

  // 存在（404）を、閉じたか（409）と権限（403）より先に決める
  const current = await readComment(db, workspaceId, commentId);
  if (current === undefined) throw new ApiError(404, 'not_found');
  // 消せるのは書いた本人とリーダー（管理者を含む）
  if (!mayDeleteOwned(current.author_user_id, actor, workspace)) throw new ApiError(403, 'forbidden');
  if (current.deleted_at !== null) throw new ApiError(409, 'conflict', { reason: 'deleted' });

  const at = now();
  const deletedAt = at.toISOString();
  const results = await db.batch([
    // 本文を空にして、消した日時と消した人を書く（中身はどこにも残さない）
    db.statement((q) =>
      q
        .updateTable('comments')
        .set({ body_md: '', deleted_at: deletedAt, deleted_by: actorUserId })
        .where((eb) =>
          eb.and([
            eb('id', '=', commentId),
            eb('workspace_id', '=', workspaceId),
            eb('deleted_at', 'is', null),
            eb.exists(liveTask(q, workspaceId, current.task_id)),
            eb.exists(openWorkspace(q, organizationId, workspaceId)),
          ]),
        ),
    ),
    // 直前の削除が行を変えたときだけ履歴を書く（先に消した要求があれば、止めた時計でも書かない）。本文は入れない
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
              eb.val('comment').as('entity_type'),
              eb.val(commentId).as('entity_id'),
              eb.val('delete').as('action'),
              eb.val(commentChanges(current)).as('changes_json'),
              eb.val(deletedAt).as('created_at'),
            ])
            .where(previousStatementChanged),
        ),
    ),
  ]);
  if ((results[0]?.changes ?? 0) === 0) return throwWriteMiss(db, workspaceId, commentId);
  const deleted = await readComment(db, workspaceId, commentId);
  if (deleted === undefined) throw new ApiError(404, 'not_found');
  return { comment: commentOf(deleted, actor, workspace) };
});
