// 組織の中の操作ごとのテスト用の関数（docs/development.md の「操作の定義」）。操作を src/server/operations/index.ts の一覧に足したら、
// 同じ PR でここに足す。足し忘れると test/operation-registry.test.ts が落ちる。
// キーは操作の名前。値は、対象の組織の行を指す成功する入力を作る関数（別の組織の対象を渡すと 404 になる入力）。
// 組織の外の操作は、入力が必須の項目を持つときだけ足す（運用者の操作は、成功する入力を作る）
import { env } from 'cloudflare:workers';
import { PRIVACY_VERSION, TERMS_VERSION } from '../../src/lib/legal/versions.ts';
import { orgDb } from '../../src/server/db/index.ts';
import { createFakeGithub } from '../auth/fake-github.ts';
import { githubUser } from '../auth/helpers.ts';
import {
  createBoardColumn,
  createCategory,
  createComment,
  createEpic,
  createEpicPartyMember,
  createInvitation,
  createMembership,
  createOrganization,
  createOrganizationHoliday,
  createRepository,
  createSprint,
  createSprintEntry,
  createStory,
  createTask,
  createThanks,
  createUser,
  createWorkspace,
} from '../factories.ts';
import { insertApiToken } from './api-token.ts';
import type { Pointers } from './harness.ts';
import { SUSPENDED_AT, type Person, type Target } from './world.ts';

// 運用者の操作が問い合わせる GitHub。chunks.ts の defineProductionChunk が fetcher を createApp に渡す
export const operatorGithub = createFakeGithub();

// そのワークスペースに今の所属が無ければ、一般のメンバーとして作る
async function ensureMembership(target: Target, workspaceId: string, userId: string): Promise<void> {
  const db = orgDb(env, target.organization.verified);
  const current = await db.first(
    db.statement((q) =>
      q
        .selectFrom('memberships')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .where('user_id', '=', userId)
        .where('left_at', 'is', null),
    ),
  );
  if (current === undefined) await createMembership(target.organization, workspaceId, userId, { role: 'member' });
}

// 対象のワークスペースのタスクに、呼ぶ人が書いたコメントを作る。呼ぶ人が対象の組織の人でなければ（別の組織の対象を指すとき）、
// 対象の組織の管理者が書いたコメントにする
async function commentFor(target: Target, caller: Person) {
  const people = [target.admin, target.leader, target.member, target.bystander];
  const author = people.find((person) => person.userId !== null && person.userId === caller.userId) ?? target.admin;
  const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
  return createComment(target.organization, target.workspace.id, task.id, author.userId!);
}

// 呼ぶ人が対象の組織の人なら、その人を返す（別の組織の対象を指すときは undefined）
function personOf(target: Target, caller: Person): Person | undefined {
  const people = [target.admin, target.leader, target.member, target.bystander];
  return people.find((person) => person.userId !== null && person.userId === caller.userId);
}

// 呼ぶ人が対象の組織の人なら、対象のワークスペースに今所属させる（討伐隊に入れる人にする）
async function ensurePartyCandidate(target: Target, caller: Person): Promise<void> {
  const person = personOf(target, caller);
  if (person !== undefined) await ensureMembership(target, target.workspace.id, person.userId!);
}

// 進行中のスプリントは1つなので、新しく始める入力を作る前に、前の呼び出しで始めたものを終了にして空ける
async function closeActiveSprints(target: Target): Promise<void> {
  const db = orgDb(env, target.organization.verified);
  await db.run(
    db.statement((q) =>
      q
        .updateTable('sprints')
        .set({ status: 'closed' })
        .where('workspace_id', '=', target.workspace.id)
        .where('status', '=', 'active'),
    ),
  );
}

// 個人のアカウントの GitHub のユーザーを足して返す。呼ぶたびに別の人
function newGithubUser() {
  const user = githubUser(`pointer-${crypto.randomUUID().slice(0, 8)}`);
  operatorGithub.addUser(user);
  return user;
}

export const pointers: Pointers = {
  // 入力は空。組織は URL の slug で決まる
  organization: { noReference: {} },
  today: { noReference: {} },
  'first-steps': { noReference: {} },
  // 最初のリーダーに、対象の組織の管理者を指す。別の組織の管理者を指すと 404
  'workspace-create': async (target) => ({
    name: '保守チーム',
    timezone: 'Asia/Tokyo',
    leader_user_id: target.admin.userId,
  }),
  // 呼んだ人自身の users.theme を書く。入力は組織の中の行を指さない（人は ID でなく呼んだ人で決まる）
  'me-theme-update': { noReference: { theme: 'medieval' } },
  'organization-holiday-list': { noReference: {} },
  // 日付は組織の中の行を指さない（登録済みなら飛ばすだけで成功する）
  'organization-holiday-add': { noReference: { holidays: [{ holiday_on: '2026-11-03', name: '文化の日' }] } },
  // 呼ぶたびに、対象の組織に別の日付の休日を作る（消した日付は続けて消せないため）。
  // 別の組織の対象を渡すと、その組織にだけある日付になり、自分の組織では 404
  'organization-holiday-delete': async (target) => ({
    holiday_on: (await createOrganizationHoliday(target.organization, target.admin.userId!)).holiday_on,
  }),
  // 組織は URL の slug で決まり、入力は組織の中の行を指さない。from は作ったばかりの組織の値で、to が同じなら書かずに成功する。
  // 値を変える入力だと、同じ組織に続けて2回成功させる検査（API トークンの Origin の検査と行の分離）の2回目が、from が合わず 409 になる
  'organization-settings-update': {
    noReference: { theme: { from: 'simple', to: 'simple' } },
  },
  // カーソルを渡さなければ最新から読む。組織は URL の slug で決まる
  'organization-history': { noReference: {} },
  // 組織のユーザーの管理。呼ぶたびに対象の組織に別の人を作る（別の組織の対象を渡すと、その組織の人を指して 404）
  'user-list': { noReference: {} },
  'user-admin-update': async (target) => ({
    user_id: (await createUser(target.organization)).id,
    is_admin: true,
  }),
  'user-disable': async (target) => {
    const user = await createUser(target.organization);
    await createMembership(target.organization, target.workspace.id, user.id);
    return { user_id: user.id };
  },
  'user-enable': async (target) => ({
    user_id: (await createUser(target.organization, { disabled_at: '2026-10-21T00:00:00.000Z' })).id,
  }),
  'workspace-list': { noReference: {} },
  'workspace-leader-candidates': { noReference: {} },
  workspace: async (target) => ({ workspace_id: target.workspace.id }),
  'member-list': async (target) => ({ workspace_id: target.workspace.id }),
  // 同じ値を続けて送っても、書かずに成功する
  'workspace-dod-update': async (target) => ({
    workspace_id: target.workspace.id,
    definition_of_done_md: '- レビューを通した',
  }),
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
  // 呼ぶたびに、一般のメンバーを1人足して、その人をリーダーにする（同じ人を続けてリーダーにすると、2回目は何も書かないため。
  // 対象の一般のメンバー（target.member）を指すと、リーダーになって権限の検査の「一般のメンバーは 403」が崩れる）
  'membership-role-update': async (target) => {
    const user = await createUser(target.organization, { name: '朝霧 律' });
    await createMembership(target.organization, target.workspace.id, user.id, { role: 'member' });
    return { workspace_id: target.workspace.id, user_id: user.id, role: 'leader' };
  },
  // 対象の一般のメンバー（target.member）を指す。一般のメンバーは自分なら抜けられ、リーダーと管理者は外せるので、どの呼ぶ人でも通る。
  // 抜けた所属は続けて抜けられないので、呼ぶたびに今の所属を作り直す。別のワークスペース（otherWorkspace）にも所属させ、
  // 抜けても入れる組織を失わない（同じ describe の後の検査が、入れる組織を持つ人で動くようにするため）
  'membership-leave': async (target) => {
    const userId = target.member.userId!;
    await ensureMembership(target, target.workspace.id, userId);
    await ensureMembership(target, target.otherWorkspace.id, userId);
    return { workspace_id: target.workspace.id, user_id: userId };
  },
  // 入力は空。呼んだ人のログインに当たる、この組織の招待を返す
  'invitation-list': { noReference: {} },
  // 呼ぶたびに対象の組織に新しいワークスペースを作り、呼ぶ人を招待する（承諾すると所属するので、同じワークスペースには続けて承諾できない）。
  // 別の組織の対象を渡すと、招待はその組織の行なので、自分の組織の slug では 404
  'invitation-accept': async (target, caller) => {
    const workspace = await createWorkspace(target.organization, target.admin.userId!);
    return {
      invitation_id: (await createInvitation(target.organization, workspace.id, target.admin.userId!, caller.login)).id,
    };
  },
  // 呼ぶたびに対象の組織に新しいワークスペースを作り、呼ぶ人を招待する（辞退した招待は続けて辞退できない）
  'invitation-decline': async (target, caller) => {
    const workspace = await createWorkspace(target.organization, target.admin.userId!);
    return {
      invitation_id: (await createInvitation(target.organization, workspace.id, target.admin.userId!, caller.login)).id,
    };
  },
  'token-create': { noReference: { name: '分離の検査', scope: 'read' } },
  'consent-record': { noReference: { terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION } },
  // 呼ぶ人の行を指す。取消は二度目も成功するので、呼ぶたびに作らなくてよいが、作り直して他の検査と独立にする
  'token-revoke': async (_target, caller) => ({ id: (await insertApiToken(caller.accountId)).hash }),
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
  // 停止と再開は、呼ぶたびに別の組織を作る（対象の組織を停止すると、同じ describe の運用者でない人の検査が、組織の停止の 403 や 404 になるため。
  // 停止済みの組織を停止する、停止していない組織を再開するのは 409 になる）
  'organization-suspend': async () => ({ slug: (await createOrganization()).slug, kind: 'temporary' }),
  'organization-suspension-update': async () => ({
    slug: (await createOrganization({ suspended_at: SUSPENDED_AT })).slug,
    kind: 'cancellation',
  }),
  'organization-resume': async () => ({
    // 消す予定日は遠い先にする（過ぎると 409 の purge_due で再開できないため）
    slug: (await createOrganization({ suspended_at: SUSPENDED_AT, purge_on: '2999-12-31' })).slug,
  }),
  // 上限の変更は、呼ぶたびに別の組織を作る（同じ値への変更は何も書かないので、既定の小さい組織から標準へ変える）
  'organization-quota-update': async () => ({
    slug: (await createOrganization()).slug,
    member_limit: 50,
    attachment_quota_bytes: 100 * 1024 ** 3,
    expected: { member_limit: 15, attachment_quota_bytes: 30 * 1024 ** 3 },
  }),
  // 管理者の指名し直しは、呼ぶたびに別の組織を作り、別の人を指名する（対象の組織の users を消すと、同じ describe の検査が崩れるため）
  'organization-admin-reassign': async () => {
    const user = newGithubUser();
    return {
      slug: (await createOrganization()).slug,
      admin: { provider: 'github', username: user.login, login_subject: String(user.id) },
    };
  },
  'task-create': async (target) => ({ workspace_id: target.workspace.id, title: '見積もりを送る', points: 3 }),
  // 絞り込みの値も、対象の組織の行を指す（別の組織を指したときの当たり方は test/backlog-filter.test.ts）
  'backlog-completed-tasks': async (target) => ({ workspace_id: target.workspace.id, story_id: null }),
  'backlog-tree': async (target) => {
    const category = await createCategory(target.organization, target.workspace.id);
    const repository = await createRepository(target.organization, target.workspace.id);
    const epic = await createEpic(target.organization, target.workspace.id, target.admin.userId!);
    return {
      workspace_id: target.workspace.id,
      assignee_user_id: target.member.userId,
      category_id: category.id,
      repository_id: repository.id,
      epic_id: epic.id,
      query: '見積もり',
    };
  },
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
  'epic-detail': async (target) => ({
    workspace_id: target.workspace.id,
    epic_id: (await createEpic(target.organization, target.workspace.id, target.admin.userId!)).id,
  }),
  // 呼ぶたびにエピックを作る（変える欄が同じだと、2回目は何も書かないため）
  'epic-update': async (target) => ({
    workspace_id: target.workspace.id,
    epic_id: (await createEpic(target.organization, target.workspace.id, target.admin.userId!)).id,
    title: `見直した ${crypto.randomUUID().slice(0, 8)}`,
  }),
  // 呼ぶたびにエピックを作る（受注した後は、続けて受注しても何も書かないため）。呼ぶ人が対象の組織の人なら、討伐隊に入れる人
  // （今所属している人）にする。所属していない管理者は受注できない（404）ので、対象のワークスペースに所属させる
  'epic-party-join': async (target, caller) => {
    await ensurePartyCandidate(target, caller);
    return {
      workspace_id: target.workspace.id,
      epic_id: (await createEpic(target.organization, target.workspace.id, target.admin.userId!)).id,
    };
  },
  // 呼ぶたびにエピックを作り、呼ぶ人が対象の組織の人なら、その人を討伐隊に入れておく（抜ける行がある入力にする）
  'epic-party-leave': async (target, caller) => {
    const epic = await createEpic(target.organization, target.workspace.id, target.admin.userId!);
    if (personOf(target, caller) !== undefined) {
      await createEpicPartyMember(target.organization, epic.id, caller.userId!);
    }
    return { workspace_id: target.workspace.id, epic_id: epic.id };
  },
  // 呼ぶたびにエピックを作る。依頼主は呼ぶ人（対象の組織の人なら。一般のメンバーは依頼主なら割り振れる）で、割り振る相手は
  // 対象の一般のメンバー（target.member。今所属している）
  'epic-party-assign': async (target, caller) => {
    const requester = personOf(target, caller) ?? target.admin;
    const epic = await createEpic(target.organization, target.workspace.id, target.admin.userId!, {
      requester_user_id: requester.userId!,
    });
    return { workspace_id: target.workspace.id, epic_id: epic.id, user_id: target.member.userId! };
  },
  // 呼ぶたびにエピックを作る（ファクトリーの段階は small。変えた後に同じ段階を送ると何も書かないため）。依頼主は呼ぶ人
  // （対象の組織の人なら。一般のメンバーは依頼主なら変えられる）
  'epic-reward-update': async (target, caller) => {
    const requester = personOf(target, caller) ?? target.admin;
    const epic = await createEpic(target.organization, target.workspace.id, target.admin.userId!, {
      requester_user_id: requester.userId!,
    });
    return { workspace_id: target.workspace.id, epic_id: epic.id, reward_tier: 'large' };
  },
  // 呼ぶたびにエピックを作る（依頼主を替えた後に同じ人を送ると何も書かないため）。依頼主は管理者で、替え先は対象の一般のメンバー
  // （今所属している）。リーダーだけが呼べる
  'epic-requester-update': async (target) => ({
    workspace_id: target.workspace.id,
    epic_id: (await createEpic(target.organization, target.workspace.id, target.admin.userId!)).id,
    user_id: target.member.userId!,
  }),
  // 呼ぶたびにエピックを作る（削除すると2回目は 404 になるため）。作った人は一般のメンバー（作った人なら削除できる）
  'epic-delete': async (target) => ({
    workspace_id: target.workspace.id,
    epic_id: (await createEpic(target.organization, target.workspace.id, target.member.userId!)).id,
    children: 'keep',
  }),
  // 呼ぶたびにストーリーを作る。作った人は一般のメンバー
  'story-delete': async (target) => ({
    workspace_id: target.workspace.id,
    story_id: (await createStory(target.organization, target.workspace.id, target.member.userId!)).id,
    children: 'delete',
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
  // 呼ぶたびにスプリントの外で完了したタスクを作る（同じタスクを続けて戻すと 409 になるため）
  'task-reopen': async (target) => ({
    workspace_id: target.workspace.id,
    task_id: (
      await createTask(target.organization, target.workspace.id, target.admin.userId!, {
        completed_at: '2026-10-22T00:00:00.000Z',
        completed_by: target.admin.userId!,
      })
    ).id,
  }),
  'thanks-send': async (target, caller) => {
    const sender = personOf(target, caller) ?? target.admin;
    const recipient = sender.userId === target.member.userId ? target.leader : target.member;
    const task = await createTask(target.organization, target.workspace.id, sender.userId!);
    return { workspace_id: target.workspace.id, task_id: task.id, recipient_user_id: recipient.userId! };
  },
  'thanks-revoke': async (target, caller) => {
    const sender = personOf(target, caller) ?? target.admin;
    const recipient = sender.userId === target.member.userId ? target.leader : target.member;
    const task = await createTask(target.organization, target.workspace.id, sender.userId!);
    const thanks = await createThanks(
      target.organization,
      target.workspace.id,
      task.id,
      sender.userId!,
      recipient.userId!,
    );
    return { workspace_id: target.workspace.id, thanks_id: thanks.id };
  },
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
  'comment-list': async (target) => ({
    workspace_id: target.workspace.id,
    task_id: (await createTask(target.organization, target.workspace.id, target.admin.userId!)).id,
  }),
  'comment-create': async (target) => ({
    workspace_id: target.workspace.id,
    task_id: (await createTask(target.organization, target.workspace.id, target.admin.userId!)).id,
    body_md: '手順を確かめました。',
  }),
  // 呼ぶたびに、呼ぶ人が書いたコメントを作る（直せるのは書いた本人だけ。呼ぶ人が対象の組織にいなければ管理者のコメント）。
  // 本文を毎回変える（同じ本文だと何も書かないため）
  'comment-update': async (target, caller) => ({
    workspace_id: target.workspace.id,
    comment_id: (await commentFor(target, caller)).id,
    body_md: `手順を直しました ${crypto.randomUUID().slice(0, 8)}`,
  }),
  // 呼ぶたびに、呼ぶ人が書いたコメントを作る（消したコメントは続けて消せない）
  'comment-delete': async (target, caller) => ({
    workspace_id: target.workspace.id,
    comment_id: (await commentFor(target, caller)).id,
  }),
  'sprint-list': async (target) => ({ workspace_id: target.workspace.id }),
  'plan-summary': async (target) => ({ workspace_id: target.workspace.id }),
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
  // 呼ぶたびに、先頭の列、先のスプリント、入れるタスクを作る（入れたタスクは同じスプリントへ2回目は入らないため）
  'sprint-task-add': async (target) => {
    await createBoardColumn(target.organization, target.workspace.id);
    const sprint = await createSprint(target.organization, target.workspace.id);
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!);
    return { workspace_id: target.workspace.id, sprint_id: sprint.id, task_ids: [task.id] };
  },
  // 呼ぶたびに、先のスプリントと、そこに入ったタスクを作る（外したタスクは続けて外せない）
  'sprint-task-remove': async (target) => {
    const column = await createBoardColumn(target.organization, target.workspace.id);
    const sprint = await createSprint(target.organization, target.workspace.id);
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      sprint_id: sprint.id,
      column_id: column.id,
      column_position: 'a0',
    });
    await createSprintEntry(target.organization, target.workspace.id, sprint.id, task.id, target.admin.userId!);
    return { workspace_id: target.workspace.id, sprint_id: sprint.id, task_id: task.id };
  },
  // 呼ぶたびに、進行中のスプリントを閉じ、先のスプリントを作る（進行中が既にあると始められず、始めたスプリントは続けて始められないため）
  'sprint-start': async (target) => {
    await closeActiveSprints(target);
    // 最終日が今日より前のスプリントは始められないので、遠い先の期間を指す
    const startOn = nextSprintStart();
    const endOn = new Date(Date.parse(startOn) + 13 * 86_400_000).toISOString().slice(0, 10);
    const sprint = await createSprint(target.organization, target.workspace.id, { start_on: startOn, end_on: endOn });
    return { workspace_id: target.workspace.id, sprint_id: sprint.id, goal: '新しい依頼を3件受ける' };
  },
  // 呼ぶたびに、前の呼び出しの進行中のスプリントを閉じ、重ならない先の期間で進行中のスプリントを作る
  // （進行中は1つで、延ばした最終日が前に閉じたスプリントと重なると断られるため）
  'sprint-extend': async (target) => {
    await closeActiveSprints(target);
    const startOn = nextSprintStart();
    const endOn = new Date(Date.parse(startOn) + 13 * 86_400_000).toISOString().slice(0, 10);
    const sprint = await createSprint(target.organization, target.workspace.id, {
      status: 'active',
      start_on: startOn,
      end_on: endOn,
    });
    return { workspace_id: target.workspace.id, sprint_id: sprint.id, days: 1, end_on: endOn };
  },
  // 呼ぶたびに、前の呼び出しの進行中のスプリントを閉じ、ゴールのない進行中のスプリントを作る（終えたスプリントは続けて終えられないため）
  'sprint-close': async (target) => {
    await closeActiveSprints(target);
    const sprint = await createSprint(target.organization, target.workspace.id, { status: 'active' });
    return { workspace_id: target.workspace.id, sprint_id: sprint.id, carry_sprint_id: null, is_goal_achieved: null };
  },
  'sprint-board': async (target) => ({ workspace_id: target.workspace.id }),
  // 呼ぶたびに、進行中のスプリント、列を2つ、先頭の列のカードを作り、次の列へ移す（移したカードは同じ列への移動になるため）
  'task-column-move': async (target) => {
    await closeActiveSprints(target);
    const sprint = await createSprint(target.organization, target.workspace.id, { status: 'active' });
    const first = await createBoardColumn(target.organization, target.workspace.id, { position: 'a0' });
    const second = await createBoardColumn(target.organization, target.workspace.id, {
      name: '遂行中',
      position: 'a1',
    });
    const task = await createTask(target.organization, target.workspace.id, target.admin.userId!, {
      sprint_id: sprint.id,
      column_id: first.id,
      column_position: 'a0',
    });
    await createSprintEntry(target.organization, target.workspace.id, sprint.id, task.id, target.admin.userId!);
    return { workspace_id: target.workspace.id, task_id: task.id, column_id: second.id, after_task_id: null };
  },
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
  'column-list': async (target) => ({ workspace_id: target.workspace.id }),
  // 名前は呼ぶたびに変える（同じ名前は 409 になるため）
  'column-create': async (target) => ({ workspace_id: target.workspace.id, name: `検証 ${uniqueSuffix()}` }),
  'column-update': async (target) => ({
    workspace_id: target.workspace.id,
    column_id: (await createBoardColumn(target.organization, target.workspace.id, { name: `検証 ${uniqueSuffix()}` }))
      .id,
    name: `確認 ${uniqueSuffix()}`,
  }),
  // 動かす列と、直前の列（同じワークスペースの別の列）の2つを作る
  'column-move': async (target) => {
    const moving = await createBoardColumn(target.organization, target.workspace.id, {
      name: `検証 ${uniqueSuffix()}`,
    });
    const before = await createBoardColumn(target.organization, target.workspace.id, {
      name: `直前 ${uniqueSuffix()}`,
      position: 'a1',
    });
    return { workspace_id: target.workspace.id, column_id: moving.id, after_column_id: before.id };
  },
  // 呼ぶたびに列を2つ作って、1つ目を消し、2つ目を移し先に指す（削除した列は続けて削除できず、最後の1つの列は削除できないため）
  'column-delete': async (target) => {
    const doomed = await createBoardColumn(target.organization, target.workspace.id, {
      name: `検証 ${uniqueSuffix()}`,
    });
    const destination = await createBoardColumn(target.organization, target.workspace.id, {
      name: `残る ${uniqueSuffix()}`,
      position: 'a1',
    });
    return {
      workspace_id: target.workspace.id,
      column_id: doomed.id,
      target_column_id: destination.id,
    };
  },
  // 呼んだ人の分だけを読み、入力は行を指さない（明細の続きの位置は行を指さず、別の組織の位置でも読む範囲が変わるだけ）
  'experience-summary': { noReference: {} },
  'experience-grants': { noReference: {} },
  'experience-team-total': async (target) => ({ workspace_id: target.workspace.id }),
  'epic-move': async (target) => ({
    workspace_id: target.workspace.id,
    epic_id: (await createEpic(target.organization, target.workspace.id, target.admin.userId!)).id,
    after_epic_id: null,
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
