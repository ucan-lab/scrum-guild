// 組織の中の操作ごとのテスト用の関数（docs/development.md の「操作の定義」）。操作を src/server/operations/index.ts の一覧に足したら、
// 同じ PR でここに足す。足し忘れると test/operation-registry.test.ts が落ちる。
// キーは操作の名前。値は、対象の組織の行を指す成功する入力を作る関数（別の組織の対象を渡すと 404 になる入力）。
// 組織の外の操作は、入力が必須の項目を持つときだけ足す（運用者の操作は、成功する入力を作る）
import { createFakeGithub } from '../auth/fake-github.ts';
import { githubUser } from '../auth/helpers.ts';
import {
  createCategory,
  createEpic,
  createInvitation,
  createOrganization,
  createOrganizationHoliday,
  createRepository,
  createSprint,
  createStory,
  createTask,
  createWorkspace,
} from '../factories.ts';
import type { Pointers } from './harness.ts';
import { SUSPENDED_AT } from './world.ts';

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
  'organization-holiday-list': { noReference: {} },
  // 日付は組織の中の行を指さない（登録済みなら飛ばすだけで成功する）
  'organization-holiday-add': { noReference: { holidays: [{ holiday_on: '2026-11-03', name: '文化の日' }] } },
  // 呼ぶたびに、対象の組織に別の日付の休日を作る（消した日付は続けて消せないため）。
  // 別の組織の対象を渡すと、その組織にだけある日付になり、自分の組織では 404
  'organization-holiday-delete': async (target) => ({
    holiday_on: (await createOrganizationHoliday(target.organization, target.admin.userId!)).holiday_on,
  }),
  // 組織は URL の slug で決まり、入力は組織の中の行を指さない（同じ値なら書かずに成功する）
  'organization-settings-update': {
    noReference: { vocabulary: { from: 'game', to: 'scrum' }, theme: { from: 'simple', to: 'medieval' } },
  },
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
  'invitee-resolve': async (target) => ({
    workspace_id: target.workspace.id,
    provider: 'github',
    username: newGithubUser().login,
  }),
  // 呼ぶたびに別の人を招待する（同じ人を続けて招待すると 409 になるため）
  'invitation-create': async (target) => {
    const user = newGithubUser();
    return {
      workspace_id: target.workspace.id,
      provider: 'github',
      username: user.login,
      login_subject: String(user.id),
      role: 'member',
    };
  },
  // 呼ぶたびに承諾待ちの招待を作る（取り消した招待を続けて取り消すと 409 になるため）
  'invitation-revoke': async (target) => ({
    workspace_id: target.workspace.id,
    invitation_id: (
      await createInvitation(target.organization, target.workspace.id, target.admin.userId!, {
        provider: 'github',
        subject: `pointer-${crypto.randomUUID()}`,
      })
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
  // 停止と再開は、呼ぶたびに別の組織を作る（対象の組織を停止すると、同じ describe の運用者でない人の検査が 401 になるため。
  // 停止済みの組織を停止する、停止していない組織を再開するのは 409 になる）
  'organization-suspend': async () => ({ slug: (await createOrganization()).slug, kind: 'temporary' }),
  'organization-suspension-update': async () => ({
    slug: (await createOrganization({ suspended_at: SUSPENDED_AT })).slug,
    kind: 'cancellation',
  }),
  'organization-resume': async () => ({
    slug: (await createOrganization({ suspended_at: SUSPENDED_AT, purge_on: '2026-11-19' })).slug,
  }),
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
  // 呼ぶたびに配下の無いストーリーを作る（完了にすると、2回目は 409 になるため）
  'story-complete': async (target) => ({
    workspace_id: target.workspace.id,
    story_id: (await createStory(target.organization, target.workspace.id, target.admin.userId!)).id,
  }),
  // 呼ぶたびに完了したストーリーを作る
  'story-reopen': async (target) => ({
    workspace_id: target.workspace.id,
    story_id: (
      await createStory(target.organization, target.workspace.id, target.admin.userId!, {
        completed_at: '2026-10-22T00:00:00.000Z',
        completed_by: target.admin.userId!,
      })
    ).id,
  }),
  'epic-create': async (target) => ({ workspace_id: target.workspace.id, title: '会員ランクを公開する' }),
  'epic-get': async (target) => ({
    workspace_id: target.workspace.id,
    epic_id: (await createEpic(target.organization, target.workspace.id, target.admin.userId!)).id,
  }),
  // 呼ぶたびにエピックを作る（変える欄が同じだと、2回目は何も書かないため）
  'epic-update': async (target) => ({
    workspace_id: target.workspace.id,
    epic_id: (await createEpic(target.organization, target.workspace.id, target.admin.userId!)).id,
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
  // 呼ぶたびに担当のいないタスクを作り、ワークスペースに今所属している一般のメンバーを担当にする（同じ担当だと、2回目は何も書かないため）。
  // 別の組織の対象を渡すと、タスクも担当も別の組織の行なので 404
  'task-assign': async (target) => ({
    workspace_id: target.workspace.id,
    task_id: (await createTask(target.organization, target.workspace.id, target.admin.userId!)).id,
    assignee_user_id: target.member.userId,
  }),
  'task-history': async (target) => ({
    workspace_id: target.workspace.id,
    task_id: (await createTask(target.organization, target.workspace.id, target.admin.userId!)).id,
  }),
  // 呼ぶたびに、一般のメンバーが作ったタスクを作る（削除できるのは作った人とリーダーなので、メンバーも通る。削除したタスクは続けて削除できない）
  'task-delete': async (target) => ({
    workspace_id: target.workspace.id,
    task_id: (await createTask(target.organization, target.workspace.id, target.member.userId!)).id,
  }),
  'sprint-list': async (target) => ({ workspace_id: target.workspace.id }),
  // 呼ぶたびに、前の呼び出しと重ならない期間を指す（同じワークスペースに続けて作ると、2回目は 409 の overlap になるため）
  'sprint-create': async (target) => ({
    workspace_id: target.workspace.id,
    start_on: nextSprintStart(),
    length: 14,
  }),
  // 呼ぶたびに先のスプリントを作る（変える欄が同じだと、2回目は何も書かないため）
  'sprint-update': async (target) => ({
    workspace_id: target.workspace.id,
    sprint_id: (await createSprint(target.organization, target.workspace.id)).id,
    name: `見直した ${crypto.randomUUID().slice(0, 8)}`,
  }),
  // 呼ぶたびに先のスプリントを作る（削除したスプリントは続けて削除できない）
  'sprint-delete': async (target) => ({
    workspace_id: target.workspace.id,
    sprint_id: (await createSprint(target.organization, target.workspace.id)).id,
  }),
  'category-repository-list': async (target) => ({ workspace_id: target.workspace.id }),
  // 名前は呼ぶたびに変える（同じ名前は 409 になるため）
  'category-create': async (target) => ({ workspace_id: target.workspace.id, name: `保守 ${uniqueSuffix()}` }),
  'category-update': async (target) => ({
    workspace_id: target.workspace.id,
    category_id: (await createCategory(target.organization, target.workspace.id, { name: `保守 ${uniqueSuffix()}` }))
      .id,
    name: `追加案件 ${uniqueSuffix()}`,
  }),
  'category-move': async (target) => ({
    workspace_id: target.workspace.id,
    category_id: (await createCategory(target.organization, target.workspace.id, { name: `保守 ${uniqueSuffix()}` }))
      .id,
    after_category_id: null,
  }),
  // 呼ぶたびに区分を作る（削除した区分は続けて削除できない）
  'category-delete': async (target) => ({
    workspace_id: target.workspace.id,
    category_id: (await createCategory(target.organization, target.workspace.id, { name: `保守 ${uniqueSuffix()}` }))
      .id,
  }),
  'repository-create': async (target) => ({ workspace_id: target.workspace.id, name: `shop-api-${uniqueSuffix()}` }),
  'repository-update': async (target) => ({
    workspace_id: target.workspace.id,
    repository_id: (
      await createRepository(target.organization, target.workspace.id, { name: `shop-api-${uniqueSuffix()}` })
    ).id,
    name: `shop-web-${uniqueSuffix()}`,
  }),
  'repository-move': async (target) => ({
    workspace_id: target.workspace.id,
    repository_id: (
      await createRepository(target.organization, target.workspace.id, { name: `shop-api-${uniqueSuffix()}` })
    ).id,
    after_repository_id: null,
  }),
  'repository-delete': async (target) => ({
    workspace_id: target.workspace.id,
    repository_id: (
      await createRepository(target.organization, target.workspace.id, { name: `shop-api-${uniqueSuffix()}` })
    ).id,
  }),
};

// 区分とリポジトリの名前を、呼ぶたびに変える
function uniqueSuffix(): string {
  return crypto.randomUUID().slice(0, 8);
}

// sprint-create の開始日。2030-01-07 から 28 日ずつ進める
let sprintStarts = 0;
function nextSprintStart(): string {
  const at = new Date(Date.UTC(2030, 0, 7) + sprintStarts++ * 28 * 86_400_000);
  return at.toISOString().slice(0, 10);
}
