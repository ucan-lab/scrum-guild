// 運用者の組織の人数と添付ファイルの上限の変更（docs/data-model.md の「書き込みの単位」の上限の変更）。
// 共通の DB の organizations を、読んだ上限のままであることを条件にした UPDATE で書き、続けて組織の DB の change_logs に
// 運用者の操作として残す。2つは別の batch() で書く。履歴を書けなくても成功として返す。
// 運用者は組織の中に特権を持たない。応答に組織の中のデータを入れない
import { now } from '../../shared/clock.ts';
import { organizationQuotaUpdate } from '../../shared/operations/operator/index.ts';
import { commonDb } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { implement } from './implement.ts';
import { logOperatorChange } from './operator-change-log.ts';

type CommonDb = ReturnType<typeof commonDb>;

// slug の組織の今の上限。無ければ 404（別の組織と存在しないものを分けない）
async function readQuota(db: CommonDb, slug: string) {
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('organizations')
        .select(['id', 'member_limit', 'attachment_quota_bytes', 'attachment_quota_warned_at'])
        .where('slug', '=', slug),
    ),
  );
  if (row === undefined) throw new ApiError(404, 'not_found');
  return row;
}

// 順: 1. 組織を slug で引く（無ければ 404）。今の値が送った値と同じなら何も書かずに今の値を返す
// 2. 今の値が画面の見ていた前の値（expected）と違えば 409（ダイアログを開いた後に別の運用者が変えた）
// 3. organizations を、expected のままであることを条件に書く（読んだ後に別の運用者が先に変えて外れたら 409）。
//    添付ファイルの上限を上げたときだけ attachment_quota_warned_at を空に戻す（80% の通知をやり直す）。そのときは
//    通知の日時が読んだ値のままであることも条件にし、履歴の前の値と実際に消した値をそろえる。停止中の組織も変えられる
// 4. 組織の DB の change_logs に、変わった列だけの前後の値で残す（失敗しても成功として返す）
export const organizationQuotaUpdateOperation = implement(organizationQuotaUpdate, async ({ db, operator, input }) => {
  const current = await readQuota(db, input.slug);
  const memberLimitChanged = current.member_limit !== input.member_limit;
  const quotaChanged = current.attachment_quota_bytes !== input.attachment_quota_bytes;
  if (!memberLimitChanged && !quotaChanged) {
    return {
      slug: input.slug,
      member_limit: current.member_limit,
      attachment_quota_bytes: current.attachment_quota_bytes,
    };
  }
  const { expected } = input;
  if (
    current.member_limit !== expected.member_limit ||
    current.attachment_quota_bytes !== expected.attachment_quota_bytes
  ) {
    throw new ApiError(409, 'conflict');
  }

  const raised = input.attachment_quota_bytes > current.attachment_quota_bytes;
  const clearsWarning = raised && current.attachment_quota_warned_at !== null;
  const at = now();
  const [result] = await db.batch([
    db.statement((q) => {
      const update = q
        .updateTable('organizations')
        .set({
          member_limit: input.member_limit,
          attachment_quota_bytes: input.attachment_quota_bytes,
          ...(raised ? { attachment_quota_warned_at: null } : {}),
          updated_at: at.toISOString(),
        })
        .where('id', '=', current.id)
        .where('member_limit', '=', expected.member_limit)
        .where('attachment_quota_bytes', '=', expected.attachment_quota_bytes);
      if (!raised) return update;
      return current.attachment_quota_warned_at === null
        ? update.where('attachment_quota_warned_at', 'is', null)
        : update.where('attachment_quota_warned_at', '=', current.attachment_quota_warned_at);
    }),
  ]);
  if (result.changes === 0) throw new ApiError(409, 'conflict');

  const changes: Record<string, readonly [unknown, unknown]> = {};
  if (memberLimitChanged) changes.member_limit = [current.member_limit, input.member_limit];
  if (quotaChanged) changes.attachment_quota_bytes = [current.attachment_quota_bytes, input.attachment_quota_bytes];
  if (clearsWarning) changes.attachment_quota_warned_at = [current.attachment_quota_warned_at, null];
  await logOperatorChange(operator, {
    operation: organizationQuotaUpdate.name,
    organizationId: current.id,
    action: 'update',
    changes,
    at,
  });
  return { slug: input.slug, member_limit: input.member_limit, attachment_quota_bytes: input.attachment_quota_bytes };
});
