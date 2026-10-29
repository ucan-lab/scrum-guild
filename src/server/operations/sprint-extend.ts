import { now } from '../../shared/clock.ts';
import { sprintExtend } from '../../shared/operations/sprint/index.ts';
import { SPRINT_MAX_LENGTH, sprintExtension, sprintLengthOf } from '../../shared/sprint.ts';
import {
  previousStatementChanged,
  sprintExtensionUnchanged,
  sprintExtensionNoOverlap,
  type SprintExtensionWrite,
  type Statement,
} from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import { summaryOf, type SprintRow } from './sprint.ts';
import { actorUserIdOf, changeLogColumns, openWorkspace, throwIfClosed } from './write-guards.ts';

// 同時の更新に負けたときにやり直す回数の上限。超えたら 409 の changed
const MAX_ATTEMPTS = 3;

// 書く対象の1行。JSON で条件に渡す値は、この7項目だけにする（行をそのまま広げない）
function writeOf(
  row: Pick<SprintRow, 'id' | 'status' | 'start_on' | 'end_on' | 'extended_days'>,
  nextStartOn: string,
  nextEndOn: string,
): SprintExtensionWrite {
  return {
    id: row.id,
    status: row.status,
    start_on: row.start_on,
    end_on: row.end_on,
    extended_days: row.extended_days,
    next_start_on: nextStartOn,
    next_end_on: nextEndOn,
  };
}

export const sprintExtendOperation = implement(sprintExtend, async ({ db, actor, workspace, input }) => {
  const workspaceId = workspace.workspaceId;
  const organizationId = db.organizationId;
  const actorUserId = actorUserIdOf(actor);
  const conflict = (reason: string) => new ApiError(409, 'conflict', { reason });
  const read = () =>
    db.rows(
      db.statement((q) =>
        q
          .selectFrom('sprints')
          .select(['id', 'name', 'goal', 'status', 'start_on', 'end_on', 'extended_days'])
          .where('workspace_id', '=', workspaceId)
          .where('deleted_at', 'is', null)
          .orderBy('start_on')
          .orderBy('id'),
      ),
    );
  // 読んだ行から、延長する進行中のスプリントを決める。閉じたワークスペースは、行の状態より先に断る。
  // 進行中の最終日が画面の読んだ値と違えば、足さずに断る（やり直しの中でも同じ）
  const target = async (rows: readonly SprintRow[]): Promise<SprintRow> => {
    await throwIfClosed(db, workspaceId);
    const found = rows.find((row) => row.id === input.sprint_id);
    if (found === undefined) throw new ApiError(404, 'not_found');
    if (found.status !== 'active') throw conflict('not_active');
    if (found.end_on !== input.end_on) throw conflict('changed');
    if (sprintLengthOf(found.start_on, found.end_on) + input.days > SPRINT_MAX_LENGTH) {
      throw new ApiError(400, 'invalid_input');
    }
    return found;
  };

  let rows = await read();
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const current = await target(rows);
    const plan = sprintExtension(current, input.days, rows);
    if (plan === null) throw new ApiError(400, 'invalid_input');
    const writes: SprintExtensionWrite[] = [
      writeOf(current, current.start_on, plan.end_on),
      ...plan.shifted.map((shift) =>
        writeOf(
          rows.find((row) => row.id === shift.id)!,
          shift.start_on,
          shift.end_on,
        ),
      ),
    ];
    const at = now();
    const updatedAt = at.toISOString();
    const statements: Statement<'organization'>[] = [];
    for (const [index, write] of writes.entries()) {
      const extended = write.extended_days + input.days;
      const changes =
        index === 0
          ? { end_on: [write.end_on, write.next_end_on], extended_days: [write.extended_days, extended] }
          : { start_on: [write.start_on, write.next_start_on], end_on: [write.end_on, write.next_end_on] };
      statements.push(
        db.statement((q) => {
          const update = q
            .updateTable('sprints')
            .set({
              end_on: write.next_end_on,
              updated_at: updatedAt,
              ...(index === 0 ? { extended_days: extended } : { start_on: write.next_start_on }),
            })
            .where('workspace_id', '=', workspaceId)
            .where('id', '=', write.id)
            .where('status', '=', index === 0 ? 'active' : 'planned')
            .where('deleted_at', 'is', null)
            .where('start_on', 'is', write.start_on)
            .where('end_on', 'is', write.end_on)
            .where('extended_days', 'is', write.extended_days)
            .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId)));
          // 全対象の前提と重なりの検査は最初の文だけに置く。後ろの文は直前の文に結ぶ
          return index === 0
            ? update
                .where(sprintExtensionNoOverlap(workspaceId, writes))
                .where(sprintExtensionUnchanged(workspaceId, writes))
            : update.where(previousStatementChanged);
        }),
      );
      statements.push(
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
                  eb.val(write.id).as('entity_id'),
                  eb.val('update').as('action'),
                  eb.val(JSON.stringify(changes)).as('changes_json'),
                  eb.val(updatedAt).as('created_at'),
                ])
                .where(previousStatementChanged),
            ),
        ),
      );
    }
    const results = await db.batch(statements);
    if ((results[0]?.changes ?? 0) > 0) {
      return {
        sprint: summaryOf({ ...current, end_on: plan.end_on, extended_days: current.extended_days + input.days }),
        shifted: plan.shifted.map(({ id, name, start_on, end_on }) => ({ id, name, start_on, end_on })),
      };
    }
    rows = await read();
    const latest = await target(rows);
    // 古い読み取りとの重なりで誤って断らず、今の行で押し出しを計算し直す。それでも動かさない行と重なるなら overlap
    const retryPlan = sprintExtension(latest, input.days, rows);
    if (retryPlan !== null) {
      const next = [{ ...latest, end_on: retryPlan.end_on }, ...retryPlan.shifted];
      const ids = new Set(next.map((row) => row.id));
      if (
        next.some((row) =>
          rows.some((other) => !ids.has(other.id) && other.start_on <= row.end_on && other.end_on >= row.start_on),
        )
      ) {
        throw conflict('overlap');
      }
    }
  }
  throw conflict('changed');
});
