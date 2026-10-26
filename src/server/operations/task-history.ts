import {
  TASK_HISTORY_PAGE_SIZE,
  taskHistory,
  type TaskHistoryEntry,
  type TaskHistoryValue,
} from '../../shared/operations/task/index.ts';
import type { OrganizationDb } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { implement } from './implement.ts';

// タスクの変更の履歴（task-history）。change_logs を entity_type = 'task'、entity_id、organization_id、workspace_id で絞り、
// 新しい順に 1 回 50 件まで読む。続きがあるかを知るため、1 件多く読む

type Cursor = { created_at: string; id: string };

// 履歴の行を読む文。索引 change_logs_entity（entity_type, entity_id, created_at）に乗る。
// 続きは (created_at, id) < before で読む（created_at が同じ行は id の降順で切る）。続きの条件は索引の範囲にせず、
// そのタスクの行（entity_type, entity_id で引く範囲）の中で絞る。1件のタスクの履歴は多くても数百行で、
// created_at の範囲を書き足すと、SQLite が organization_id や workspace_id の索引を選び、組織やワークスペースの全履歴を読むため。
// 本文（body_md）は長いので、DB の側で値を [null, null] に置き換えてから読む（欄の名前と並びは残る。全文を Worker へ運ばない）。
// 変えた人の名前は、組織で絞った users の今の名前
export function taskHistoryStatement(db: OrganizationDb, workspaceId: string, taskId: string, before?: Cursor) {
  const organizationId = db.organizationId;
  return db.statement((q) =>
    q
      .selectFrom('change_logs')
      .leftJoin('users as actor', (join) =>
        join.onRef('actor.id', '=', 'change_logs.actor_user_id').on('actor.organization_id', '=', organizationId),
      )
      .select((eb) => [
        'change_logs.id',
        'change_logs.action',
        'change_logs.created_at',
        eb
          .case()
          .when(eb.fn('json_type', ['change_logs.changes_json', eb.val('$.body_md')]), 'is not', null)
          .then(
            eb.fn<string>('json_set', [
              'change_logs.changes_json',
              eb.val('$.body_md'),
              eb.fn('json', [eb.val('[null,null]')]),
            ]),
          )
          .else(eb.ref('change_logs.changes_json'))
          .end()
          .as('changes_json'),
        'change_logs.actor_user_id',
        'actor.name as actor_name',
      ])
      .where('change_logs.entity_type', '=', 'task')
      .where('change_logs.entity_id', '=', taskId)
      .where('change_logs.organization_id', '=', organizationId)
      .where('change_logs.workspace_id', '=', workspaceId)
      .$if(before !== undefined, (qb) =>
        qb.where((eb) =>
          eb.or([
            eb('change_logs.created_at', '<', before!.created_at),
            eb.and([eb('change_logs.created_at', '=', before!.created_at), eb('change_logs.id', '<', before!.id)]),
          ]),
        ),
      )
      .orderBy('change_logs.created_at', 'desc')
      .orderBy('change_logs.id', 'desc')
      .limit(TASK_HISTORY_PAGE_SIZE + 1),
  );
}

// 欄ごとの値の形。人、親、区分、リポジトリは { id, name }（親のストーリーは { id, title } で残っている）
const TEXT_FIELDS = new Set(['title', 'link_url', 'due_on', 'today_on', 'completed_at', 'deleted_at']);
const NUMBER_FIELDS = new Set(['points']);
const NAMED_FIELDS = new Set(['assignee', 'completed_by', 'story', 'category', 'repository']);

// ID があれば、名前が読めなくても（空、ストーリーのタイトルが null）値を落とさず、名前を空で返す（画面は「不明」と出す）
function namedValue(value: unknown): TaskHistoryValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string') return null;
  const name = typeof record.name === 'string' ? record.name : typeof record.title === 'string' ? record.title : '';
  return { id: record.id, name };
}

// 1つの値を、欄の形にそろえる。形の合わない値は null にする（欄は落とさない）
function valueOf(field: string, value: unknown): TaskHistoryValue {
  if (value === null) return null;
  if (TEXT_FIELDS.has(field)) return typeof value === 'string' ? value : null;
  if (NUMBER_FIELDS.has(field)) return typeof value === 'number' && Number.isFinite(value) ? value : null;
  if (NAMED_FIELDS.has(field)) return namedValue(value);
  // 本文（body_md）は長いので値を返さない。知らない欄も値を返さず、欄の名前だけを返す
  return null;
}

// changes_json（{"列": [前, 後]}）を、保存した順の { field, before, after } にする。
// 読めない JSON とオブジェクトでない値は、変更なしとして扱う
export function changesOf(changesJson: string): TaskHistoryEntry['changes'] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(changesJson);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
  return Object.entries(parsed as Record<string, unknown>).map(([field, pair]) => {
    if (!Array.isArray(pair) || pair.length !== 2) return { field, before: null, after: null };
    return { field, before: valueOf(field, pair[0]), after: valueOf(field, pair[1]) };
  });
}

export const taskHistoryOperation = implement(taskHistory, async ({ db, workspace, input }) => {
  const organizationId = db.organizationId;
  const workspaceId = workspace.workspaceId;
  // タスクの確かめと履歴の読みを並べて送る（引き出しを開くたびに読むので、待つ時間を1往復ぶんにする）。
  // 404 のときは履歴の文も走るが、組織とワークスペースで絞っていて、結果は捨てる
  const [task, rows] = await Promise.all([
    // タスクがそのワークスペースにあるか（削除したものは画面から隠すので 404）と、時刻を出すワークスペースのタイムゾーン
    db.first(
      db.statement((q) =>
        q
          .selectFrom('tasks')
          .innerJoin('workspaces', 'workspaces.id', 'tasks.workspace_id')
          .select(['tasks.id', 'workspaces.timezone'])
          .where('tasks.id', '=', input.task_id)
          .where('tasks.workspace_id', '=', workspaceId)
          .where('tasks.deleted_at', 'is', null)
          .where('workspaces.organization_id', '=', organizationId),
      ),
    ),
    db.rows(taskHistoryStatement(db, workspaceId, input.task_id, input.before)),
  ]);
  if (task === undefined) throw new ApiError(404, 'not_found');

  const page = rows.slice(0, TASK_HISTORY_PAGE_SIZE);
  const last = page.at(-1);
  return {
    entries: page.map((row) => ({
      id: row.id,
      action: row.action,
      created_at: row.created_at,
      // actor_user_id があっても、組織で絞った users に名前が無ければ（別の組織の人を指す壊れた行）null にする
      actor:
        row.actor_user_id !== null && row.actor_name !== null ? { id: row.actor_user_id, name: row.actor_name } : null,
      changes: changesOf(row.changes_json),
    })),
    next:
      rows.length > TASK_HISTORY_PAGE_SIZE && last !== undefined ? { created_at: last.created_at, id: last.id } : null,
    timezone: task.timezone,
  };
});
