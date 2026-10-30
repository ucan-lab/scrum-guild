import { sql, type RawBuilder } from 'kysely';

export type SprintExtensionWrite = {
  id: string;
  status: string;
  start_on: string;
  end_on: string;
  extended_days: number;
  next_start_on: string;
  next_end_on: string;
};

// 最初の UPDATE に全対象の前提をまとめる。後続文の条件だけでは、途中まで書かれてしまう。
// JSON で渡し、押し出す件数が多くても D1 の bind 数の上限を超えない。
export function sprintExtensionUnchanged(
  workspaceId: string,
  writes: readonly SprintExtensionWrite[],
): RawBuilder<boolean> {
  return sql<boolean>`not exists (
    select 1 from json_each(${JSON.stringify(writes)}) as proposed
    left join sprints as original on original.workspace_id = ${workspaceId}
      and original.id = json_extract(proposed.value, '$.id')
    where original.id is null or original.deleted_at is not null
      or original.status is not json_extract(proposed.value, '$.status')
      or original.start_on is not json_extract(proposed.value, '$.start_on')
      or original.end_on is not json_extract(proposed.value, '$.end_on')
      or original.extended_days is not json_extract(proposed.value, '$.extended_days')
  )`;
}

// 動かす行の更新後の期間が、動かさない行（planned と closed）と重ならないことを確かめる。動かす行どうしは
// sprintExtension が前の行の翌日から並べるので重ならず、元の期間は sprintExtensionUnchanged が読んだ値のままと確かめる。
// 長さは28日までなので、重なりうる相手は「新しい開始日の27日前から新しい最終日まで」に始まる行だけ。開始日の範囲で
// (workspace_id, start_on) の部分索引を引き、押し出す件数とスプリントの数の積にしない。
// 最初の UPDATE にだけ置く。後続の UPDATE は previousStatementChanged で最初の文に結ばれ、同じ batch() の中は
// 別の要求に割り込まれないため、最初の文が通っていれば更新後の期間の重なりは無い。
export function sprintExtensionNoOverlap(
  workspaceId: string,
  writes: readonly SprintExtensionWrite[],
): RawBuilder<boolean> {
  const json = JSON.stringify(writes);
  return sql<boolean>`not exists (
    select 1 from json_each(${json}) as proposed
    join sprints as other on other.workspace_id = ${workspaceId} and other.deleted_at is null
      and other.start_on >= date(json_extract(proposed.value, '$.next_start_on'), '-27 days')
      and other.start_on <= json_extract(proposed.value, '$.next_end_on')
    where other.end_on >= json_extract(proposed.value, '$.next_start_on')
      and other.id not in (select json_extract(value, '$.id') from json_each(${json}))
  )`;
}
