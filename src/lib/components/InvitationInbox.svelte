<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { callOperation } from '../api.ts';
  import { isUnauthenticated, loginUrl } from '../login-redirect.ts';
  import { applyInvitedOrganization } from '../organization.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import type { OutputOf } from '../../shared/operations/define.ts';
  import { invitationAccept, invitationDecline, type invitationList } from '../../shared/operations/workspace/index.ts';
  import EmptyState from './EmptyState.svelte';
  import Gate from './Gate.svelte';
  import GateSheet from './GateSheet.svelte';
  import Icon from './Icon.svelte';
  import LogoutButton from './LogoutButton.svelte';

  // 招待の画面（見本は design/login.html の「届いた招待」）。組織の枠の外の、枠の無い画面で、この組織に自分宛てに届いた
  // 承諾待ちの招待を並べ、承諾と辞退を送る。/<slug>/invitations のページと、組織に入れず招待だけがある人の組織の枠が使う。
  // member は組織に入れる人か。入れない人（招待だけの人）には、invitation-list が返す組織の言葉づかいとテーマを当てる
  // （入れる人には、組織の枠が organization の操作の結果を当てている）。
  // 承諾したらそのワークスペースへ移る。辞退して招待が残らなければ、招待だけの人は組織の選択へ、入れる人は組織の画面へ移る。
  // 失敗は理由を role="alert" で出し、一覧を読み直す。送っている間は、どのボタンも押しても無視する
  let { slug, list, member }: { slug: string; list: OutputOf<typeof invitationList>; member: boolean } = $props();

  type Invitation = (typeof list.invitations)[number];

  let sending = $state<{ id: string; action: 'accept' | 'decline' } | null>(null);
  let error = $state<string | null>(null);
  let status = $state('');

  $effect.pre(() => {
    if (!member) applyInvitedOrganization(list.organization);
  });

  function roleLabel(role: Invitation['role']): string {
    return role === 'leader' ? t('leader') : t('roleMember');
  }

  // 失敗の理由。どれも読み直した一覧を見れば、次にできることが分かる
  function errorText(result: { status: number; error?: { code: string } | null }): string {
    const words = { workspace: t('workspace') };
    if (result.status === 0) return t('invitationErrorUnreachable');
    switch (result.error?.code) {
      case 'not_found':
        return t('invitationErrorNotFound');
      case 'conflict':
        return t('invitationErrorChanged');
      case 'workspace_closed':
        return t('invitationErrorClosed', words);
      case 'already_member':
        return t('invitationErrorAlreadyMember', words);
      default:
        return t('invitationErrorFailed');
    }
  }

  async function send(invitation: Invitation, action: 'accept' | 'decline'): Promise<void> {
    if (sending !== null) return;
    if (action === 'accept' && invitation.closed) return;
    sending = { id: invitation.invitation_id, action };
    error = null;
    status = action === 'accept' ? t('invitationAccepting') : t('invitationDeclining');
    try {
      const input = { invitation_id: invitation.invitation_id };
      const result =
        action === 'accept'
          ? await callOperation(invitationAccept, input, { slug })
          : await callOperation(invitationDecline, input, { slug });
      if (!result.ok && isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url));
        return;
      }
      if (result.ok) {
        if (action === 'accept' && 'workspace_id' in result.data) {
          await goto(resolve('/[slug]/w/[id]', { slug, id: result.data.workspace_id }), { invalidateAll: true });
          return;
        }
        const remaining = list.invitations.filter((item) => item.invitation_id !== invitation.invitation_id);
        if (remaining.length === 0) {
          await goto(member ? resolve('/[slug]', { slug }) : resolve('/'), { invalidateAll: true });
          return;
        }
        status = t('invitationDeclined');
        await invalidateAll();
        return;
      }
      error = errorText(result);
      status = '';
      await invalidateAll();
    } finally {
      sending = null;
    }
  }
</script>

<svelte:head>
  <title>{t('pageTitle', { page: t('invitationsHeading'), app: t('appName') })}</title>
</svelte:head>

<Gate keepsOrganization>
  <GateSheet brand title={t('invitationsHeading')}>
    <p class="wrap-anywhere">
      {t('invitationInboxLead', { organization: list.organization.name, workspace: t('workspace') })}
    </p>
    {#if error}
      <div class="callout is-warn" role="alert"><Icon name="alert" /><span>{error}</span></div>
    {/if}
    {#if list.invitations.length === 0}
      <EmptyState icon="mail" title={t('invitationInboxEmptyTitle')} text={t('invitationInboxEmptyText')} />
    {:else}
      <div class="choice-list">
        {#each list.invitations as invitation (invitation.invitation_id)}
          <div class="choice is-static">
            <div>
              <b>{invitation.workspace_name}</b>
              <span>
                {t('invitationInboxMeta', {
                  organization: list.organization.name,
                  inviter: invitation.invited_by_name,
                  role: roleLabel(invitation.role),
                  date: invitation.invited_on,
                })}
              </span>
              {#if invitation.closed}
                <span>{t('invitationInboxClosed', { workspace: t('workspace') })}</span>
              {/if}
              <div class="form-actions">
                <button
                  class="btn is-primary is-sm"
                  type="button"
                  disabled={invitation.closed}
                  aria-disabled={sending !== null}
                  aria-label={t('invitationAcceptLabel', { name: invitation.workspace_name })}
                  onclick={() => send(invitation, 'accept')}
                >
                  {sending?.id === invitation.invitation_id && sending.action === 'accept'
                    ? t('invitationAccepting')
                    : t('invitationAccept')}
                </button>
                <button
                  class="btn is-quiet is-sm"
                  type="button"
                  aria-disabled={sending !== null}
                  aria-label={t('invitationDeclineLabel', { name: invitation.workspace_name })}
                  onclick={() => send(invitation, 'decline')}
                >
                  {sending?.id === invitation.invitation_id && sending.action === 'decline'
                    ? t('invitationDeclining')
                    : t('invitationDecline')}
                </button>
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}
    <span class="visually-hidden" role="status">{status}</span>
    <div class="form-actions">
      {#if member}
        <a class="btn is-sm" href={resolve('/[slug]', { slug })}>
          {t('invitationInboxBack', { organization: list.organization.name })}
        </a>
      {/if}
      <a class="btn is-sm" href={resolve('/')}>{t('organizationList')}</a>
      <LogoutButton />
    </div>
  </GateSheet>
</Gate>
