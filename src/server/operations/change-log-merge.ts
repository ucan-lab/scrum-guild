// 書き始める前の値（expected）の照合と、続けて直した分の履歴のまとめ。task-update、story-update、epic-update が共通で使う
// （docs/data-model.md の「続けて直した分のまとめ」）。
// まとめは、悪い値を入れて元へ戻した痕跡を、続けて直して消せないようにする決まりを持つ。窓の起点は最初に書いた時刻で、
// 時計が戻ったとき、元の値へ戻す変更、間に別の履歴が挟まったときはまとめない。決まりは欄ごとに食い違わないよう、ここ1か所に置く
import { canonicalLinkUrl, linkUrlProblem, normalizeLinkUrl, normalizeLongText } from '../../shared/story.ts';
import {
  previousStatementChanged,
  type ExpressionBuilder,
  type OrganizationDb,
  type OrganizationTables,
} from '../db/index.ts';
import { uuidv7 } from '../uuid.ts';
import { changeLogColumns } from './write-guards.ts';

// 続けて直した分を1行にまとめる間。直前の履歴の行がこれより前なら、新しい行を足す
export const HISTORY_MERGE_WINDOW_MS = 5 * 60 * 1000;

// 履歴の changes_json の形。欄の名前ごとに [前, 後]
export type ChangeMap = Record<string, [unknown, unknown]>;

// 照合とまとめの対象にする欄と、その欄の値を比べる前に揃える関数。expected は入力の検証で正規化されて届くので、
// 正規化の決まりより前に保存された値（取り込み、seed、古い行）とも比べられるよう、今の値も同じに揃えて比べる。
// 欄ごとに関数を必ず書かせる（欄を足したら、正規化の要否を決める）。呼び出し側は欄の一覧（EDITABLE_FIELDS）に satisfies で結び、足し忘れを型で落とす
export type MergeFields<F extends string> = { [K in F]: (value: string) => unknown };

// 正規化の決まりが無い欄（期日、ポイントなど）
export const asIs = (value: string): unknown => value;
// 前後の空白を除く欄（タイトル）
export const trimmed = (value: string): unknown => value.trim();
// 長い文の欄（本文、受け入れ基準）
export const longText = (value: string): unknown => normalizeLongText(value);
// リンクの欄。正規化できない値はそのまま返す
export const linkUrl = (value: string): unknown => {
  const link = normalizeLinkUrl(value);
  return link === null || linkUrlProblem(link) !== null ? link : canonicalLinkUrl(link);
};

// 書き始める前の値（expected）が、サーバーの今の値と違う欄。書く欄だけを見る（送った値が今の値と同じなら、書かないので断らない）
export function staleFields<F extends string>(
  fields: MergeFields<F>,
  current: Record<NoInfer<F>, unknown>,
  values: Partial<Record<NoInfer<F>, unknown>>,
  expected: Partial<Record<NoInfer<F>, unknown>> | undefined,
): Record<string, unknown> {
  const stale: Record<string, unknown> = {};
  if (expected === undefined) return stale;
  for (const field of Object.keys(fields) as F[]) {
    if (values[field] === undefined || expected[field] === undefined) continue;
    const value = current[field];
    if (expected[field] !== (typeof value === 'string' ? fields[field](value) : value)) stale[field] = value;
  }
  return stale;
}

export type MergeTarget<F extends string> = {
  id: string;
  createdAt: string;
  changesJson: string;
  field: F;
  before: unknown;
};

// 直前の履歴の行（そのエンティティの最新の行）を、まとめてよいか決める。DB を読まない判定の本体
export type LatestChangeLog = {
  id: string;
  actor_user_id: string | null;
  action: string;
  changes_json: string;
  created_at: string;
};

export function mergeTargetOf<F extends string>(
  latest: LatestChangeLog | undefined,
  field: F,
  actorUserId: string,
  changes: ChangeMap,
  at: Date,
): MergeTarget<F> | undefined {
  if (latest === undefined || latest.action !== 'update' || latest.actor_user_id !== actorUserId) return undefined;
  // 間の起点は、行を最初に書いた時刻（ID の UUIDv7 の先頭48ビット）。まとめるたびに created_at を進めても間は延びない
  // （延びると、悪い値を入れて元へ戻した痕跡を、続けて直して消せてしまう）
  // ID が UUIDv7 でない行（seed、取り込み、古い行）は、先頭48ビットが時刻でないのでまとめない
  const idHex = latest.id.replaceAll('-', '');
  if (idHex.length !== 32 || idHex[12] !== '7') return undefined;
  const firstWrittenAt = Number.parseInt(idHex.slice(0, 12), 16);
  // 時計が戻っている（最初に書いた時刻より前）ときもまとめない（まとめると created_at が過去へ戻り、履歴の並びが実際の順と食い違う）
  const elapsed = at.getTime() - firstWrittenAt;
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > HISTORY_MERGE_WINDOW_MS) return undefined;
  // まとめるたびに created_at は進むので、最新の行の created_at より時計が戻っているときと、読めない日時のときもまとめない
  // （created_at が過去へ戻らないように）
  const latestAt = Date.parse(latest.created_at);
  if (Number.isNaN(latestAt) || at.getTime() < latestAt) return undefined;
  let logged: unknown;
  try {
    logged = JSON.parse(latest.changes_json);
  } catch {
    return undefined;
  }
  if (typeof logged !== 'object' || logged === null || Array.isArray(logged)) return undefined;
  const entries = Object.entries(logged);
  const pair = entries[0]?.[1];
  if (entries.length !== 1 || entries[0]?.[0] !== field || !Array.isArray(pair) || pair.length !== 2) return undefined;
  // 今の値と、履歴の「後」が合っているときだけ（合わなければ、間に別の経路が書いている）
  if (JSON.stringify(pair[1]) !== JSON.stringify(changes[field]?.[0])) return undefined;
  // 元の値へ戻す変更は、まとめると「前」と「後」が同じ行が残るので、まとめずに別の行にする
  if (JSON.stringify(pair[0]) === JSON.stringify(changes[field]?.[1])) return undefined;
  return { id: latest.id, createdAt: latest.created_at, changesJson: latest.changes_json, field, before: pair[0] };
}

// 履歴の対象。entityType は change_logs.entity_type の値
export type MergeEntity = { entityType: 'task' | 'story' | 'epic'; workspaceId: string; entityId: string };

// 履歴を足す代わりに書き換える行。同じ人が、同じエンティティで、同じ1つの欄だけを直した直前の行が、間の中にあるときだけ。
// 直前の行は、そのエンティティの最新の履歴の行（間に別の履歴が挟まっていればまとめない）。
// 2つ以上の欄の変更はまとめない。allowMerge が false（添付を足すときなど、履歴に欄の変更以外を残すとき）もまとめない
export async function readMergeTarget<F extends string>(
  db: OrganizationDb,
  fields: MergeFields<F>,
  entity: MergeEntity,
  actorUserId: string | null,
  changes: ChangeMap,
  at: Date,
  allowMerge = true,
): Promise<MergeTarget<F> | undefined> {
  const keys = Object.keys(changes);
  const field = (Object.keys(fields) as F[]).find((name) => name === keys[0]);
  if (actorUserId === null || !allowMerge || keys.length !== 1 || field === undefined) return undefined;
  const latest = await db.first(
    db.statement((q) =>
      q
        .selectFrom('change_logs')
        .select(['id', 'actor_user_id', 'action', 'changes_json', 'created_at'])
        .where('organization_id', '=', db.organizationId)
        .where('workspace_id', '=', entity.workspaceId)
        .where('entity_type', '=', entity.entityType)
        .where('entity_id', '=', entity.entityId)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1),
    ),
  );
  return mergeTargetOf(latest, field, actorUserId, changes, at);
}

// 主文の更新の条件に足す。まとめる行が、読んだときのまま、かつ、まだこのエンティティの最新の履歴の行であること
// （変わっていたら何も書かず、呼び出し側が読み直してやり直す）。まとめない（undefined）ときは条件を足さない
export function mergeTargetConditions<DB, TB extends keyof DB>(
  builder: ExpressionBuilder<DB, TB>,
  organizationId: string,
  entity: MergeEntity,
  target: MergeTarget<string> | undefined,
) {
  if (target === undefined) return [];
  // 呼び出し元の UPDATE は表（tasks、stories、epics）ごとに型が違うので、副問い合わせに使う change_logs の型へ揃える
  // （task-field.ts の unfilledExists と同じ。3つの呼び出し元とも組織の表の UPDATE の中）
  const eb = builder as unknown as ExpressionBuilder<OrganizationTables, never>;
  return [
    // まとめる行が、読んだときのまま
    eb.exists(
      eb
        .selectFrom('change_logs')
        .select('change_logs.id')
        .where('change_logs.id', '=', target.id)
        .where('change_logs.organization_id', '=', organizationId)
        .where('change_logs.changes_json', '=', target.changesJson),
    ),
    // その行が、まだこのエンティティの最新の履歴の行（読んだ後に別の行が挟まっていない）
    eb.not(
      eb.exists(
        eb
          .selectFrom('change_logs')
          .select('change_logs.id')
          .where('change_logs.organization_id', '=', organizationId)
          .where('change_logs.entity_type', '=', entity.entityType)
          .where('change_logs.entity_id', '=', entity.entityId)
          .where((newer) =>
            newer.or([
              newer('change_logs.created_at', '>', target.createdAt),
              newer.and([
                newer('change_logs.created_at', '=', target.createdAt),
                newer('change_logs.id', '>', target.id),
              ]),
            ]),
          ),
      ),
    ),
  ];
}

// 主文の更新の直後に並べる、履歴の文。直前の更新が行を変えたときだけ書く（負けた要求は、止めた時計で同じ値を書いていても、履歴を書かない）。
// まとめる行があれば（同じ人が数分以内に同じ欄だけを続けて直した）、行を足さずにその行の「後」の値と時刻を書き換える（「前」は最初のまま）。
// まとめる行が読んだときのままであることは、主文の条件（mergeTargetConditions）に入れてあるので、主文が通った後のこの文は必ず当たる。
// extraChanges は、足す行にだけ書く欄の変更以外の記録（添付など。まとめるときは入れない）
export function changeLogStatement<F extends string>(
  db: OrganizationDb,
  entity: MergeEntity,
  input: {
    actorUserId: string | null;
    at: Date;
    changes: ChangeMap;
    extraChanges?: Record<string, unknown>;
    mergeTarget: MergeTarget<F> | undefined;
  },
) {
  const organizationId = db.organizationId;
  const updatedAt = input.at.toISOString();
  const mergeTarget = input.mergeTarget;
  if (mergeTarget !== undefined) {
    return db.statement((q) =>
      q
        .updateTable('change_logs')
        .set({
          changes_json: JSON.stringify({
            [mergeTarget.field]: [mergeTarget.before, input.changes[mergeTarget.field]?.[1]],
          }),
          created_at: updatedAt,
        })
        .where('id', '=', mergeTarget.id)
        .where('organization_id', '=', organizationId)
        .where(previousStatementChanged),
    );
  }
  return db.statement((q) =>
    q
      .insertInto('change_logs')
      .columns(changeLogColumns)
      .expression(
        q
          .selectNoFrom((eb) => [
            eb.val(uuidv7(input.at)).as('id'),
            eb.val(organizationId).as('organization_id'),
            eb.val(entity.workspaceId).as('workspace_id'),
            eb.val(input.actorUserId).as('actor_user_id'),
            eb.val(entity.entityType).as('entity_type'),
            eb.val(entity.entityId).as('entity_id'),
            eb.val('update').as('action'),
            eb.val(JSON.stringify({ ...input.changes, ...input.extraChanges })).as('changes_json'),
            eb.val(updatedAt).as('created_at'),
          ])
          .where(previousStatementChanged),
      ),
  );
}
