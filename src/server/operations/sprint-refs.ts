// タスクが入っているスプリントの値。バックログの木の行とタスクの詳細が返す形（sprintRefSchema）と、変更の履歴に残す形（{id, name}）
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

// 変更の履歴（{"sprint": [前, 後]}）に残す値。名前が空のスプリントは、期間（YYYY-MM-DD〜YYYY-MM-DD）を名前にする
// （履歴は残したときの名前を出し、後から名前を付けても書き換えないため。SQL の側は db/json-list.ts の sprintLogRefSql）
export function sprintLogRef(sprint: { id: string; name: string | null; start_on: string; end_on: string }): {
  id: string;
  name: string;
} {
  return { id: sprint.id, name: sprint.name ?? `${sprint.start_on}〜${sprint.end_on}` };
}
