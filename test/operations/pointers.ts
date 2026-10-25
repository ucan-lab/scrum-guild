// 組織の中の操作ごとのテスト用の関数（docs/development.md の「操作の定義」）。操作を src/server/operations/index.ts の一覧に足したら、
// 同じ PR でここに足す。足し忘れると test/operation-registry.test.ts が落ちる。
// キーは操作の名前。値は、対象の組織の行を指す成功する入力を作る関数（別の組織の対象を渡すと 404 になる入力）。
// 組織の外の操作は、入力が必須の項目を持つときだけ足す（運用者の操作は、成功する入力を作る）
import { createFakeGithub } from '../auth/fake-github.ts';
import { githubUser } from '../auth/helpers.ts';
import { createStory, createTask } from '../factories.ts';
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
  // 呼ぶたびに完了にしていないタスクを作る（同じタスクを続けて完了にすると 409 になるため）
  'task-complete': async (target) => ({
    workspace_id: target.workspace.id,
    task_id: (await createTask(target.organization, target.workspace.id, target.admin.userId!, { points: 2 })).id,
  }),
};
