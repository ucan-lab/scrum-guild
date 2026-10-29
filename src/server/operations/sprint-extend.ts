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
import { summaryOf } from './sprint.ts';
import { actorUserIdOf, changeLogColumns, openWorkspace, throwIfClosed } from './write-guards.ts';

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
          .selectAll()
          .where('workspace_id', '=', workspaceId)
          .where('deleted_at', 'is', null)
          .orderBy('start_on')
          .orderBy('id'),
      ),
    );

  for (let attempt = 0; attempt < 3; attempt++) {
    const rows = await read();
    const current = rows.find((row) => row.id === input.sprint_id);
    if (current === undefined) throw new ApiError(404, 'not_found');
    if (current.status !== 'active') throw conflict('not_active');
    await throwIfClosed(db, workspaceId);
    if (sprintLengthOf(current.start_on, current.end_on) + input.days > SPRINT_MAX_LENGTH) {
      throw new ApiError(400, 'invalid_input');
    }
    const plan = sprintExtension(current, input.days, rows);
    if (plan === null) throw new ApiError(400, 'invalid_input');
    const writes: SprintExtensionWrite[] = [
      { ...current, next_start_on: current.start_on, next_end_on: plan.end_on },
      ...plan.shifted.map((shift) => ({
        ...rows.find((row) => row.id === shift.id)!,
        next_start_on: shift.start_on,
        next_end_on: shift.end_on,
      })),
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
        db.statement((q) =>
          q
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
            .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId)))
            .where(sprintExtensionNoOverlap(workspaceId, writes))
            .where(index === 0 ? sprintExtensionUnchanged(workspaceId, writes) : previousStatementChanged),
        ),
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
        shifted: plan.shifted,
      };
    }
    const reread = await read();
    const latest = reread.find((row) => row.id === input.sprint_id);
    if (latest === undefined) throw new ApiError(404, 'not_found');
    if (latest.status !== 'active') throw conflict('not_active');
    await throwIfClosed(db, workspaceId);
    // 古い予告との重なりで誤って断らず、今の行で押し出しを計算し直す。
    const retryPlan = sprintExtension(latest, input.days, reread);
    if (retryPlan !== null) {
      const next = [{ ...latest, end_on: retryPlan.end_on }, ...retryPlan.shifted];
      const ids = new Set(next.map((row) => row.id));
      if (
        next.some((row) =>
          reread.some((other) => !ids.has(other.id) && other.start_on <= row.end_on && other.end_on >= row.start_on),
        )
      ) {
        throw conflict('overlap');
      }
    }
  }
  throw conflict('changed');
});
