<script lang="ts">
  import { tick } from 'svelte';
  import { thanksSend, thanksRevoke, type TaskDetail } from '../../shared/operations/task/index.ts';
  import { callOperation } from '../api.ts';
  import { thanksErrorKey } from '../thanks-error.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Avatar from './Avatar.svelte';
  import Icon from './Icon.svelte';

  let {
    slug,
    workspaceId,
    task,
    currentUserId,
    canWrite,
    candidates,
    candidatesLoading,
    candidatesFailed,
    onretry,
    onrefresh,
    onstale,
  }: {
    slug: string;
    workspaceId: string;
    task: TaskDetail;
    currentUserId: string | null;
    canWrite: boolean;
    candidates: readonly { id: string; name: string }[] | null;
    candidatesLoading: boolean;
    candidatesFailed: boolean;
    onretry: () => void;
    onrefresh: () => Promise<TaskDetail | null>;
    onstale: () => void;
  } = $props();
  const ids = $props.id();
  let heading = $state<HTMLElement>();
  let sending = $state(false);
  let error = $state<string | null>(null);
  let alive = true;
  $effect(() => () => {
    alive = false;
  });
  const writable = $derived(canWrite && task.completed_at === null && task.can_send_thanks);
  const recipients = $derived(
    (candidates ?? []).filter(
      (person) => person.id !== currentUserId && !task.thanks.some((thanks) => thanks.recipient.id === person.id),
    ),
  );

  async function change(id: string, revoke: boolean): Promise<void> {
    if (sending || !writable) return;
    sending = true;
    error = null;
    const result = revoke
      ? await callOperation(thanksRevoke, { workspace_id: workspaceId, thanks_id: id }, { slug })
      : await callOperation(
          thanksSend,
          { workspace_id: workspaceId, task_id: task.id, recipient_user_id: id },
          { slug },
        );
    if (result.ok) {
      showToast(t(revoke ? 'thanksRevoked' : 'thanksSent'), 'check');
      const refreshed = await onrefresh();
      if (alive && refreshed === null) error = t('thanksRefreshFailed');
    } else {
      const message = t(thanksErrorKey(result.status, result.error?.code, result.error?.details), {
        task: t('task'),
        workspace: t('workspace'),
      });
      if (alive) error = message;
      else showToast(message, 'alert');
      if (result.status === 401 || result.error?.code === 'workspace_closed') onstale();
      else if ([403, 404, 409].includes(result.status)) await onrefresh();
    }
    if (!alive) return;
    sending = false;
    await tick();
    // 押した送付・取消ボタンが消えても、感謝の欄からキーボード操作を続けられる。
    heading?.focus();
  }
</script>

<section class="field wrap-anywhere" aria-labelledby={`${ids}-thanks`} aria-busy={sending}>
  <h3 class="field-label" id={`${ids}-thanks`} tabindex="-1" bind:this={heading}><Icon name="heart" />{t('thanks')}</h3>
  {#if task.thanks.length === 0}
    <p class="field-hint">{t('thanksEmpty')}</p>
  {:else}
    <ul>
      {#each task.thanks as thanks (thanks.id)}
        <li>
          <span>{t('thanksFromTo', { sender: thanks.sender.name, recipient: thanks.recipient.name })}</span>
          {#if writable && thanks.can_revoke}
            <button class="link-btn" type="button" disabled={sending} onclick={() => void change(thanks.id, true)}
              >{t('thanksRevoke', { name: thanks.recipient.name })}</button
            >
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if writable}
    <div class="thanks">
      {#each recipients as person (person.id)}
        <button class="btn is-sm" type="button" disabled={sending} onclick={() => void change(person.id, false)}
          ><Avatar userId={person.id} name={person.name} decorative />{t('thanksSend', { name: person.name })}</button
        >
      {/each}
    </div>
    {#if candidatesLoading}
      <p class="field-hint" role="status">{t('loading')}</p>
    {:else if candidatesFailed}
      <p class="field-error">{t('thanksCandidatesFailed')}</p>
      <button class="link-btn" type="button" onclick={onretry}>{t('retry')}</button>
    {:else if recipients.length === 0}
      <p class="field-hint">{t('thanksCandidatesEmpty')}</p>
    {/if}
  {/if}
  <p class="field-hint">{t('thanksHint', { assignee: t('assignee') })}</p>
  {#if error !== null}
    <p class="field-error" role="alert">{error}</p>
  {/if}
</section>
