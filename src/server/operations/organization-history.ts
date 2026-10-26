// 組織の変更の履歴（docs/data-model.md の change_logs の「組織の変更の履歴」）。管理者だけが読む。
// 出す行は、ワークスペースの外の行（workspace_id が空）と、ワークスペースの作成、終了、再開の行。所属や招待など、
// ワークスペースの中の行は出さない。changes_json はそのまま返さず、種類ごとに画面の文に要る値だけを取り出す
import { WAITING_USER_NAME_IN_LOG } from '../../shared/claim-token.ts';
import {
  ORGANIZATION_HISTORY_PAGE_SIZE,
  organizationHistory,
} from '../../shared/operations/organization/organization-history.ts';
import type { OutputOf } from '../../shared/operations/define.ts';
import { implement } from './implement.ts';

type Entry = OutputOf<typeof organizationHistory>['entries'][number];
type HistoryEvent = Entry['event'];

// 組織の単位で出す、ワークスペースの行の action
const WORKSPACE_ACTIONS = ['create', 'close', 'reopen'] as const;

type HistoryRow = {
  entity_type: string;
  action: string;
  changes_json: string;
  // users の今の名前。login_subject の無い行（Google の招待でログインを待つ行。name はメールアドレス）は null にして読む
  entity_user_name: string | null;
  workspace_name: string | null;
};

type Changes = Record<string, unknown>;

function parseChanges(json: string): Changes {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Changes) : {};
  } catch {
    return {};
  }
}

// `{"列名": [前, 後]}` の前と後。形が違えば undefined
function pairOf(changes: Changes, column: string): readonly [unknown, unknown] | undefined {
  const value = changes[column];
  return Array.isArray(value) && value.length === 2 ? [value[0], value[1]] : undefined;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

// 記録にそのときの名前があればそれを、無ければ（ログインを待つ行の仮の名前を含む）users の今の名前
function personName(changes: Changes, row: HistoryRow): string | null {
  const logged = textOrNull(pairOf(changes, 'name')?.[1]);
  return logged !== null && logged !== WAITING_USER_NAME_IN_LOG ? logged : row.entity_user_name;
}

function userEvent(action: string, changes: Changes, row: HistoryRow): HistoryEvent {
  const isAdmin = pairOf(changes, 'is_admin');
  const disabledAt = pairOf(changes, 'disabled_at');
  // 運用者の指名（users の作成）。Google の招待は、ログインするまで名前が分からない
  if (action === 'create') {
    return isAdmin?.[1] === 1 ? { kind: 'admin_designated', name: personName(changes, row) } : { kind: 'other' };
  }
  if (action !== 'update') return { kind: 'other' };
  // Google の招待で指名した人の初めてのログイン（待つ行に sub を埋めた）
  if (pairOf(changes, 'login_subject') !== undefined) {
    return { kind: 'admin_login_linked', name: personName(changes, row) };
  }
  // Google の招待で指名した人が、同じ組織に既にいた（その人を管理者にして無効を解いた）
  if (isAdmin?.[1] === 1 && disabledAt !== undefined) {
    return { kind: 'admin_designation_merged', name: row.entity_user_name };
  }
  if (isAdmin !== undefined && disabledAt === undefined) {
    if (isAdmin[1] === 1) return { kind: 'admin_designated', name: row.entity_user_name };
    if (isAdmin[0] === 1) return { kind: 'admin_revoked', name: row.entity_user_name };
  }
  if (disabledAt !== undefined && isAdmin === undefined) {
    if (disabledAt[0] === null && disabledAt[1] !== null) return { kind: 'user_disabled', name: row.entity_user_name };
    if (disabledAt[0] !== null && disabledAt[1] === null) return { kind: 'user_enabled', name: row.entity_user_name };
  }
  return { kind: 'other' };
}

function organizationEvent(action: string, changes: Changes): HistoryEvent {
  switch (action) {
    case 'create':
      return { kind: 'organization_created', name: textOrNull(pairOf(changes, 'name')?.[1]) };
    case 'suspend':
      return { kind: 'organization_suspended', purge_on: textOrNull(pairOf(changes, 'purge_on')?.[1]) };
    case 'resume':
      return { kind: 'organization_resumed' };
    case 'update': {
      const purgeOn = pairOf(changes, 'purge_on');
      if (purgeOn !== undefined) return { kind: 'organization_suspension_changed', purge_on: textOrNull(purgeOn[1]) };
      if ('vocabulary' in changes || 'theme' in changes) return { kind: 'organization_settings_changed' };
      return { kind: 'other' };
    }
    default:
      return { kind: 'other' };
  }
}

function workspaceEvent(action: string, changes: Changes, row: HistoryRow): HistoryEvent {
  switch (action) {
    case 'create':
      return {
        kind: 'workspace_created',
        workspace_name: textOrNull(pairOf(changes, 'name')?.[1]) ?? row.workspace_name,
      };
    case 'close':
      return { kind: 'workspace_closed', workspace_name: row.workspace_name };
    case 'reopen':
      return { kind: 'workspace_reopened', workspace_name: row.workspace_name };
    default:
      return { kind: 'other' };
  }
}

// entity_type と action（と changes_json の列）の組を、画面の文の種類にする。知らない組は other
export function historyEvent(row: HistoryRow): HistoryEvent {
  const changes = parseChanges(row.changes_json);
  switch (row.entity_type) {
    case 'organization':
      return organizationEvent(row.action, changes);
    case 'user':
      return userEvent(row.action, changes, row);
    case 'workspace':
      return workspaceEvent(row.action, changes, row);
    default:
      return { kind: 'other' };
  }
}

// 1回に PAGE_SIZE + 1 行を読み、余った1行で続きがあるかを決める。並びは created_at と id の新しい順で、同じ日時は id で決める。
// 索引 change_logs_organization (organization_id, created_at) を、組織の等号と created_at <= カーソルの範囲で使う
// （同じ日時の中の id の並べ替えだけが、索引の外の小さな並べ替えになる）。
// した人と対象の名前は、同じ文で users と workspaces を組織で絞って結んで引く（どちらも組織の中の表）
export const organizationHistoryOperation = implement(organizationHistory, async ({ db, input }) => {
  const before = input.before ?? null;
  const organizationId = db.organizationId;
  const rows = await db.rows(
    db.statement((q) =>
      q
        .selectFrom('change_logs as cl')
        .leftJoin('users as au', (join) =>
          join.onRef('au.id', '=', 'cl.actor_user_id').on('au.organization_id', '=', organizationId),
        )
        .leftJoin('users as eu', (join) =>
          join
            .onRef('eu.id', '=', 'cl.entity_id')
            .on('cl.entity_type', '=', 'user')
            .on('eu.organization_id', '=', organizationId),
        )
        .leftJoin('workspaces as w', (join) =>
          join
            .onRef('w.id', '=', 'cl.entity_id')
            .on('cl.entity_type', '=', 'workspace')
            .on('w.organization_id', '=', organizationId),
        )
        .select((eb) => [
          'cl.id',
          'cl.created_at',
          'cl.entity_type',
          'cl.action',
          'cl.changes_json',
          'cl.actor_user_id',
          // 運用者のログインの ID は読まず、運用者の操作かどうかだけを読む
          eb('cl.operator', 'is not', null).as('by_operator'),
          eb.case().when('au.login_subject', 'is not', null).then(eb.ref('au.name')).else(null).end().as('actor_name'),
          eb
            .case()
            .when('eu.login_subject', 'is not', null)
            .then(eb.ref('eu.name'))
            .else(null)
            .end()
            .as('entity_user_name'),
          'w.name as workspace_name',
        ])
        .where('cl.organization_id', '=', organizationId)
        .where((eb) =>
          eb.or([
            eb('cl.workspace_id', 'is', null),
            eb.and([eb('cl.entity_type', '=', 'workspace'), eb('cl.action', 'in', WORKSPACE_ACTIONS)]),
          ]),
        )
        .$if(before !== null, (query) =>
          query
            .where('cl.created_at', '<=', before!.created_at)
            .where((eb) => eb.or([eb('cl.created_at', '<', before!.created_at), eb('cl.id', '<', before!.id)])),
        )
        .orderBy('cl.created_at', 'desc')
        .orderBy('cl.id', 'desc')
        .limit(ORGANIZATION_HISTORY_PAGE_SIZE + 1),
    ),
  );

  const page = rows.slice(0, ORGANIZATION_HISTORY_PAGE_SIZE);
  const last = page.at(-1);
  const entries: Entry[] = page.map((row) => ({
    id: row.id,
    created_at: row.created_at,
    actor:
      row.actor_user_id !== null
        ? { kind: 'user', id: row.actor_user_id, name: row.actor_name }
        : row.by_operator
          ? { kind: 'operator' }
          : { kind: 'system' },
    event: historyEvent(row),
  }));
  return {
    entries,
    next:
      rows.length > ORGANIZATION_HISTORY_PAGE_SIZE && last !== undefined
        ? { created_at: last.created_at, id: last.id }
        : null,
  };
});
