<script lang="ts">
  import { invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import { callOperation } from '../../../../../lib/api.ts';
  import Avatar from '../../../../../lib/components/Avatar.svelte';
  import EmptyState from '../../../../../lib/components/EmptyState.svelte';
  import LoadFailed from '../../../../../lib/components/LoadFailed.svelte';
  import MemberInvite from '../../../../../lib/components/MemberInvite.svelte';
  import PageHead from '../../../../../lib/components/PageHead.svelte';
  import Section from '../../../../../lib/components/Section.svelte';
  import { isUnauthenticated, loginUrl } from '../../../../../lib/login-redirect.ts';
  import { showToast } from '../../../../../lib/toast.svelte.ts';
  import { t } from '../../../../../lib/vocabulary.svelte.ts';
  import { invitationRevoke } from '../../../../../shared/operations/workspace/index.ts';
  import type { PageProps } from './$types';

  // メンバーの画面（members.html の「所属している人」と「招待する」の節と頭の数字）。名前（アバター付き）、ロール、参加日を文字で出す。
  // 承諾待ちの招待と組織の人数は、リーダーと管理者にだけ API が返す（一般のメンバーは null）ので、null のときは
  // 「招待する」と「承諾待ちの招待」の節も「招待中」の数も出さない。終了したワークスペースでは、招待と取り消しの操作を出さない。
  // 期限の過ぎた Google の招待は、一覧に「期限切れ」と出し、「招待中」の数には入れない（docs/data-model.md）。
  // ロールの付け替え、外す、抜ける、配分 は、それぞれの Issue で足す
  let { data }: PageProps = $props();

  const workspace = $derived(data.workspace);
  const members = $derived(data.members);
  const invitations = $derived(data.invitations);
  const seats = $derived(data.seats);
  const slug = $derived(page.params.slug ?? '');
  const canWrite = $derived(workspace !== null && workspace.closedAt === null);

  // 取り消している招待の ID。1件ずつ送る（送っている間は、ほかの取り消しも押しても無視する）
  let revoking = $state<string | null>(null);

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
    if (revoking !== null || workspace === null) return;
    revoking = invitationId;
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
    else showToast(t('invitationRevokeFailed'), 'alert');
    await reload();
    revoking = null;
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
        <table class="table" aria-label={t('membersTableLabel')}>
          <thead>
            <tr>
              <th class="is-name">{t('fieldName')}</th>
              <th>{t('memberRoleHeader')}</th>
              <th>{t('memberJoinedHeader')}</th>
            </tr>
          </thead>
          <tbody>
            {#each members as member (member.id)}
              <tr>
                <td class="is-name"
                  ><span class="person is-wrap"><Avatar userId={member.id} name={member.name} />{member.name}</span></td
                >
                <td>{roleLabel(member.role)}</td>
                <td class="mono">{member.joined_on}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </Section>

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
      <MemberInvite {slug} workspaceId={workspace.id} {seats} onchanged={reload} />
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
