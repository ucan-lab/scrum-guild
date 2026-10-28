// 運用者の組織の停止、再開、停止の理由の切り替えの処理（docs/data-model.md の「書き込みの単位」の組織の停止と再開）。
// 共通の DB の organizations を、今の状態を条件にした UPDATE で書き、続けて組織の DB の change_logs に運用者の操作として残す。
// 2つは別の batch() で書く（共通の表と組織の中の表は1回の batch() に混ぜない）。履歴を書けなくても成功として返す。
// 運用者は組織の中に特権を持たない。応答に組織の中のデータを入れない
import { now } from '../../shared/clock.ts';
import {
  isPurgeDue,
  organizationResume,
  organizationSuspend,
  organizationSuspensionUpdate,
  purgeDateOf,
  utcDateOf,
  type SuspensionKind,
} from '../../shared/operations/operator/index.ts';
import { commonDb, purgeDueInDatabase, purgeNotDue } from '../db/index.ts';
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

// 停止中で、解約で消す予定日を過ぎた（消す手順が始まりうる）。再開と一時的な停止への切り替えを 409 の purge_due で断る
const purgeDue = (suspension: Suspension, at: Date): boolean =>
  suspension.suspended_at !== null && isPurgeDue(suspension.purge_on, at);

// 再開と停止の理由の切り替えの UPDATE に足す条件。消す予定日が無いか、Worker の now() の UTC の日付と D1 の date('now') の
// 両方で今日以降（src/server/db/purge-due.ts）。読んだ後に日付が変わって予定日を過ぎても、Worker と D1 の時計が UTC の 0 時を
// またいでずれても、ここで外れる。消す SQL のガード（purge_on < date('now')）が真の組織は、必ずこの条件で外れる
const notPurgeDue = (at: Date) => purgeNotDue(utcDateOf(at));

// UPDATE が条件に外れたときの 409。読み直して、消す予定日を Worker の日付か D1 の date('now') で過ぎていれば purge_due、
// そうでなければ別の運用者が先に操作していたので conflict
async function missed(db: CommonDb, slug: string, at: Date): Promise<ApiError> {
  const latest = await db.first(
    db.statement((q) =>
      q
        .selectFrom('organizations')
        .select(['suspended_at', 'purge_on', purgeDueInDatabase().as('due_in_database')])
        .where('slug', '=', slug),
    ),
  );
  if (latest === undefined) throw new ApiError(404, 'not_found');
  const due = latest.suspended_at !== null && (purgeDue(latest, at) || Number(latest.due_in_database) === 1);
  return new ApiError(409, due ? 'purge_due' : 'conflict');
}

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

// 停止した日時は変えず、消す予定日だけを書き換える。今と同じ理由への切り替えは 409 の conflict。
// 消す予定日を過ぎた解約から一時的な停止へは 409 の purge_due（予定日が空になり、消す SQL のガードが偽になるため）。
// 書く条件は、停止中で、読んだ消す予定日のままで、予定日を過ぎていない（別の運用者が先に切り替えていたら外れて 409）
export const organizationSuspensionUpdateOperation = implement(
  organizationSuspensionUpdate,
  async ({ db, operator, input }) => {
    const current = await readSuspension(db, input.slug);
    if (current.suspended_at === null || kindOf(current) === input.kind) throw new ApiError(409, 'conflict');

    const at = now();
    // 読んだ時点で過ぎていると分かれば、書き込みを送らずに断る（UPDATE の条件は、読んだ後に過ぎたときの守り）
    if (purgeDue(current, at)) throw new ApiError(409, 'purge_due');
    const purgeOn = input.kind === 'cancellation' ? purgeDateOf(at) : null;
    const [result] = await db.batch([
      db.statement((q) =>
        q
          .updateTable('organizations')
          .set({ purge_on: purgeOn, updated_at: at.toISOString() })
          .where('id', '=', current.id)
          .where('suspended_at', 'is not', null)
          .where('purge_on', 'is', current.purge_on)
          // 予定日の条件は、上の「読んだ purge_on のまま」と重なる（読んだ後に予定日を書き換えると両方で外れる）ので、
          // テストではこの条件だけを切り離して確かめられない。日付だけが変わったとき（purge_on はそのまま）に効く
          .where(notPurgeDue(at)),
      ),
    ]);
    if (result.changes === 0) throw await missed(db, input.slug, at);

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

// 解約で消す予定日を過ぎた組織は 409 の purge_due で断る（消している途中で戻すと、残りが消えないため）。予定日の当日までは再開できる。
// 書く条件は、読んだ停止の日時のままで、予定日を過ぎていない（読んだ後に日付が変わって過ぎても外れる）
export const organizationResumeOperation = implement(organizationResume, async ({ db, operator, input }) => {
  const current = await readSuspension(db, input.slug);
  if (current.suspended_at === null) throw new ApiError(409, 'conflict');

  const at = now();
  // 読んだ時点で過ぎていると分かれば、書き込みを送らずに断る（UPDATE の条件は、読んだ後に過ぎたときの守り）
  if (purgeDue(current, at)) throw new ApiError(409, 'purge_due');
  const after: Suspension = { suspended_at: null, purge_on: null };
  const [result] = await db.batch([
    db.statement((q) =>
      q
        .updateTable('organizations')
        .set({ ...after, updated_at: at.toISOString() })
        .where('id', '=', current.id)
        .where('suspended_at', '=', current.suspended_at)
        .where(notPurgeDue(at)),
    ),
  ]);
  if (result.changes === 0) throw await missed(db, input.slug, at);

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
