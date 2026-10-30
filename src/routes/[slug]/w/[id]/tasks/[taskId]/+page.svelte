<script lang="ts">
  import { tick } from 'svelte';
  import { afterNavigate, goto, invalidate } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import TaskDrawer from '../../../../../../lib/components/TaskDrawer.svelte';
  import { setTaskOpenMode, type TaskOpenMode } from '../../../../../../lib/drawer.svelte.ts';
  import { focusPageHeading } from '../../../../../../lib/focus-heading.ts';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const workspace = $derived(data.workspace);
  let returnTo: string | null = null;
  afterNavigate(({ from }) => {
    if (from && !from.params?.taskId) {
      const url = new URL(from.url);
      url.searchParams.delete('task');
      returnTo = url.pathname + url.search + url.hash;
    }
  });

  function destination(): string {
    return returnTo ?? resolve('/[slug]/w/[id]', { slug: data.slug, id: page.params.id ?? '' });
  }

  async function close(removed = false): Promise<void> {
    const id = page.params.taskId ?? '';
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- アプリ内で来た解決済みの URL か resolve したバックログ
    await goto(destination(), { replace: true, reset: false });
    if (removed) await invalidate('app:backlog-tree');
    await tick();
    const row = !removed && document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`);
    if (row) row.focus();
    else focusPageHeading();
  }

  function changeMode(mode: TaskOpenMode): void {
    setTaskOpenMode(mode);
    if (mode === 'tab') {
      window.open(page.url.pathname, '_blank', 'noopener,noreferrer');
      void close();
    } else if (mode !== 'page') {
      const url = new URL(destination(), location.origin);
      url.searchParams.set('task', page.params.taskId ?? '');
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- 戻り先の解決済み URL にタスクの問い合わせだけを足す
      void goto(url, { replace: true, reset: false });
    }
  }
</script>

{#if workspace}
  {#key page.params.taskId}
    <TaskDrawer
      mode="page"
      onmode={changeMode}
      slug={data.slug}
      workspaceId={workspace.id}
      taskId={page.params.taskId ?? ''}
      currentUserId={data.organization?.me.id ?? null}
      canWrite={workspace.closedAt === null}
      definitionOfDone={workspace.definitionOfDone}
      onclose={() => void close()}
      onchanged={() => void invalidate('app:backlog-tree')}
      onstale={() => void invalidate('app:workspace')}
      onremoved={() => void close(true)}
    />
  {/key}
{/if}
