// ワークスペースを作るときに書く行を組み立てる（書く前の部分。DB には触れない）。
// 書く順は workspaces、換算比率、列、決まった欄、所属、変更の履歴。外部キーの親が先
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { monthIn, todayIn } from '../../shared/clock.ts';
import {
  DEFAULT_HOURS_PER_POINT,
  DEFAULT_WEEK_START,
  defaultColumnNames,
  defaultDetailFieldName,
} from '../../shared/workspace.ts';
import { VOCABULARY_COLUMN_VALUE, type Insertable, type OrganizationTables } from '../db/index.ts';
import { uuidv7 } from '../uuid.ts';

type Row<T extends keyof OrganizationTables> = Insertable<OrganizationTables[T]>;

export type NewWorkspaceRows = {
  workspaceId: string;
  workspace: Row<'workspaces'>;
  rate: Row<'workspace_point_rates'>;
  // 完了の列が末尾
  columns: Row<'board_columns'>[];
  detailField: Row<'detail_fields'>;
  membership: Row<'memberships'>;
  // ワークスペースの作成と、最初のリーダーの所属の2行。既定の列、欄、換算比率は残さない
  logs: [Row<'change_logs'>, Row<'change_logs'>];
};

export function newWorkspaceRows(params: {
  at: Date;
  organizationId: string;
  actorUserId: string;
  leader: { id: string; name: string };
  name: string;
  // 正規の名前（normalizeTimezone を通した値）
  timezone: string;
}): NewWorkspaceRows {
  const { at, organizationId, actorUserId, leader, name, timezone } = params;
  const createdAt = at.toISOString();
  const workspaceId = uuidv7(at);
  const membershipId = uuidv7(at);
  const timestamps = { created_at: createdAt, updated_at: createdAt };

  // 完了の列は末尾の値を持つ（読むときは使わないが NOT NULL）
  const positions = generateNKeysBetween(null, null, 4);
  const columns: Row<'board_columns'>[] = [
    ...defaultColumnNames.map((columnName, index) => ({
      id: uuidv7(at),
      workspace_id: workspaceId,
      name: columnName,
      is_done: 0,
      position: positions[index]!,
      ...timestamps,
    })),
    {
      id: uuidv7(at),
      workspace_id: workspaceId,
      name: null,
      is_done: 1,
      position: positions[3]!,
      ...timestamps,
    },
  ];

  const logBase = {
    organization_id: organizationId,
    workspace_id: workspaceId,
    actor_user_id: actorUserId,
    action: 'create',
    created_at: createdAt,
  };
  return {
    workspaceId,
    workspace: {
      id: workspaceId,
      organization_id: organizationId,
      name,
      timezone,
      week_start: DEFAULT_WEEK_START,
      vocabulary: VOCABULARY_COLUMN_VALUE,
      created_by: actorUserId,
      ...timestamps,
    },
    rate: {
      workspace_id: workspaceId,
      effective_month: monthIn(timezone, at),
      hours_per_point: DEFAULT_HOURS_PER_POINT,
      created_at: createdAt,
    },
    columns,
    detailField: {
      id: uuidv7(at),
      workspace_id: workspaceId,
      name: defaultDetailFieldName,
      position: generateKeyBetween(null, null),
      ...timestamps,
    },
    membership: {
      id: membershipId,
      workspace_id: workspaceId,
      user_id: leader.id,
      role: 'leader',
      joined_on: todayIn(timezone, at),
      joined_at: createdAt,
    },
    logs: [
      {
        ...logBase,
        id: uuidv7(at),
        entity_type: 'workspace',
        entity_id: workspaceId,
        changes_json: JSON.stringify({
          name: [null, name],
          timezone: [null, timezone],
        }),
      },
      {
        ...logBase,
        id: uuidv7(at),
        entity_type: 'membership',
        entity_id: membershipId,
        changes_json: JSON.stringify({ user: [null, { id: leader.id, name: leader.name }], role: [null, 'leader'] }),
      },
    ],
  };
}
