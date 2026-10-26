import { now, todayIn } from '../../shared/clock.ts';
import {
  sprintCreate,
  sprintDelete,
  sprintList,
  sprintUpdate,
  type SprintConflictReason,
  type SprintSummary,
} from '../../shared/operations/sprint/index.ts';
import { sprintDefaults, sprintEndOn, sprintLengthOf } from '../../shared/sprint.ts';
import {
  previousStatementChanged,
  type OrganizationDb,
  type OrganizationTables,
  type QueryCreator,
} from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { actorUserIdOf, changeLogColumns, openWorkspace, throwIfClosed } from './write-guards.ts';

// 同時の更新に負けたときにやり直す回数の上限。超えたら 409 の conflict（story-update と同じ）
const MAX_UPDATE_ATTEMPTS = 3;

type SprintRow = { id: string; name: string | null; start_on: string; end_on: string; status: string };

function conflict(reason: SprintConflictReason): ApiError {
  return new ApiError(409, 'conflict', { reason });
}

// 画面に返す形。一覧は planned と active だけを返し、変える操作は planned だけを書くので、status はこの2つになる
function summaryOf(row: SprintRow): SprintSummary {
  return {
    id: row.id,
    name: row.name,
    start_on: row.start_on,
    end_on: row.end_on,
    length: sprintLengthOf(row.start_on, row.end_on),
    status: row.status === 'active' ? 'active' : 'planned',
  };
}

// 同じワークスペースの、削除していない、期間が [startOn, endOn] と重なるスプリント（終了したものも含む）。
// 変える操作では、変える行そのもの（exceptId）を外す。日付は YYYY-MM-DD なので、文字列の比較が日付の前後と一致する
function overlapping(
  from: Pick<QueryCreator<OrganizationTables>, 'selectFrom'>,
  workspaceId: string,
  startOn: string,
  endOn: string,
  exceptId: string | null,
) {
  const query = from
    .selectFrom('sprints as other')
    .select('other.id')
    .where('other.workspace_id', '=', workspaceId)
    .where('other.deleted_at', 'is', null)
    .where('other.start_on', '<=', endOn)
    .where('other.end_on', '>=', startOn);
  return exceptId === null ? query : query.where('other.id', '!=', exceptId);
}

async function overlapExists(
  db: OrganizationDb,
  workspaceId: string,
  startOn: string,
  endOn: string,
  exceptId: string | null,
): Promise<boolean> {
  const row = await db.first(db.statement((q) => overlapping(q, workspaceId, startOn, endOn, exceptId).limit(1)));
  return row !== undefined;
}

// 削除していないスプリント1件。ワークスペースで必ず絞る
async function readSprint(db: OrganizationDb, workspaceId: string, sprintId: string): Promise<SprintRow | undefined> {
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('sprints')
        .select(['sprints.id', 'sprints.name', 'sprints.start_on', 'sprints.end_on', 'sprints.status'])
        .where('sprints.id', '=', sprintId)
        .where('sprints.workspace_id', '=', workspaceId)
        .where('sprints.deleted_at', 'is', null),
    ),
  );
}

// 一覧、前のスプリント、ワークスペースのタイムゾーンと週の始まりを1回の batch() で読む。
// 前のスプリントは、削除していないもの（終了したものも含む）のうち最終日がいちばん後のもの
export const sprintListOperation = implement(sprintList, async ({ db, workspace }) => {
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const [workspaceResult, sprintsResult, previousResult] = await db.batch([
    db.statement((q) =>
      q
        .selectFrom('workspaces')
        .select(['workspaces.timezone', 'workspaces.week_start'])
        .where('workspaces.id', '=', workspaceId)
        .where('workspaces.organization_id', '=', organizationId),
    ),
    db.statement((q) =>
      q
        .selectFrom('sprints')
        .select(['sprints.id', 'sprints.name', 'sprints.start_on', 'sprints.end_on', 'sprints.status'])
        .where('sprints.workspace_id', '=', workspaceId)
        .where('sprints.deleted_at', 'is', null)
        .where('sprints.status', 'in', ['planned', 'active'])
        .orderBy('sprints.start_on')
        .orderBy('sprints.id'),
    ),
    db.statement((q) =>
      q
        .selectFrom('sprints')
        .select(['sprints.start_on', 'sprints.end_on'])
        .where('sprints.workspace_id', '=', workspaceId)
        .where('sprints.deleted_at', 'is', null)
        .orderBy('sprints.end_on', 'desc')
        .limit(1),
    ),
  ]);
  const settings = workspaceResult?.rows[0];
  if (settings === undefined) throw new ApiError(404, 'not_found');
  const today = todayIn(settings.timezone);
  return {
    sprints: (sprintsResult?.rows ?? []).map(summaryOf),
    defaults: sprintDefaults(previousResult?.rows[0] ?? null, today, settings.week_start),
  };
});

// 書く文は INSERT ... SELECT ... WHERE（閉じていないワークスペース、重なるスプリントが無い）。D1 の batch() は順に流れるので、
// 2つの要求が同時に同じ期間を作っても、後の要求の文は先に入った行を見て何も入れない
export const sprintCreateOperation = implement(sprintCreate, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const endOn = sprintEndOn(input.start_on, input.length);
  if (endOn === null) throw new ApiError(400, 'invalid_input');

  const at = now();
  const createdAt = at.toISOString();
  const sprintId = uuidv7(at);
  const created: Record<string, [null, string]> = {
    ...(input.name === null ? {} : { name: [null, input.name] }),
    start_on: [null, input.start_on],
    end_on: [null, endOn],
  };

  const results = await db.batch([
    db.statement((q) =>
      q
        .insertInto('sprints')
        .columns(['id', 'workspace_id', 'name', 'start_on', 'end_on', 'status', 'created_at', 'updated_at'])
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(sprintId).as('id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(input.name).as('name'),
              eb.val(input.start_on).as('start_on'),
              eb.val(endOn).as('end_on'),
              eb.val('planned').as('status'),
              eb.val(createdAt).as('created_at'),
              eb.val(createdAt).as('updated_at'),
            ])
            .where((eb) =>
              eb.and([
                eb.exists(openWorkspace(eb, organizationId, workspaceId)),
                eb.not(eb.exists(overlapping(eb, workspaceId, input.start_on, endOn, null))),
              ]),
            ),
        ),
    ),
    // 直前の INSERT が行を入れたときだけ履歴を書く（docs/data-model.md の「直前の文に結ぶ」）
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
              eb.val('sprint').as('entity_type'),
              eb.val(sprintId).as('entity_id'),
              eb.val('create').as('action'),
              eb.val(JSON.stringify(created)).as('changes_json'),
              eb.val(createdAt).as('created_at'),
            ])
            .where(previousStatementChanged),
        ),
    ),
  ]);

  if ((results[0]?.changes ?? 0) === 0) {
    // 読んでから書くまでに閉じたら 409 の workspace_closed。重なれば overlap。どちらでもなければ（ワークスペースが消えた）404
    await throwIfClosed(db, workspaceId);
    if (await overlapExists(db, workspaceId, input.start_on, endOn, null)) throw conflict('overlap');
    throw new ApiError(404, 'not_found');
  }
  return {
    sprint: summaryOf({ id: sprintId, name: input.name, start_on: input.start_on, end_on: endOn, status: 'planned' }),
  };
});

type UpdatedFields = { name?: string | null; start_on?: string; end_on?: string };

// 読んだ値と、送られた値から決めた次の値の差。長さだけを送ると、今の開始日から最終日を決め直す
function diffOf(current: SprintRow, input: { name?: string | null; start_on?: string; length?: number }) {
  const startOn = input.start_on ?? current.start_on;
  const endOn = sprintEndOn(startOn, input.length ?? sprintLengthOf(current.start_on, current.end_on));
  if (endOn === null) throw new ApiError(400, 'invalid_input');
  const values: UpdatedFields = {};
  const changes: Record<string, [string | null, string | null]> = {};
  if (input.name !== undefined && input.name !== current.name) {
    values.name = input.name;
    changes.name = [current.name, input.name];
  }
  if (startOn !== current.start_on) {
    values.start_on = startOn;
    changes.start_on = [current.start_on, startOn];
  }
  if (endOn !== current.end_on) {
    values.end_on = endOn;
    changes.end_on = [current.end_on, endOn];
  }
  return {
    values,
    changes,
    startOn,
    endOn,
    rangeChanged: values.start_on !== undefined || values.end_on !== undefined,
    isEmpty: Object.keys(changes).length === 0,
  };
}

// 書き方は epic-update と同じ。読んだ値からの差を、読んだ値のままで、始まっておらず、期間を変えるなら重なるスプリントが無いときだけ書き、
// 通らなかったら理由を読み直して分ける（閉じた、無い、始まった、重なる）。どれでもなければ、読み直して差を作り直す
export const sprintUpdateOperation = implement(sprintUpdate, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const sprintId = input.sprint_id;

  for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt++) {
    const current = await readSprint(db, workspaceId, sprintId);
    if (current === undefined) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(404, 'not_found');
    }
    if (current.status !== 'planned') {
      await throwIfClosed(db, workspaceId);
      throw conflict('started');
    }
    const { values, changes, startOn, endOn, rangeChanged, isEmpty } = diffOf(current, input);
    if (isEmpty) {
      // 書くものが無くても、閉じたワークスペースは断る
      await throwIfClosed(db, workspaceId);
      return { sprint: summaryOf(current) };
    }

    const at = now();
    const updatedAt = at.toISOString();
    const results = await db.batch([
      db.statement((q) =>
        q
          .updateTable('sprints')
          .set({ ...values, updated_at: updatedAt })
          .where((eb) =>
            eb.and([
              eb('id', '=', sprintId),
              eb('workspace_id', '=', workspaceId),
              eb('deleted_at', 'is', null),
              eb('status', '=', 'planned'),
              eb.exists(openWorkspace(q, organizationId, workspaceId)),
              ...(rangeChanged ? [eb.not(eb.exists(overlapping(q, workspaceId, startOn, endOn, sprintId)))] : []),
              // 書く列が、読んだときの値のまま。期間を変えるときは、片側だけを書くときも両端を守る
              // （最終日と重なりの検査は読んだ開始日と最終日から決めたので、もう片側を別の要求が動かしていたら書かない）
              ...(values.name === undefined ? [] : [eb('name', 'is', current.name)]),
              ...(rangeChanged ? [eb('start_on', 'is', current.start_on), eb('end_on', 'is', current.end_on)] : []),
            ]),
          ),
      ),
      // 直前の UPDATE が行を変えたときだけ履歴を書く（docs/data-model.md の「直前の文に結ぶ」）
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
                eb.val('sprint').as('entity_type'),
                eb.val(sprintId).as('entity_id'),
                eb.val('update').as('action'),
                eb.val(JSON.stringify(changes)).as('changes_json'),
                eb.val(updatedAt).as('created_at'),
              ])
              .where(previousStatementChanged),
          ),
      ),
    ]);

    if ((results[0]?.changes ?? 0) > 0) {
      const updated = await readSprint(db, workspaceId, sprintId);
      if (updated === undefined) throw new ApiError(404, 'not_found');
      return { sprint: summaryOf(updated) };
    }
    await throwIfClosed(db, workspaceId);
    const reread = await readSprint(db, workspaceId, sprintId);
    if (reread === undefined) throw new ApiError(404, 'not_found');
    if (reread.status !== 'planned') throw conflict('started');
    if (rangeChanged && (await overlapExists(db, workspaceId, startOn, endOn, sprintId))) throw conflict('overlap');
  }
  throw new ApiError(409, 'conflict');
});

// 論理削除。書く文は、削除していない、始まっていない、閉じていないワークスペースのスプリントだけを書く
export const sprintDeleteOperation = implement(sprintDelete, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const sprintId = input.sprint_id;

  const current = await readSprint(db, workspaceId, sprintId);
  if (current === undefined) {
    await throwIfClosed(db, workspaceId);
    throw new ApiError(404, 'not_found');
  }
  if (current.status !== 'planned') {
    await throwIfClosed(db, workspaceId);
    throw conflict('started');
  }

  const at = now();
  const deletedAt = at.toISOString();
  const results = await db.batch([
    db.statement((q) =>
      q
        .updateTable('sprints')
        .set({ deleted_at: deletedAt, updated_at: deletedAt })
        .where((eb) =>
          eb.and([
            eb('id', '=', sprintId),
            eb('workspace_id', '=', workspaceId),
            eb('deleted_at', 'is', null),
            eb('status', '=', 'planned'),
            eb.exists(openWorkspace(q, organizationId, workspaceId)),
          ]),
        ),
    ),
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
              eb.val('sprint').as('entity_type'),
              eb.val(sprintId).as('entity_id'),
              eb.val('delete').as('action'),
              eb.val(JSON.stringify({ deleted_at: [null, deletedAt] })).as('changes_json'),
              eb.val(deletedAt).as('created_at'),
            ])
            .where(previousStatementChanged),
        ),
    ),
  ]);

  if ((results[0]?.changes ?? 0) === 0) {
    await throwIfClosed(db, workspaceId);
    const reread = await readSprint(db, workspaceId, sprintId);
    if (reread === undefined) throw new ApiError(404, 'not_found');
    if (reread.status !== 'planned') throw conflict('started');
    throw new ApiError(409, 'conflict');
  }
  return { sprint_id: sprintId };
});
