<script lang="ts">
  import { tick } from 'svelte';
  import { goto, invalidate } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { callOperation, type ApiResult } from '../../../../../lib/api.ts';
  import Avatar from '../../../../../lib/components/Avatar.svelte';
  import ConfirmDialog from '../../../../../lib/components/ConfirmDialog.svelte';
  import Emblem from '../../../../../lib/components/Emblem.svelte';
  import EmptyState from '../../../../../lib/components/EmptyState.svelte';
  import LoadFailed from '../../../../../lib/components/LoadFailed.svelte';
  import MemberInvite from '../../../../../lib/components/MemberInvite.svelte';
  import PageHead from '../../../../../lib/components/PageHead.svelte';
  import Section from '../../../../../lib/components/Section.svelte';
  import { isUnauthenticated, loginUrl } from '../../../../../lib/login-redirect.ts';
  import { showToast } from '../../../../../lib/toast.svelte.ts';
  import { t } from '../../../../../lib/vocabulary.svelte.ts';
  import {
    invitationRevoke,
    membershipLeave,
    membershipRoleUpdate,
  } from '../../../../../shared/operations/workspace/index.ts';
  import type { PageProps } from './$types';

  // メンバーの画面（members.html の「所属している人」と「招待する」の節と頭の数字）。名前（アバター付き）、ロール、参加日を文字で出す。
  // アバターは member-list が返す画像（avatar_url）を出し、無い人（アカウントに結ばれる前、アバターの無い人）と読み込めないときは頭文字の円。
  // 名前の横に、その人のレベルの小さい紋章を添える（経験値の数値は API も返さない）。
  // 承諾待ちの招待と組織の人数は、リーダーと管理者にだけ API が返す（一般のメンバーは null）ので、null のときは
  // 「招待する」と「承諾待ちの招待」の節も「招待中」の数も出さない。終了したワークスペースでは、招待と取り消しの操作を出さない。
  // 期限の過ぎた Google の招待は、一覧に「期限切れ」と出し、「招待中」の数には入れない（docs/data-model.md）。
  // 所属している人の行の操作（終了していないワークスペースでだけ出す）: リーダーと管理者には、ロールの選択欄と、他人の行の「外す」。
  // 自分の行には「抜ける」。一般のメンバーには、ロールを文字で出し、自分の行の「抜ける」だけを出す。
  // 外す、抜ける、自分をリーダーから一般に戻すときは、確かめのダイアログを挟む。結果はトーストで出し、一覧を読み直す。
  // 抜けたら組織のトップへ移り（ほかに入れるワークスペースが無い一般の人は組織の選択へ）、組織の枠も読み直す。
  // 自分を一般に戻したら、ワークスペースの枠（ロール）も読み直す。配分は別の Issue で足す
  let { data }: PageProps = $props();

  const workspace = $derived(data.workspace);
  const members = $derived(data.members);
  const invitations = $derived(data.invitations);
  const seats = $derived(data.seats);
  const slug = $derived(page.params.slug ?? '');
  const canWrite = $derived(workspace !== null && workspace.closedAt === null);
  // 自分の判定は組織の枠の me で行う（member-list の応答は変えない）
  const me = $derived(data.organization?.me ?? null);
  // ロールの付け替えと他人を外すのは、ワークスペースのリーダーと管理者
  const canManage = $derived(
    invitations !== null || workspace?.role === 'leader' || data.organization?.me.is_admin === true,
  );

  // 取り消している招待の ID。1件ずつ送る（送っている間は、ほかの取り消しも押しても無視する）
  let revoking = $state<string | null>(null);

  type Member = NonNullable<typeof members>[number];
  // 送っている行の操作。1件ずつ送り、送っている間はほかの行の操作を押しても無視する
  let changing = $state<string | null>(null);
  // 確かめのダイアログで聞いている操作
  // demote は自分を一般に戻す、demoteOther は他人の唯一のリーダーを一般に戻す
  type Pending = { kind: 'remove' | 'leave' | 'demote' | 'demoteOther'; member: Member };
  let pending = $state<Pending | null>(null);
  let confirmDialog = $state<ReturnType<typeof ConfirmDialog>>();

  // 管理者でなく、ほかに所属するワークスペースが無い人は、抜けると組織に入れなくなる
  const leavesOrganization = $derived(
    me !== null && !me.is_admin && (data.organization?.workspaces ?? []).every((item) => item.id === workspace?.id),
  );

  async function confirmAction(next: Pending, trigger: HTMLElement | null): Promise<boolean> {
    pending = next;
    return (await confirmDialog?.ask(trigger)) ?? false;
  }

  // 行の操作の失敗は、どれももう一度押しても直らないことが多いので、トーストで知らせて読み直す
  async function reportFailure(result: Exclude<ApiResult<unknown>, { ok: true }>, failed: string): Promise<void> {
    const words = { workspace: t('workspace'), leader: t('leader'), admin: t('admin') };
    if (result.error?.code === 'workspace_closed' || result.status === 403) {
      showToast(t(result.status === 403 ? 'memberErrorForbidden' : 'memberErrorClosed', words), 'alert');
      await invalidate('app:workspace');
    } else if (result.error?.code === 'conflict') showToast(t('memberErrorChanged'), 'alert');
    else if (result.status === 404) showToast(t('memberErrorNotFound'), 'alert');
    else if (result.status === 0) showToast(t('inviteErrorUnreachable'), 'alert');
    else showToast(failed, 'alert');
  }

  async function changeRole(event: Event, member: Member): Promise<void> {
    const select = event.currentTarget as HTMLSelectElement;
    const role = select.value === 'leader' ? 'leader' : 'member';
    if (changing !== null || workspace === null || role === member.role) {
      select.value = member.role;
      return;
    }
    const self = me !== null && member.id === me.id;
    // 自分をリーダーから一般に戻すと、付け替えも招待もできなくなるので確かめる（管理者は戻しても付け替えられるので除く）。
    // 自分か他人かによらず、唯一のリーダーを一般に戻すとき（リーダーがいなくなる）も確かめる
    const lastLeader = role === 'member' && member.role === 'leader' && leaderCount === 1;
    if ((self && role === 'member' && !(me?.is_admin ?? false)) || lastLeader) {
      const confirmed = await confirmAction({ kind: self ? 'demote' : 'demoteOther', member }, select);
      if (!confirmed) {
        select.value = member.role;
        return;
      }
    }
    changing = member.id;
    try {
      const result = await callOperation(
        membershipRoleUpdate,
        { workspace_id: workspace.id, user_id: member.id, role },
        { slug },
      );
      if (!result.ok && isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url));
        return;
      }
      if (result.ok) {
        showToast(t('memberRoleChanged', { name: member.name, role: roleLabel(role) }), 'check');
        // 自分のロールが変わったら、枠のロール（メニューと操作の出し分け）も読み直す
        if (self) await invalidate('app:workspace');
      } else {
        select.value = member.role;
        await reportFailure(result, t('memberRoleFailed'));
      }
      await reload();
    } finally {
      changing = null;
    }
    await tick();
    // 権限を失って選択欄が消えたら、節の見出しへフォーカスを移す
    if (!document.body.contains(select)) focusBelongingHeading();
  }

  async function removeMember(event: MouseEvent, member: Member): Promise<void> {
    if (changing !== null || workspace === null) return;
    const self = me !== null && member.id === me.id;
    const confirmed = await confirmAction(
      { kind: self ? 'leave' : 'remove', member },
      event.currentTarget as HTMLElement,
    );
    if (!confirmed) return;
    changing = member.id;
    const workspaceName = workspace.name;
    let removed: boolean | undefined;
    try {
      const result = await callOperation(membershipLeave, { workspace_id: workspace.id, user_id: member.id }, { slug });
      if (!result.ok && isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url));
        return;
      }
      // 自分の離脱が 404 か 403 なのは、別のタブなどで先に抜けていたとき（管理者は所属が無いので 404、
      // 一般のメンバーは登録の関数の member の権限で 403）。抜けたのと同じく扱う
      if (self && (result.ok || result.status === 404 || result.status === 403)) {
        showToast(t('memberLeft', { workspaceName }), 'check');
        // 抜けたワークスペースには入れない。組織の枠の値（所属するワークスペース）も読み直す
        await goto(leavesOrganization ? resolve('/') : resolve('/[slug]', { slug }), { invalidateAll: true });
        return;
      }
      removed = result.ok;
      if (result.ok) showToast(t('memberRemoved', { name: member.name }), 'check');
      else
        await reportFailure(
          result,
          self ? t('memberLeaveFailed', { workspace: t('workspace') }) : t('memberRemoveFailed'),
        );
      await reload();
    } finally {
      changing = null;
    }
    await tick();
    // 外せたら行が消えるので節の見出しへ。失敗したら同じ行のボタンへ戻し、行が無くなっていれば見出しへ
    const button =
      removed === true
        ? null
        : document.querySelector<HTMLButtonElement>(`[data-member-action="${CSS.escape(member.id)}"]`);
    if (button !== null) button.focus();
    else focusBelongingHeading();
  }

  function focusBelongingHeading(): void {
    const heading = document.getElementById('members-belonging');
    heading?.setAttribute('tabindex', '-1');
    heading?.focus();
  }

  // 言葉は、開いているワークスペースの言葉づかいで引く（t が当てる）
  function roleLabel(role: 'leader' | 'member'): string {
    return role === 'leader' ? t('leader') : t('roleMember');
  }

  function providerLabel(provider: 'github' | 'google'): string {
    return provider === 'google' ? t('loginProviderGoogle') : t('loginProviderGithub');
  }

  // 招待と取り消しの後に、所属、承諾待ちの招待、組織の人数を読み直す
  async function reload(): Promise<void> {
    await invalidate('app:members');
  }

  // 取り消しの失敗は、どれももう一度押しても直らないことが多いので、トーストで知らせて読み直す。
  // 先に承諾、辞退、取り消しが済んでいた（409 の conflict）、見つからない（404）、閉じた、権限を失った
  async function revoke(invitationId: string): Promise<void> {
    if (revoking !== null || workspace === null || invitations === null) return;
    revoking = invitationId;
    // 読み直した後にフォーカスを置く行。消えた行の位置に繰り上がる次の行（無ければ前の行）
    const index = invitations.findIndex((invitation) => invitation.id === invitationId);
    try {
      const result = await callOperation(
        invitationRevoke,
        { workspace_id: workspace.id, invitation_id: invitationId },
        { slug },
      );
      if (!result.ok && isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url));
        return;
      }
      const words = { workspace: t('workspace') };
      if (result.ok) showToast(t('invitationRevoked'), 'check');
      else if (result.error?.code === 'workspace_closed' || result.status === 403) {
        showToast(t(result.status === 403 ? 'inviteErrorForbidden' : 'inviteErrorClosed', words), 'alert');
        await invalidate('app:workspace');
      } else if (result.error?.code === 'conflict') showToast(t('invitationRevokeChanged'), 'alert');
      else if (result.status === 404) showToast(t('invitationRevokeNotFound'), 'alert');
      else if (result.status === 0) showToast(t('inviteErrorUnreachable'), 'alert');
      else showToast(t('invitationRevokeFailed'), 'alert');
      await reload();
    } finally {
      revoking = null;
    }
    await focusAfterRevoke(index);
  }

  // 押したボタンが消えてもフォーカスを失わないよう、同じ位置の行の「取り消す」へ移す。行が無くなれば節の見出しへ移す
  async function focusAfterRevoke(index: number): Promise<void> {
    await tick();
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-revoke-invitation]'));
    const next = buttons[Math.min(Math.max(index, 0), buttons.length - 1)];
    if (next !== undefined) {
      next.focus();
      return;
    }
    invitationsHeading()?.focus();
  }

  // 承諾待ちの招待の節の見出し（Section が id を付ける）。フォーカスを受けられるようにして返す
  function invitationsHeading(): HTMLElement | null {
    const heading = document.getElementById('members-invitations');
    heading?.setAttribute('tabindex', '-1');
    return heading;
  }

  const leaderCount = $derived(members?.filter((member) => member.role === 'leader').length ?? 0);
  const tallies = $derived([
    { label: t('membersTallyBelonging'), count: members?.length ?? 0, icon: 'users' as const },
    { label: t('leader'), count: leaderCount },
    ...(invitations === null
      ? []
      : [
          {
            label: t('membersTallyInvited'),
            count: invitations.filter((invitation) => !invitation.expired).length,
            icon: 'mail' as const,
          },
        ]),
  ]);
</script>

<svelte:head>
  {#if workspace && members !== null}
    <title>
      {t('pageTitle', {
        page: t('membersPageName', { members: t('pageMembers'), name: workspace.name }),
        app: t('appName'),
      })}
    </title>
  {/if}
</svelte:head>

{#if workspace && members === null}
  <LoadFailed inShell />
{:else if workspace && members !== null}
  <PageHead title={t('pageMembers')} eyebrow={workspace.name} {tallies} />

  <Section id="members-belonging" title={t('membersSectionTitle')}>
    {#if members.length === 0}
      <EmptyState icon="users" title={t('membersEmptyTitle')} text={t('membersEmptyText', { member: t('member') })} />
    {:else}
      <div class="table-wrap">
        <!-- 行の操作（ロールの選択欄、抜ける、外す）を出すときは、狭い幅で1行を縦に積む（is-stacked） -->
        <table class="table" class:is-stacked={canWrite} aria-label={t('membersTableLabel')}>
          <thead>
            <tr>
              <th class="is-name">{t('fieldName')}</th>
              <th>{t('memberRoleHeader')}</th>
              <th>{t('memberJoinedHeader')}</th>
              {#if canWrite}<th class="is-actions"><span class="visually-hidden">{t('memberActionsHeader')}</span></th
                >{/if}
            </tr>
          </thead>
          <tbody>
            {#each members as member (member.id)}
              {@const self = me !== null && member.id === me.id}
              <tr>
                <td class="is-name"
                  ><span class="person is-wrap"
                    ><Avatar
                      userId={member.id}
                      name={member.name}
                      image={member.avatar_url}
                      decorative
                    />{member.name}<Emblem level={member.level} small /></span
                  ></td
                >
                <td data-label={t('memberRoleHeader')}>
                  {#if canManage && canWrite}
                    <select
                      class="select"
                      aria-label={t('memberRoleLabel', { name: member.name })}
                      aria-disabled={changing !== null}
                      value={member.role}
                      onchange={(event) => changeRole(event, member)}
                    >
                      <option value="leader">{t('leader')}</option>
                      <option value="member">{t('roleMember')}</option>
                    </select>
                  {:else}
                    {roleLabel(member.role)}
                  {/if}
                </td>
                <td class="mono" data-label={t('memberJoinedHeader')}>{member.joined_on}</td>
                {#if canWrite}
                  <td class="is-actions">
                    {#if self}
                      <button
                        class="btn is-sm is-quiet"
                        type="button"
                        data-member-action={member.id}
                        aria-label={t('memberLeaveLabel', { workspaceName: workspace.name })}
                        aria-disabled={changing !== null}
                        onclick={(event) => removeMember(event, member)}>{t('memberLeave')}</button
                      >
                    {:else if canManage}
                      <button
                        class="btn is-sm is-quiet is-danger"
                        type="button"
                        data-member-action={member.id}
                        aria-label={t('memberRemoveLabel', { name: member.name })}
                        aria-disabled={changing !== null}
                        onclick={(event) => removeMember(event, member)}>{t('memberRemove')}</button
                      >
                    {/if}
                  </td>
                {/if}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if canManage && canWrite}
        <p class="action-note">{t('membersActionNote', { task: t('task') })}</p>
      {/if}
    {/if}
    <!-- 読み上げの領域。常に置き、文字だけを替える -->
    <div class="visually-hidden" role="status">{changing === null ? '' : t('memberWorking')}</div>
  </Section>

  <ConfirmDialog
    bind:this={confirmDialog}
    title={pending?.kind === 'remove'
      ? t('memberRemoveTitle', { name: pending.member.name })
      : pending?.kind === 'leave'
        ? t('memberLeaveTitle', { workspaceName: workspace.name })
        : pending?.kind === 'demoteOther'
          ? t('memberDemoteOtherTitle', { name: pending.member.name })
          : t('memberDemoteTitle')}
    confirmLabel={pending?.kind === 'remove'
      ? t('memberRemove')
      : pending?.kind === 'leave'
        ? t('memberLeave')
        : t('memberDemoteConfirm')}
    cancelLabel={t('cancel')}
    danger={pending?.kind === 'remove' || pending?.kind === 'leave'}
  >
    {#if pending?.kind === 'remove'}
      <p>{t('memberRemoveText', { name: pending.member.name, workspace: t('workspace'), task: t('task') })}</p>
    {:else if pending?.kind === 'leave'}
      <p>
        {t(leavesOrganization ? 'memberLeaveLastText' : 'memberLeaveText', {
          workspace: t('workspace'),
          organization: t('organization'),
          task: t('task'),
        })}
      </p>
    {:else if pending?.kind === 'demote' && !(me?.is_admin ?? false)}
      <p>{t('memberDemoteText', { leader: t('leader'), admin: t('admin') })}</p>
    {:else if pending?.kind === 'demoteOther'}
      <p>{t('memberDemoteOtherText', { name: pending.member.name })}</p>
    {/if}
    {#if pending !== null && pending.member.role === 'leader' && leaderCount === 1}
      <p>{t('memberLastLeaderNote', { workspace: t('workspace'), leader: t('leader'), admin: t('admin') })}</p>
    {/if}
  </ConfirmDialog>

  {#if invitations !== null && seats !== null && canWrite}
    <Section
      id="members-invite"
      title={t('inviteSectionTitle')}
      hint={t('inviteSeats', {
        organization: t('organization'),
        used: String(seats.used),
        limit: String(seats.limit),
      })}
    >
      <!-- ワークスペースを替えたら、入力と確かめた結果を捨てる -->
      {#key workspace.id}
        <MemberInvite {slug} workspaceId={workspace.id} {seats} onchanged={reload} />
      {/key}
    </Section>
  {/if}

  {#if invitations !== null}
    <Section
      id="members-invitations"
      title={t('invitationsSectionTitle')}
      hint={t('invitationsSectionHint', { leader: t('leader'), admin: t('admin') })}
    >
      <!-- 読み上げの領域。常に置き、文字だけを替える -->
      <div class="visually-hidden" role="status">{revoking === null ? '' : t('invitationRevoking')}</div>
      {#if invitations.length === 0}
        <EmptyState icon="mail" title={t('invitationsEmptyTitle')} text={t('invitationsEmptyText')} />
      {:else}
        <div class="table-wrap">
          <table class="table" aria-label={t('invitationsTableLabel')}>
            <thead>
              <tr>
                <th>{t('fieldName')}</th>
                <th>{t('invitationViaHeader')}</th>
                <th>{t('memberRoleHeader')}</th>
                <th>{t('invitedOnHeader')}</th>
                {#if canWrite}<th class="is-actions"
                    ><span class="visually-hidden">{t('invitationActionsHeader')}</span></th
                  >{/if}
              </tr>
            </thead>
            <tbody>
              {#each invitations as invitation (invitation.id)}
                <tr>
                  <td class="mono is-wrap">{invitation.login_name}</td>
                  <td>
                    {providerLabel(invitation.login_provider)}
                    {#if invitation.expired}
                      <span class="chip is-danger">{t('invitationExpired')}</span>
                    {:else if invitation.expires_on !== null}
                      <span class="props-note">{t('invitationExpiresOn', { date: invitation.expires_on })}</span>
                    {/if}
                  </td>
                  <td>{roleLabel(invitation.role)}</td>
                  <td class="mono">{invitation.invited_on}</td>
                  {#if canWrite}
                    <td class="is-actions">
                      <button
                        class="btn is-sm is-quiet"
                        type="button"
                        data-revoke-invitation
                        aria-label={t('invitationRevokeLabel', { name: invitation.login_name })}
                        aria-disabled={revoking !== null}
                        onclick={() => revoke(invitation.id)}>{t('invitationRevoke')}</button
                      >
                    </td>
                  {/if}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </Section>
  {/if}
{/if}
