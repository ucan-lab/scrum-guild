<script lang="ts">
  import { tick } from 'svelte';
  import { goto, invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { callOperation } from '../api.ts';
  import { isUnauthenticated, loginUrl } from '../login-redirect.ts';
  import { applyInvitedOrganization } from '../organization.svelte.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import type { OutputOf } from '../../shared/operations/define.ts';
  import { invitationAccept, invitationDecline, invitationList } from '../../shared/operations/workspace/index.ts';
  import EmptyState from './EmptyState.svelte';
  import Gate from './Gate.svelte';
  import GateSheet from './GateSheet.svelte';
  import Icon from './Icon.svelte';
  import LogoutButton from './LogoutButton.svelte';

  // 招待の画面（見本は design/login.html の「届いた招待」）。組織の枠の外の、枠の無い画面で、この組織に自分宛てに届いた
  // 承諾待ちの招待を並べ、承諾と辞退を送る。/<slug>/invitations のページと、組織に入れず招待だけがある人の組織の枠が使う。
  // member は組織に入れる人か。入れない人（招待だけの人）には、invitation-list が返す組織の言葉づかいとテーマを当てる
  // （入れる人には、組織の枠が organization の操作の結果を当てている）。
  // 結果はトーストで知らせる。トーストは root のレイアウトにあるので、画面が移った後も残る。
  // 承諾したらそのワークスペースへ移る。辞退して招待が残らなければ、招待だけの人は組織の選択へ、入れる人は組織の画面へ移る。
  // 失敗は理由を role="alert" で出し、一覧を読み直す。ただし招待だけの人で、読み直すと招待が残らない（組織の枠が
  // 「見つからない」になり、理由が消える）ときは、理由をトーストで出して組織の選択へ移る。
  // 送っている間は、どのボタンも押しても無視する
  let { slug, list, member }: { slug: string; list: OutputOf<typeof invitationList>; member: boolean } = $props();

  type Invitation = (typeof list.invitations)[number];

  let sending = $state<{ id: string; action: 'accept' | 'decline' } | null>(null);
  let error = $state<string | null>(null);
  let status = $state('');
  let backLink = $state<HTMLAnchorElement>();

  $effect.pre(() => {
    if (!member) applyInvitedOrganization(list.organization);
  });

  function roleLabel(role: Invitation['role']): string {
    return role === 'leader' ? t('leader') : t('roleMember');
  }

  function isSending(invitation: Invitation, action: 'accept' | 'decline'): boolean {
    return sending?.id === invitation.invitation_id && sending.action === action;
  }

  // 失敗の理由
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

  // 招待だけの人の招待が残っていないか。残っていなければ、読み直すと組織に入れず「見つからない」になる
  async function noInvitationLeft(): Promise<boolean> {
    const latest = await callOperation(invitationList, {}, { slug });
    return latest.ok ? latest.data.invitations.length === 0 : latest.status === 404;
  }

  // 読み直した後のフォーカス。押した行が残り、押せるボタンがあればそこに、行が消えたら同じ位置の行（無ければ前の行）の
  // 押せる最初のボタンに、行が1つも無ければ紙の下の戻るリンクに置く
  async function restoreFocus(invitationId: string, index: number): Promise<void> {
    await tick();
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-invitation-row]'));
    const same = rows.find((row) => row.dataset.invitationRow === invitationId);
    if (same !== undefined && same.contains(document.activeElement)) {
      const active = document.activeElement as HTMLButtonElement;
      if (!active.disabled) return;
    }
    const row = same ?? rows[Math.min(Math.max(index, 0), rows.length - 1)];
    const target = row?.querySelector<HTMLButtonElement>('button:not([disabled])');
    if (target) target.focus();
    else backLink?.focus();
  }

  async function send(invitation: Invitation, action: 'accept' | 'decline'): Promise<void> {
    if (sending !== null) return;
    if (action === 'accept' && invitation.closed) return;
    const invitationId = invitation.invitation_id;
    const index = list.invitations.findIndex((item) => item.invitation_id === invitationId);
    sending = { id: invitationId, action };
    error = null;
    status = action === 'accept' ? t('invitationAccepting') : t('invitationDeclining');
    try {
      const input = { invitation_id: invitationId };
      const result =
        action === 'accept'
          ? await callOperation(invitationAccept, input, { slug })
          : await callOperation(invitationDecline, input, { slug });
      if (!result.ok && isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url));
        return;
      }
      status = '';
      if (result.ok) {
        if (action === 'accept' && 'workspace_id' in result.data) {
          showToast(t('invitationAccepted'), 'check');
          await goto(resolve('/[slug]/w/[id]', { slug, id: result.data.workspace_id }), { refreshAll: true });
          return;
        }
        showToast(t('invitationDeclined'), 'check');
        const remaining = list.invitations.filter((item) => item.invitation_id !== invitationId);
        if (remaining.length === 0) {
          // 招待だけの人は組織の選択へ移る。入れる組織も招待も残っていなければ、そこでセッションが消えてログインの画面へ戻るが、
          // トーストは移った後も残るので、辞退したことは伝わる
          await goto(member ? resolve('/[slug]', { slug }) : resolve('/'), { refreshAll: true });
          return;
        }
        await invalidateAll();
        await restoreFocus(invitationId, index);
        return;
      }
      const reason = errorText(result);
      if (!member && (await noInvitationLeft())) {
        showToast(reason, 'alert');
        await goto(resolve('/'), { refreshAll: true });
        return;
      }
      // 理由は読み直しが済んでから出す（出した理由と並ぶ一覧が、読み直した後のものになるように）
      await invalidateAll();
      error = reason;
      await restoreFocus(invitationId, index);
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
          <div class="choice is-static" data-invitation-row={invitation.invitation_id}>
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
                <!-- 送っている間は、読み上げの名前も見える文言と同じにする -->
                <button
                  class="btn is-primary is-sm"
                  type="button"
                  disabled={invitation.closed}
                  aria-disabled={sending !== null}
                  aria-label={isSending(invitation, 'accept')
                    ? t('invitationAccepting')
                    : t('invitationAcceptLabel', { name: invitation.workspace_name })}
                  onclick={() => send(invitation, 'accept')}
                >
                  {isSending(invitation, 'accept') ? t('invitationAccepting') : t('invitationAccept')}
                </button>
                <button
                  class="btn is-quiet is-sm"
                  type="button"
                  aria-disabled={sending !== null}
                  aria-label={isSending(invitation, 'decline')
                    ? t('invitationDeclining')
                    : t('invitationDeclineLabel', { name: invitation.workspace_name })}
                  onclick={() => send(invitation, 'decline')}
                >
                  {isSending(invitation, 'decline') ? t('invitationDeclining') : t('invitationDecline')}
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
        <a class="btn is-sm" href={resolve('/[slug]', { slug })} bind:this={backLink}>{t('invitationInboxBack')}</a>
        <a class="btn is-sm" href={resolve('/')}>{t('organizationList')}</a>
      {:else}
        <a class="btn is-sm" href={resolve('/')} bind:this={backLink}>{t('organizationList')}</a>
      {/if}
      <LogoutButton />
    </div>
  </GateSheet>
</Gate>
