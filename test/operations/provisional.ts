// 仕組みを確かめるための仮の操作。本番の一覧（src/shared/operations/index.ts）には入れない。
// 権限の種類ごとに1つ以上、組織の外・組織の直下・ワークスペースの下を一通り含める
import { z } from 'zod';
import { defineOperation } from '../../src/shared/operations/define.ts';
import { ApiError } from '../../src/server/errors.ts';
import { implement } from '../../src/server/operations/implement.ts';
import { createTask, createWorkspace } from '../factories.ts';
import type { Pointers } from './harness.ts';

export const whoAmI = defineOperation({
  name: 'who-am-i',
  description: 'ログインしているアカウントの ID を返す',
  mode: 'read',
  permission: 'login',
  input: z.object({ note: z.string().max(40).optional() }),
  output: z.object({ account_id: z.string() }),
});

export const operatorPing = defineOperation({
  name: 'operator-ping',
  description: '運用者だけが呼べる',
  mode: 'read',
  permission: 'operator',
  input: z.object({}),
  output: z.object({ pong: z.literal(true) }),
});

export const organizationProfile = defineOperation({
  name: 'organization-profile',
  description: '入れた組織と自分のユーザーの ID を返す',
  mode: 'read',
  permission: 'organization',
  input: z.object({}),
  output: z.object({ organization_id: z.string(), user_id: z.string().nullable() }),
});

const taskTitle = defineOperation({
  name: 'task-title',
  description: 'タスクの題名を返す。組織の中のタスクを ID だけで指す操作の見本',
  mode: 'read',
  permission: 'organization',
  input: z.object({ task_id: z.string() }),
  output: z.object({ title: z.string() }),
});

const adminPing = defineOperation({
  name: 'admin-ping',
  description: '管理者だけが呼べる',
  mode: 'write',
  permission: 'admin',
  input: z.object({ label: z.string().min(1) }),
  output: z.object({ organization_id: z.string() }),
});

export const workspaceSummary = defineOperation({
  name: 'workspace-summary',
  description: 'ワークスペースのメンバーが呼べる',
  mode: 'read',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: z.string() }),
  output: z.object({ workspace_id: z.string(), role: z.enum(['leader', 'member']).nullable() }),
});

export const renameWorkspace = defineOperation({
  name: 'rename-workspace',
  description: 'リーダーだけが呼べる',
  mode: 'write',
  permission: 'leader',
  workspace: true,
  input: z.object({ workspace_id: z.string(), name: z.string().min(1).max(40), count: z.number().int().default(1) }),
  output: z.object({ workspace_id: z.string(), name: z.string() }),
});

export const closeWorkspace = defineOperation({
  name: 'close-workspace',
  description: '管理者だけが呼べるワークスペースの下の操作',
  mode: 'write',
  permission: 'admin',
  workspace: true,
  input: z.object({ workspace_id: z.string() }),
  output: z.object({ workspace_id: z.string() }),
});

export const provisionalOperations = [
  implement(whoAmI, async ({ accountId }) => ({ account_id: accountId })),
  implement(operatorPing, async () => ({ pong: true as const })),
  implement(organizationProfile, async ({ db, actor }) => ({
    organization_id: db.organizationId,
    user_id: actor.userId,
  })),
  implement(taskTitle, async ({ db, input }) => {
    // 組織の中の表は、確かめた組織の ID で絞る。ID だけで引くと別の組織のタスクも読める
    const task = await db.first(
      db.statement((q) =>
        q
          .selectFrom('tasks as t')
          .innerJoin('workspaces as w', 'w.id', 't.workspace_id')
          .select('t.title')
          .where('t.id', '=', input.task_id)
          .where('w.organization_id', '=', db.organizationId),
      ),
    );
    if (task === undefined) throw new ApiError(404, 'not_found');
    return { title: task.title };
  }),
  implement(adminPing, async ({ db }) => ({ organization_id: db.organizationId })),
  implement(workspaceSummary, async ({ workspace }) => ({
    workspace_id: workspace.workspaceId,
    role: workspace.actorRole,
  })),
  implement(renameWorkspace, async ({ db, workspace, input }) => {
    await db.batch([
      db.statement((q) =>
        q
          .updateTable('workspaces')
          .set({ name: input.name })
          .where('id', '=', workspace.workspaceId)
          .where('organization_id', '=', workspace.organizationId),
      ),
    ]);
    return { workspace_id: workspace.workspaceId, name: input.name };
  }),
  implement(closeWorkspace, async ({ workspace }) => ({ workspace_id: workspace.workspaceId })),
];

// 組織の分離のテスト用の関数。対象の組織の行を指す入力を作る。
// 別の組織の対象を渡すと 404 になり、自分の組織の対象を渡すと成功する入力でなければならない。
// 入力が組織の中の行を指さない操作は、成功する入力を noReference に書く
export const provisionalPointers: Pointers = {
  'organization-profile': { noReference: {} },
  'task-title': async (target) => {
    const admin = target.admin.userId!;
    const workspace = await createWorkspace(target.organization, admin);
    const task = await createTask(target.organization, workspace.id, admin);
    return { task_id: task.id };
  },
  'admin-ping': { noReference: { label: 'x' } },
  'workspace-summary': async (target) => ({ workspace_id: target.workspace.id }),
  'rename-workspace': async (target) => ({ workspace_id: target.workspace.id, name: '青葉チーム' }),
  'close-workspace': async (target) => ({ workspace_id: target.workspace.id }),
};
