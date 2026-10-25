// 運用者の組織の停止と再開の処理（docs/data-model.md の「書き込みの単位」の組織の停止と再開）。
// 共通の DB の organizations を、今の状態を条件にした UPDATE で書き、続けて組織の DB の change_logs に運用者の操作として残す。
// 2つは別の batch() で書く（共通の表と組織の中の表は1回の batch() に混ぜない）。履歴を書けなくても停止と再開は成功として返す。
// 運用者は組織の中に特権を持たない。応答に組織の中のデータを入れない
import { now } from '../../shared/clock.ts';
import { organizationResume, organizationSuspend, purgeDateOf } from '../../shared/operations/operator/index.ts';
import { commonDb } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import type { OperatorTools } from './operator-tools.ts';

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

// 停止と再開を、組織の変更の履歴に運用者の操作として残す。書けなくても投げず、組織の ID と例外の名前だけをログに残す
// （例外の message に SQL や接続の詳細が混ざりうる）。停止と再開は書けているので、履歴が欠けたことを運用者が知れるようにする
async function logSuspension(
  operator: OperatorTools,
  operation: string,
  organizationId: string,
  action: 'suspend' | 'resume',
  before: Suspension,
  after: Suspension,
  at: Date,
): Promise<void> {
  try {
    const db = await operator.openOrganization(organizationId);
    if (db === undefined) throw new Error('組織の行が無い');
    await db.batch([
      db.statement((q) =>
        q.insertInto('change_logs').values({
          id: uuidv7(at.getTime()),
          organization_id: db.organizationId,
          workspace_id: null,
          actor_user_id: null,
          operator: operator.loginId,
          entity_type: 'organization',
          entity_id: db.organizationId,
          action,
          changes_json: JSON.stringify({
            suspended_at: [before.suspended_at, after.suspended_at],
            purge_on: [before.purge_on, after.purge_on],
          }),
          created_at: at.toISOString(),
        }),
      ),
    ]);
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        code: 'internal',
        requestId: operator.requestId,
        operation,
        route: 'operator',
        reason: '組織の停止か再開は書けたが、変更の履歴を書けなかった',
        organizationId,
        error: err instanceof Error ? err.name : typeof err,
      }),
    );
  }
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

  await logSuspension(operator, organizationSuspend.name, current.id, 'suspend', current, after, at);
  return { slug: input.slug, suspended_at: suspendedAt, purge_on: after.purge_on };
});

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

  await logSuspension(operator, organizationResume.name, current.id, 'resume', current, after, at);
  return { slug: input.slug };
});
