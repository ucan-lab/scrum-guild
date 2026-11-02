<script lang="ts">
  import { tick } from 'svelte';
  import { goto, invalidate } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { operationPath, type OutputOf } from '../../shared/operations/define.ts';
  import { myOrganizations } from '../../shared/operations/organization/index.ts';
  import { invitationAccept, invitationDecline, invitationList } from '../../shared/operations/workspace/index.ts';
  import { callOperation } from '../api.ts';
  import { focusPageHeading } from '../focus-heading.ts';
  import { invitationErrorText, invitationRoleLabel } from '../invitation-text.ts';
  import { isUnauthenticated, loginUrl } from '../login-redirect.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // マイプロフィールの画面（me.html）の「届いた招待」。この組織のワークスペースへの承諾待ちの招待（invitation-list）を、1件ずつ
  // 囲みの知らせ（.callout.is-info）で本文の先頭に並べる。承諾と辞退は招待の画面（InvitationInbox）と同じ操作と同じ文言。
  // 招待が無ければ何も出さない。読めなかったときは、囲みの警告と「もう一度試す」だけを出し、ほかの節は生かす。
  // 承諾したら招待の画面と同じに、トーストを出してそのワークスペースへ、すべての load を読み直して移る。
  // 辞退したらトーストを出し、一覧をこの節の中だけで読み直す（画面のほかの節は読み直さない）。組織の枠のメニューの件数は、
  // 組織の選択（my-organizations）を読み直して変える。残った招待の最初のボタンへ、無ければ画面の見出しへフォーカスを移す。
  // 失敗は理由を role="alert" で出し、一覧を読み直す。送っている間は、どのボタンも押しても無視する。
  // 別の組織に届いた招待は、組織の切り替えから組織の選択の画面を開いて見る（ここには出さない）
  let { slug, list }: { slug: string; list: OutputOf<typeof invitationList> | null } = $props();

  type Invitation = OutputOf<typeof invitationList>['invitations'][number];

  // 今の一覧。load が替わったら（画面の移動）その値に戻し、読み直しはこの節だけを書き換える
  let current = $state<OutputOf<typeof invitationList> | null>(null);
  let sending = $state<{ id: string; action: 'accept' | 'decline' } | null>(null);
  let retrying = $state(false);
  let error = $state<string | null>(null);
  let status = $state('');

  // 組織の枠だけが読み直されたとき（件数の更新、テーマの保存）は、load の値が同じ参照のままなので、読み直した一覧を捨てない
  let seen: OutputOf<typeof invitationList> | null | undefined;
  $effect.pre(() => {
    if (list === seen) return;
    seen = list;
    current = list;
    error = null;
    status = '';
  });

  function isSending(invitation: Invitation, action: 'accept' | 'decline'): boolean {
    return sending?.id === invitation.invitation_id && sending.action === action;
  }

  async function reread(): Promise<boolean> {
    const result = await callOperation(invitationList, {}, { slug });
    if (!result.ok && isUnauthenticated(result)) {
      window.location.assign(loginUrl(page.url));
      return false;
    }
    if (result.ok) current = result.data;
    return result.ok;
  }

  // 組織の枠のメニューの件数を読み直す（組織の枠は組織の選択を読むとき、招待があれば件数を数え直す）
  async function refreshFrame(): Promise<void> {
    const path = operationPath(myOrganizations);
    await invalidate((url) => url.pathname === path);
  }

  // 読み直した後のフォーカス。残った招待の押せる最初のボタンへ、無ければ画面の見出しへ
  async function restoreFocus(): Promise<void> {
    await tick();
    const button = document.querySelector<HTMLButtonElement>('[data-invitation-row] button:not([disabled])');
    if (button) button.focus();
    else focusPageHeading();
  }

  async function retry(): Promise<void> {
    if (retrying) return;
    retrying = true;
    try {
      if (await reread()) {
        await refreshFrame();
        await restoreFocus();
      }
    } finally {
      retrying = false;
    }
  }

  async function send(invitation: Invitation, action: 'accept' | 'decline'): Promise<void> {
    if (sending !== null) return;
    if (action === 'accept' && invitation.closed) return;
    const invitationId = invitation.invitation_id;
    const sentSlug = slug;
    sending = { id: invitationId, action };
    error = null;
    status = action === 'accept' ? t('invitationAccepting') : t('invitationDeclining');
    try {
      const input = { invitation_id: invitationId };
      const result =
        action === 'accept'
          ? await callOperation(invitationAccept, input, { slug: sentSlug })
          : await callOperation(invitationDecline, input, { slug: sentSlug });
      if (sentSlug !== slug) return;
      if (!result.ok && isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url));
        return;
      }
      status = '';
      if (result.ok) {
        if (action === 'accept' && 'workspace_id' in result.data) {
          showToast(t('invitationAccepted'), 'check');
          await goto(resolve('/[slug]/w/[id]', { slug: sentSlug, id: result.data.workspace_id }), { refreshAll: true });
          return;
        }
        showToast(t('invitationDeclined'), 'check');
      } else {
        error = invitationErrorText(result);
      }
      // 承諾か辞退が通ったときも、失敗したとき（取り消された、状態が変わっていた）も、一覧を読み直す
      await reread();
      await refreshFrame();
      await restoreFocus();
    } finally {
      sending = null;
    }
  }
</script>

{#if current === null}
  <div class="callout is-warn">
    <Icon name="alert" /><span>{t('meInvitationsFailed')}</span>
    <div class="callout-actions">
      <button
        class="btn is-sm"
        type="button"
        aria-label={retrying ? t('loading') : t('retrySection', { section: t('invitationsHeading') })}
        aria-disabled={retrying}
        onclick={retry}>{retrying ? t('loading') : t('retry')}</button
      >
    </div>
  </div>
{:else}
  {#if error}
    <div class="callout is-warn"><Icon name="alert" /><span role="alert">{error}</span></div>
  {/if}
  {#each current.invitations as invitation (invitation.invitation_id)}
    <div class="callout is-info" data-invitation-row={invitation.invitation_id}>
      <Icon name="mail" />
      <span class="wrap-anywhere">
        {t('meInvitationLine', {
          organization: current.organization.name,
          inviter: invitation.invited_by_name,
          workspace: invitation.workspace_name,
          role: invitationRoleLabel(invitation.role),
          date: invitation.invited_on,
        })}
        {#if invitation.closed}{t('invitationInboxClosed', { workspace: t('workspace') })}{/if}
      </span>
      <div class="callout-actions">
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
  {/each}
{/if}
<!-- 送っている間を読み上げに伝える。領域は常に置き、中の文字だけを替える -->
<span class="visually-hidden" role="status">{status}</span>
