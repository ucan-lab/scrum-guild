// 運用者の組織の停止、再開、停止の理由の切り替えの処理（docs/data-model.md の「書き込みの単位」の組織の停止と再開）。
// 共通の DB の organizations を、今の状態を条件にした UPDATE で書き、続けて組織の DB の change_logs に運用者の操作として残す。
// 2つは別の batch() で書く（共通の表と組織の中の表は1回の batch() に混ぜない）。履歴を書けなくても成功として返す。
// 運用者は組織の中に特権を持たない。応答に組織の中のデータを入れない
import { now } from '../../shared/clock.ts';
import {
  organizationResume,
  organizationSuspend,
  organizationSuspensionUpdate,
  purgeDateOf,
  type SuspensionKind,
} from '../../shared/operations/operator/index.ts';
import { commonDb } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { implement } from './implement.ts';
import { logOperatorChange } from './operator-change-log.ts';

type CommonDb = ReturnType<typeof commonDb>;

// slug の組織の今の停止の状態。無ければ 404（別の組織と存在しないものを分けない）
async function readSuspension(db: CommonDb, slug: string) {
  const row = await db.first(
    db.statement((q) =>
      q.selectFrom('organizations').select(['id', 'suspended_at', 'purge_on']).where('slug', '=', slug),
    ),
  );
  if (row === undefined) throw new ApiError(404, 'not_found');
  return row;
}

type Suspension = { suspended_at: string | null; purge_on: string | null };

// 解約で停止した組織は消す予定日を持ち、一時的な停止は持たない
const kindOf = (suspension: Suspension): SuspensionKind =>
  suspension.purge_on === null ? 'temporary' : 'cancellation';

// 順: 1. 組織を slug で引く（無ければ 404、停止済みなら 409）  2. organizations を、停止していないことを条件に書く
// （同時に停止されて条件に外れたら 409）  3. 組織の DB の change_logs に残す（失敗しても成功として返す）
export const organizationSuspendOperation = implement(organizationSuspend, async ({ db, operator, input }) => {
  const current = await readSuspension(db, input.slug);
  if (current.suspended_at !== null) throw new ApiError(409, 'conflict');

  const at = now();
  const suspendedAt = at.toISOString();
  const after: Suspension = {
    suspended_at: suspendedAt,
    purge_on: input.kind === 'cancellation' ? purgeDateOf(at) : null,
  };
  const [result] = await db.batch([
    db.statement((q) =>
      q
        .updateTable('organizations')
        .set({ ...after, updated_at: suspendedAt })
        .where('id', '=', current.id)
        .where('suspended_at', 'is', null),
    ),
  ]);
  if (result.changes === 0) throw new ApiError(409, 'conflict');

  await logOperatorChange(operator, {
    operation: organizationSuspend.name,
    organizationId: current.id,
    action: 'suspend',
    changes: {
      suspended_at: [current.suspended_at, after.suspended_at],
      purge_on: [current.purge_on, after.purge_on],
    },
    at,
  });
  return { slug: input.slug, suspended_at: suspendedAt, purge_on: after.purge_on };
});

// 停止した日時は変えず、消す予定日だけを書き換える。今と同じ理由への切り替えは 409。
// 書く条件は、停止中で、読んだ消す予定日のまま（別の運用者が先に切り替えていたら外れて 409）
export const organizationSuspensionUpdateOperation = implement(
  organizationSuspensionUpdate,
  async ({ db, operator, input }) => {
    const current = await readSuspension(db, input.slug);
    if (current.suspended_at === null || kindOf(current) === input.kind) throw new ApiError(409, 'conflict');

    const at = now();
    const purgeOn = input.kind === 'cancellation' ? purgeDateOf(at) : null;
    const [result] = await db.batch([
      db.statement((q) =>
        q
          .updateTable('organizations')
          .set({ purge_on: purgeOn, updated_at: at.toISOString() })
          .where('id', '=', current.id)
          .where('suspended_at', 'is not', null)
          .where('purge_on', 'is', current.purge_on),
      ),
    ]);
    if (result.changes === 0) throw new ApiError(409, 'conflict');

    await logOperatorChange(operator, {
      operation: organizationSuspensionUpdate.name,
      organizationId: current.id,
      action: 'update',
      changes: { purge_on: [current.purge_on, purgeOn] },
      at,
    });
    return { slug: input.slug, purge_on: purgeOn };
  },
);

// 解約で消す予定日を過ぎていても、データを消すまでは再開できる（予定日は見ない）
export const organizationResumeOperation = implement(organizationResume, async ({ db, operator, input }) => {
  const current = await readSuspension(db, input.slug);
  if (current.suspended_at === null) throw new ApiError(409, 'conflict');

  const at = now();
  const after: Suspension = { suspended_at: null, purge_on: null };
  const [result] = await db.batch([
    db.statement((q) =>
      q
        .updateTable('organizations')
        .set({ ...after, updated_at: at.toISOString() })
        .where('id', '=', current.id)
        .where('suspended_at', '=', current.suspended_at),
    ),
  ]);
  if (result.changes === 0) throw new ApiError(409, 'conflict');

  await logOperatorChange(operator, {
    operation: organizationResume.name,
    organizationId: current.id,
    action: 'resume',
    changes: {
      suspended_at: [current.suspended_at, after.suspended_at],
      purge_on: [current.purge_on, after.purge_on],
    },
    at,
  });
  return { slug: input.slug };
});
