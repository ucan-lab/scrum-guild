import { now } from '../../shared/clock.ts';
import { XP_EPIC_REWARD, type EpicRewardTier } from '../../shared/experience.ts';
import { epicRequesterUpdate, epicRewardUpdate } from '../../shared/operations/epic/index.ts';
import { previousStatementChanged, type OrganizationDb } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import {
  activeMemberName,
  actorUserIdOf,
  changeLogColumns,
  isLeaderOrAdmin,
  openWorkspace,
  throwIfClosed,
} from './write-guards.ts';

// エピックのクリア報酬の段階と依頼主の変更（docs/data-model.md の epics と「書き込みの単位」）。
// 書き方は討伐隊の割り振り（epic-party.ts）と同じで、読んで断る順を決め、書く文は読んだ値を条件にした UPDATE と、
// 直前の文が行を変えたときだけ入れる履歴にする。通らなければ読み直して決め直す

// 同時の書き込みに負けたときにやり直す回数の上限。超えたら 409 の conflict（epic-party と同じ）
const MAX_ATTEMPTS = 3;

// エピックの現在の欄。同じワークスペースの削除していないもの（クリアと中止も含む）。
// 依頼主の名前は履歴の「前」に使う。組織で絞った users から読む
async function readEpic(db: OrganizationDb, workspaceId: string, epicId: string) {
  const row = await db.first(
    db.statement((q) =>
      q
        .selectFrom('epics')
        .innerJoin('users as requester', (join) =>
          join
            .onRef('requester.id', '=', 'epics.requester_user_id')
            .on('requester.organization_id', '=', db.organizationId),
        )
        .select([
          'epics.reward_tier',
          'epics.requester_user_id',
          'epics.completed_at',
          'epics.canceled_at',
          'requester.name as requester_name',
        ])
        .where('epics.id', '=', epicId)
        .where('epics.workspace_id', '=', workspaceId)
        .where('epics.deleted_at', 'is', null),
    ),
  );
  if (row === undefined) return undefined;
  return {
    // 列の CHECK が守る値
    rewardTier: row.reward_tier as EpicRewardTier,
    requesterUserId: row.requester_user_id,
    requesterName: row.requester_name,
    finished: row.completed_at !== null || row.canceled_at !== null,
  };
}

// 履歴の1行。直前の文が行を変えたときだけ入れる
function logStatement(
  db: OrganizationDb,
  params: { workspaceId: string; actorUserId: string; epicId: string; at: Date; changes: Record<string, unknown> },
) {
  const { workspaceId, actorUserId, epicId, at, changes } = params;
  const organizationId = db.organizationId;
  return db.statement((q) =>
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
            eb.val('epic').as('entity_type'),
            eb.val(epicId).as('entity_id'),
            eb.val('update').as('action'),
            eb.val(JSON.stringify(changes)).as('changes_json'),
            eb.val(at.toISOString()).as('created_at'),
          ])
          .where(previousStatementChanged),
      ),
  );
}

// 読んで断る順は、エピックが無い（404）、権限が足りない（403）、終わったエピック（409）。
// 今と同じ段階なら何も書かない（閉じたワークスペースは断る）。書く文の条件は、同じワークスペースの進行中のエピック、
// 閉じていないワークスペース、読んだ段階のまま、リーダー（管理者を含む）でなければ依頼主のまま。
// 通らなかったら、閉じていれば 409 の workspace_closed、そうでなければ読み直して上の順で決め直す
export const epicRewardUpdateOperation = implement(epicRewardUpdate, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const epicId = input.epic_id;
  const next = input.reward_tier;
  const leader = isLeaderOrAdmin(actor, workspace);
  const output = { changed: false, reward_tier: next, reward_xp: XP_EPIC_REWARD[next] };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const epic = await readEpic(db, workspaceId, epicId);
    if (epic === undefined) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(404, 'not_found');
    }
    if (!leader && epic.requesterUserId !== actorUserId) throw new ApiError(403, 'forbidden');
    if (epic.finished) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(409, 'epic_finished');
    }
    if (epic.rewardTier === next) {
      // 同じ段階なら何も書かない。書くものが無くても、閉じたワークスペースは断る
      await throwIfClosed(db, workspaceId);
      return output;
    }

    const at = now();
    const results = await db.batch([
      db.statement((q) =>
        q
          .updateTable('epics')
          .set({ reward_tier: next, updated_at: at.toISOString() })
          .where('id', '=', epicId)
          .where('workspace_id', '=', workspaceId)
          .where('deleted_at', 'is', null)
          .where('completed_at', 'is', null)
          .where('canceled_at', 'is', null)
          // 読んだ段階のまま（履歴の「前」がずれないように）
          .where('reward_tier', '=', epic.rewardTier)
          .$if(!leader, (qb) => qb.where('requester_user_id', '=', actorUserId))
          .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId))),
      ),
      logStatement(db, {
        workspaceId,
        actorUserId,
        epicId,
        at,
        changes: { reward_tier: [epic.rewardTier, next] },
      }),
    ]);
    if ((results[0]?.changes ?? 0) > 0) return { ...output, changed: true };
    await throwIfClosed(db, workspaceId);
  }
  throw new ApiError(409, 'conflict');
});

// リーダー（管理者を含む）でない人（依頼主も）は、権限の種類 leader が登録の関数で 403 にする。
// 読んで断る順は、エピックが無い（404）、替え先が入れる人でない（404）、終わったエピック（409）。今と同じ依頼主なら何も書かない（閉じたワークスペースは断る）。
// 書く文の条件は、同じワークスペースの進行中のエピック、閉じていないワークスペース、読んだ依頼主のまま、替え先が入れる人であること。
// 通らなかったら、閉じていれば 409 の workspace_closed、そうでなければ読み直して上の順で決め直す。
// 新しい依頼主を討伐隊へ加えず、前の依頼主も外さない
export const epicRequesterUpdateOperation = implement(epicRequesterUpdate, async ({ db, actor, workspace, input }) => {
  const actorUserId = actorUserIdOf(actor);
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  const epicId = input.epic_id;
  const userId = input.user_id;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const epic = await readEpic(db, workspaceId, epicId);
    const active = await db.first(db.statement((q) => activeMemberName(q, organizationId, workspaceId, userId)));
    if (epic === undefined) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(404, 'not_found');
    }
    if (active === undefined) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(404, 'not_found');
    }
    if (epic.finished) {
      await throwIfClosed(db, workspaceId);
      throw new ApiError(409, 'epic_finished');
    }
    const requester = { id: userId, name: active.name, left: false };
    if (epic.requesterUserId === userId) {
      // 同じ依頼主なら何も書かない。書くものが無くても、閉じたワークスペースは断る
      await throwIfClosed(db, workspaceId);
      return { changed: false, requester };
    }

    const at = now();
    const results = await db.batch([
      db.statement((q) =>
        q
          .updateTable('epics')
          .set({ requester_user_id: userId, updated_at: at.toISOString() })
          .where('id', '=', epicId)
          .where('workspace_id', '=', workspaceId)
          .where('deleted_at', 'is', null)
          .where('completed_at', 'is', null)
          .where('canceled_at', 'is', null)
          // 読んだ依頼主のまま（履歴の「前」がずれないように）
          .where('requester_user_id', '=', epic.requesterUserId)
          .where((eb) =>
            eb.and([
              eb.exists(openWorkspace(q, organizationId, workspaceId)),
              eb.exists(activeMemberName(q, organizationId, workspaceId, userId)),
            ]),
          ),
      ),
      logStatement(db, {
        workspaceId,
        actorUserId,
        epicId,
        at,
        changes: {
          requester: [
            { id: epic.requesterUserId, name: epic.requesterName },
            { id: userId, name: active.name },
          ],
        },
      }),
    ]);
    if ((results[0]?.changes ?? 0) > 0) return { changed: true, requester };
    await throwIfClosed(db, workspaceId);
  }
  throw new ApiError(409, 'conflict');
});
