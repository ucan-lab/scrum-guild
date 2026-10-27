// タスクが入っているスプリントの値。バックログの木の行とタスクの詳細が返す形（sprintRefSchema）。
// 変更の履歴に残す形（{id, name}）は、書くときの今の名前を SQL の中で引く（db/json-list.ts の sprintLogRefSql）
import type { SprintRef } from '../../shared/operations/sprint/index.ts';

// 結んだ sprints の列（別名は sprints）。select に並べる
export const sprintRefColumns = [
  'sprints.id as sprint_ref_id',
  'sprints.name as sprint_ref_name',
  'sprints.start_on as sprint_ref_start_on',
  'sprints.end_on as sprint_ref_end_on',
] as const;

export type SprintRefRow = {
  sprint_ref_id: string | null;
  sprint_ref_name: string | null;
  sprint_ref_start_on: string | null;
  sprint_ref_end_on: string | null;
};

export function sprintRefOf(row: SprintRefRow): SprintRef | null {
  if (row.sprint_ref_id === null || row.sprint_ref_start_on === null || row.sprint_ref_end_on === null) return null;
  return {
    id: row.sprint_ref_id,
    name: row.sprint_ref_name,
    start_on: row.sprint_ref_start_on,
    end_on: row.sprint_ref_end_on,
  };
}
