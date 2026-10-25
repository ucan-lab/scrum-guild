<script lang="ts">
  import Avatar from '../../../../../lib/components/Avatar.svelte';
  import EmptyState from '../../../../../lib/components/EmptyState.svelte';
  import LoadFailed from '../../../../../lib/components/LoadFailed.svelte';
  import PageHead from '../../../../../lib/components/PageHead.svelte';
  import Section from '../../../../../lib/components/Section.svelte';
  import { t } from '../../../../../lib/vocabulary.svelte.ts';
  import type { PageProps } from './$types';

  // メンバーの画面（members.html の「所属している人」の節と頭の数字）。名前（アバター付き）、ロール、参加日を文字で出す。
  // 承諾待ちの招待は、リーダーと管理者にだけ API が返す（一般のメンバーは null）ので、null のときは節も「招待中」の数も出さない。
  // ロールの付け替え、外す、抜ける、配分、招待する は、それぞれの Issue で足す
  let { data }: PageProps = $props();

  const workspace = $derived(data.workspace);
  const members = $derived(data.members);
  const invitations = $derived(data.invitations);

  const leaderCount = $derived(members?.filter((member) => member.role === 'leader').length ?? 0);
  const tallies = $derived([
    { label: t('membersTallyBelonging'), count: members?.length ?? 0, icon: 'users' as const },
    { label: t('leader'), count: leaderCount },
    ...(invitations === null
      ? []
      : [{ label: t('membersTallyInvited'), count: invitations.length, icon: 'mail' as const }]),
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
      <EmptyState icon="users" title={t('membersEmptyTitle')} />
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
                  ><span class="person"><Avatar userId={member.id} name={member.name} />{member.name}</span></td
                >
                <td>{member.role === 'leader' ? t('leader') : t('roleMember')}</td>
                <td class="mono">{member.joined_on}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </Section>

  {#if invitations !== null}
    <Section
      id="members-invitations"
      title={t('invitationsSectionTitle')}
      hint={t('invitationsSectionHint', { leader: t('leader'), admin: t('admin') })}
    >
      {#if invitations.length === 0}
        <EmptyState icon="mail" title={t('invitationsEmptyTitle')} text={t('invitationsEmptyText')} />
      {:else}
        <div class="table-wrap">
          <table class="table" aria-label={t('invitationsTableLabel')}>
            <thead>
              <tr>
                <th class="is-name">{t('invitationNameHeader')}</th>
                <th>{t('invitationViaHeader')}</th>
                <th>{t('memberRoleHeader')}</th>
                <th>{t('invitedOnHeader')}</th>
              </tr>
            </thead>
            <tbody>
              {#each invitations as invitation (invitation.id)}
                <tr>
                  <td class="is-name mono">{invitation.login_name}</td>
                  <td>{invitation.login_provider === 'google' ? t('loginProviderGoogle') : t('loginProviderGithub')}</td
                  >
                  <td>{invitation.role === 'leader' ? t('leader') : t('roleMember')}</td>
                  <td class="mono">{invitation.invited_on}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </Section>
  {/if}
{/if}
