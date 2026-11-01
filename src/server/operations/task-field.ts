// タスクの決まった欄の値（task_field_values）の書き込み（task-field-set）と、未記入の判定。
// docs/data-model.md の task_field_values と「書き込みの単位」の「決まった欄の値」
import { now } from '../../shared/clock.ts';
import { taskFieldSet } from '../../shared/operations/task/index.ts';
import {
  previousStatementChanged,
  type ExpressionBuilder,
  type OrganizationDb,
  type OrganizationTables,
  type QueryCreator,
} from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { actorUserIdOf, changeLogColumns, openWorkspace, throwIfClosed } from './write-guards.ts';

type Tables = OrganizationTables;
type From = Pick<QueryCreator<Tables>, 'selectFrom'>;

// 削除していない決まった欄のうち、タスク（taskRef は呼ぶ側の文の tasks.id）に値の行が無いもの。1行でもあれば、そのタスクは未記入。
// 呼ぶ側は eb.exists(...) で包み、完了していないことは自分の文の条件にする。ワークスペースで絞り、値は主キー
// （task_id, field_id）で引く。削除した欄は数えない（値の行は残るが、判定から外れる）
function unfilledFields(from: From, workspaceId: string, taskRef: 'tasks.id') {
  return from
    .selectFrom('detail_fields as f')
    .select('f.id')
    .where('f.workspace_id', '=', workspaceId)
    .where('f.deleted_at', 'is', null)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('task_field_values as v')
            .select('v.field_id')
            .whereRef('v.field_id', '=', 'f.id')
            // taskRef は呼ぶ側の文の列（型の上では v の列として扱う）
            .whereRef('v.task_id', '=', taskRef as unknown as 'v.task_id'),
        ),
      ),
    );
}

// 未記入か、という条件の式。tasks を FROM に持つ文の select と where で使う（結んだ表で eb の型が変わるので、型は tasks だけの形にそろえる）。
// 完了していないことは、呼ぶ側の文の条件にする
export function unfilledExists<DB, TB extends keyof DB>(builder: ExpressionBuilder<DB, TB>, workspaceId: string) {
  const eb = builder as unknown as ExpressionBuilder<Tables, never>;
  return eb.exists(unfilledFields(eb, workspaceId, 'tasks.id'));
}

// 削除していない決まった欄と、そのタスクの値（無ければ null）。position の順
export async function readTaskFields(db: OrganizationDb, workspaceId: string, taskId: string) {
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('detail_fields as f')
        .leftJoin('task_field_values as v', (join) =>
          join.onRef('v.field_id', '=', 'f.id').on('v.task_id', '=', taskId),
        )
        .select(['f.id', 'f.name', 'v.value_md'])
        .where('f.workspace_id', '=', workspaceId)
        .where('f.deleted_at', 'is', null)
        .orderBy('f.position')
        .orderBy('f.id'),
    ),
  );
  return rows.map((row) => ({ id: row.id, name: row.name, value_md: row.value_md }));
}

// 完了していないタスクで、値の行が無い決まった欄があるか（タスクが無ければ偽）
export async function readUnfilled(db: OrganizationDb, workspaceId: string, taskId: string): Promise<boolean> {
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('tasks')
        .select((eb) => unfilledExists(eb, workspaceId).as('unfilled'))
        .where('tasks.id', '=', taskId)
        .where('tasks.workspace_id', '=', workspaceId)
        .where('tasks.deleted_at', 'is', null)
        .where('tasks.completed_at', 'is', null),
    ),
  );
  return Number(row?.unfilled ?? 0) === 1;
}

// 削除していないタスクと決まった欄の行。書く文の条件（EXISTS）と、落ちた理由の読みに使う。ワークスペースで必ず絞る
function liveTask(from: From, workspaceId: string, taskId: string) {
  return from
    .selectFrom('tasks')
    .select('tasks.id')
    .where('tasks.id', '=', taskId)
    .where('tasks.workspace_id', '=', workspaceId)
    .where('tasks.deleted_at', 'is', null);
}

function liveField(from: From, workspaceId: string, fieldId: string) {
  return from
    .selectFrom('detail_fields')
    .select(['detail_fields.id', 'detail_fields.name'])
    .where('detail_fields.id', '=', fieldId)
    .where('detail_fields.workspace_id', '=', workspaceId)
    .where('detail_fields.deleted_at', 'is', null);
}

function readTarget(db: OrganizationDb, workspaceId: string, taskId: string, fieldId: string) {
  return db.batch([
    db.statement((q) => liveTask(q, workspaceId, taskId)),
    db.statement((q) => liveField(q, workspaceId, fieldId)),
  ] as const);
}

// 履歴に残す欄の { id, name }。名前は、履歴を書く文が読む欄の行から取る
function fieldRef(eb: ExpressionBuilder<Tables, 'detail_fields'>) {
  return eb.fn('json_object', [eb.val('id'), eb.ref('detail_fields.id'), eb.val('name'), eb.ref('detail_fields.name')]);
}

// 読んだ値（read_md。行が無ければ null）のままなら書き、違えば 409 の conflict（changed）で断る。
// 書く文: 行が無い欄に書くのは INSERT ... SELECT ... WHERE NOT EXISTS（その行）、行のある欄に書くのは UPDATE ... WHERE value_md = 読んだ値、
// 空にするのは DELETE ... WHERE value_md = 読んだ値。どれも、閉じていないワークスペース、削除していないタスク、削除していない欄が条件。
// 履歴は、書けたとき（直前の文が行を変えたとき）だけ、同じ batch() で書く。前後は欄の { id, name } か null（値の全文は入れない）
export const taskFieldSetOperation = implement(taskFieldSet, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const { task_id: taskId, field_id: fieldId } = input;
  const next = input.value_md;
  const read = input.read_md;

  const [taskResult, fieldResult] = await readTarget(db, workspaceId, taskId, fieldId);
  const field = fieldResult.rows[0];
  if (taskResult.rows[0] === undefined || field === undefined) {
    await throwIfClosed(db, workspaceId);
    throw new ApiError(404, 'not_found');
  }

  // 書いた後（か、何も書かなかったとき）の値と、そのタスクが未記入か
  const respond = async () => {
    const [stored, unfilled] = await Promise.all([
      db.first(
        db.statement((q) =>
          q
            .selectFrom('task_field_values')
            .select('task_field_values.value_md')
            .where('task_field_values.task_id', '=', taskId)
            .where('task_field_values.field_id', '=', fieldId),
        ),
      ),
      readUnfilled(db, workspaceId, taskId),
    ]);
    return { field: { id: field.id, name: field.name, value_md: stored?.value_md ?? null }, unfilled };
  };

  // 読んだ値と同じ値を書くなら、何も書かない（履歴も残さない）。閉じたワークスペースは断る
  if (next === read) {
    await throwIfClosed(db, workspaceId);
    return respond();
  }

  const at = now();
  const updatedAt = at.toISOString();
  // 書ける条件。ワークスペースが開いていて、タスクと欄が今も削除されていない
  const writable = (q: From) => [
    openWorkspace(q, organizationId, workspaceId),
    liveTask(q, workspaceId, taskId),
    liveField(q, workspaceId, fieldId),
  ];

  const insertValue = () =>
    db.statement((q) =>
      q
        .insertInto('task_field_values')
        .columns(['task_id', 'field_id', 'value_md', 'updated_by', 'updated_at'])
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(taskId).as('task_id'),
              eb.val(fieldId).as('field_id'),
              eb.val(next!).as('value_md'),
              eb.val(actorUserId).as('updated_by'),
              eb.val(updatedAt).as('updated_at'),
            ])
            .where((eb) =>
              eb.and([
                ...writable(q).map((guard) => eb.exists(guard)),
                eb.not(
                  eb.exists(
                    q
                      .selectFrom('task_field_values')
                      .select('task_field_values.task_id')
                      .where('task_field_values.task_id', '=', taskId)
                      .where('task_field_values.field_id', '=', fieldId),
                  ),
                ),
              ]),
            ),
        ),
    );

  const updateValue = () =>
    db.statement((q) =>
      q
        .updateTable('task_field_values')
        .set({ value_md: next!, updated_by: actorUserId, updated_at: updatedAt })
        .where((eb) =>
          eb.and([
            eb('task_id', '=', taskId),
            eb('field_id', '=', fieldId),
            eb('value_md', '=', read!),
            ...writable(q).map((guard) => eb.exists(guard)),
          ]),
        ),
    );

  const deleteValue = () =>
    db.statement((q) =>
      q
        .deleteFrom('task_field_values')
        .where((eb) =>
          eb.and([
            eb('task_id', '=', taskId),
            eb('field_id', '=', fieldId),
            eb('value_md', '=', read!),
            ...writable(q).map((guard) => eb.exists(guard)),
          ]),
        ),
    );

  const results = await db.batch([
    read === null ? insertValue() : next === null ? deleteValue() : updateValue(),
    // 書けたときだけ履歴を書く。前後は欄の名前だけ（値の全文は入れない）
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          q
            .selectFrom('detail_fields')
            .select((eb) => [
              eb.val(uuidv7(at)).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(actorUserId).as('actor_user_id'),
              eb.val('task').as('entity_type'),
              eb.val(taskId).as('entity_id'),
              eb.val('update').as('action'),
              eb
                .fn<string>('json_object', [
                  eb.val('field'),
                  eb.fn('json_array', [
                    read === null ? eb.lit(null) : fieldRef(eb),
                    next === null ? eb.lit(null) : fieldRef(eb),
                  ]),
                ])
                .as('changes_json'),
              eb.val(updatedAt).as('created_at'),
            ])
            .where('detail_fields.id', '=', fieldId)
            .where('detail_fields.workspace_id', '=', workspaceId)
            .where(previousStatementChanged),
        ),
    ),
  ] as const);

  if ((results[0]?.changes ?? 0) > 0) return respond();

  // 閉じていれば 409、タスクか欄が無ければ 404、どちらでもなければ、別の要求が先に同じ欄を直した
  await throwIfClosed(db, workspaceId);
  const [taskAgain, fieldAgain] = await readTarget(db, workspaceId, taskId, fieldId);
  if (taskAgain.rows[0] === undefined || fieldAgain.rows[0] === undefined) throw new ApiError(404, 'not_found');
  throw new ApiError(409, 'conflict', { reason: 'changed' });
});
