// 組織の中の操作ごとのテスト用の関数（docs/development.md の「操作の定義」）。操作を src/server/operations/index.ts の一覧に足したら、
// 同じ PR でここに足す。足し忘れると test/operation-registry.test.ts が落ちる。
// キーは操作の名前。値は、対象の組織の行を指す成功する入力を作る関数（別の組織の対象を渡すと 404 になる入力）。
// 組織の外の操作は、入力が必須の項目を持つときだけ足す（運用者の操作は、成功する入力を作る）
import { createFakeGithub } from '../auth/fake-github.ts';
import { githubUser } from '../auth/helpers.ts';
import { createStory, createTask, createWorkspace } from '../factories.ts';
import type { Pointers } from './harness.ts';

// 運用者の操作が問い合わせる GitHub。operation-registry.test.ts が fetcher を createApp に渡す
export const operatorGithub = createFakeGithub();

// 個人のアカウントの GitHub のユーザーを足して返す。呼ぶたびに別の人
function newGithubUser() {
  const user = githubUser(`pointer-${crypto.randomUUID().slice(0, 8)}`);
  operatorGithub.addUser(user);
  return user;
}

export const pointers: Pointers = {
  // 入力は空。組織は URL の slug で決まる
  organization: { noReference: {} },
  // 最初のリーダーに、対象の組織の管理者を指す。別の組織の管理者を指すと 404
  'workspace-create': async (target) => ({
    name: '保守チーム',
    timezone: 'Asia/Tokyo',
    vocabulary: 'game',
    leader_user_id: target.admin.userId,
  }),
  'workspace-list': { noReference: {} },
  'workspace-leader-candidates': { noReference: {} },
  workspace: async (target) => ({ workspace_id: target.workspace.id }),
  'member-list': async (target) => ({ workspace_id: target.workspace.id }),
  // 成功すると状態が変わるので、呼ぶたびに別のワークスペースを作る（続けて呼ぶと 409 になるため）。
  // 閉じた対象（createTarget({ closed: true })）では閉じたワークスペースそのものを指し、閉じたものへの書き込みが 409 になることを見る
  'workspace-close': async (target) => ({
    workspace_id:
      target.workspace.closed_at == null
        ? (await createWorkspace(target.organization, target.admin.userId!)).id
        : target.workspace.id,
  }),
  // 呼ぶたびに閉じたワークスペースを作る
  'workspace-reopen': async (target) => ({
    workspace_id: (
      await createWorkspace(target.organization, target.admin.userId!, { closed_at: '2026-10-22T00:00:00.000Z' })
    ).id,
  }),
  'resolve-github-user': async () => ({ username: newGithubUser().login }),
  // slug は呼ぶたびに別の値にする（重なると 409 になる）
  'create-organization': async () => {
    const user = newGithubUser();
    return {
      slug: `pointer-${crypto.randomUUID().slice(0, 8)}`,
      name: '分離の検査の組織',
      admin: { provider: 'github', username: user.login, login_subject: String(user.id) },
    };
  },
  'task-create': async (target) => ({ workspace_id: target.workspace.id, title: '見積もりを送る', points: 3 }),
  'backlog-tree': async (target) => ({ workspace_id: target.workspace.id }),
  'story-create': async (target) => ({ workspace_id: target.workspace.id, title: '見積もりを整える' }),
  'story-get': async (target) => ({
    workspace_id: target.workspace.id,
    story_id: (await createStory(target.organization, target.workspace.id, target.admin.userId!)).id,
  }),
  // 呼ぶたびにストーリーを作る（変える欄が同じだと、2回目は何も書かないため）
  'story-update': async (target) => ({
    workspace_id: target.workspace.id,
    story_id: (await createStory(target.organization, target.workspace.id, target.admin.userId!)).id,
    title: `見直した ${crypto.randomUUID().slice(0, 8)}`,
  }),
  // 呼ぶたびにストーリーとタスクを作り、タスクをそのストーリーの下へ移す
  'task-move': async (target) => {
    const adminId = target.admin.userId!;
    const story = await createStory(target.organization, target.workspace.id, adminId);
    const task = await createTask(target.organization, target.workspace.id, adminId);
    return { workspace_id: target.workspace.id, task_id: task.id, story_id: story.id };
  },
  'story-move': async (target) => {
    const adminId = target.admin.userId!;
    const story = await createStory(target.organization, target.workspace.id, adminId);
    return { workspace_id: target.workspace.id, story_id: story.id, epic_id: null, after_story_id: null };
  },
  // 呼ぶたびに完了にしていないタスクを作る（同じタスクを続けて完了にすると 409 になるため）
  'task-complete': async (target) => ({
    workspace_id: target.workspace.id,
    task_id: (await createTask(target.organization, target.workspace.id, target.admin.userId!, { points: 2 })).id,
  }),
  'task-detail': async (target) => ({
    workspace_id: target.workspace.id,
    task_id: (await createTask(target.organization, target.workspace.id, target.admin.userId!)).id,
  }),
  // 呼ぶたびにタスクを作る（変える欄が同じだと、2回目は何も書かないため）
  'task-update': async (target) => ({
    workspace_id: target.workspace.id,
    task_id: (await createTask(target.organization, target.workspace.id, target.admin.userId!)).id,
    title: `見直した ${crypto.randomUUID().slice(0, 8)}`,
  }),
  // 呼ぶたびに、一般のメンバーが作ったタスクを作る（削除できるのは作った人とリーダーなので、メンバーも通る。削除したタスクは続けて削除できない）
  'task-delete': async (target) => ({
    workspace_id: target.workspace.id,
    task_id: (await createTask(target.organization, target.workspace.id, target.member.userId!)).id,
  }),
};
