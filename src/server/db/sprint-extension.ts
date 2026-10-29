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

// 動かす行は更新後の期間に置き換えて比較する。動かさない planned と closed も検査する。
// 最初の文と後続の UPDATE で同じ式を使える（途中で書き換わった行も更新後の値で見る）。
export function sprintExtensionNoOverlap(
  workspaceId: string,
  writes: readonly SprintExtensionWrite[],
): RawBuilder<boolean> {
  const json = JSON.stringify(writes);
  return sql<boolean>`not exists (
    select 1 from json_each(${json}) as proposed
    join sprints as other on other.workspace_id = ${workspaceId} and other.deleted_at is null
      and other.id != json_extract(proposed.value, '$.id')
    left join json_each(${json}) as replacement on json_extract(replacement.value, '$.id') = other.id
    where coalesce(json_extract(replacement.value, '$.next_start_on'), other.start_on) <= json_extract(proposed.value, '$.next_end_on')
      and coalesce(json_extract(replacement.value, '$.next_end_on'), other.end_on) >= json_extract(proposed.value, '$.next_start_on')
  )`;
}
