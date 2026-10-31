<script lang="ts">
  import { getHealth } from '../../lib/api.ts';
  import Dialog from '../../lib/components/Dialog.svelte';
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import Icon from '../../lib/components/Icon.svelte';
  import PageHead from '../../lib/components/PageHead.svelte';
  import Section from '../../lib/components/Section.svelte';
  import WorkspaceCreateDialog from '../../lib/components/WorkspaceCreateDialog.svelte';
  import { showToast } from '../../lib/toast.svelte.ts';
  import { t } from '../../lib/vocabulary.svelte.ts';
  import type { PageProps } from './$types';

  // 自分の今日の仮の画面。枠と見出しと空の状態を部品で組み、API と画面がつながったことを示す。文言はすべて辞書を通す。
  // 今日やるタスクは API から取っていないので、件数や「所属すると並ぶ」といった事実は書かない。
  // 空の状態は管理者の場合を分ける。組織にワークスペースが1つも無いときは、最初のワークスペースを作る案内。
  // ワークスペースはあるが所属が0件のときは、所属が無いことの案内。最初のワークスペースを作る案内には、作るダイアログを開くボタンを置く
  let { data }: PageProps = $props();

  let createDialog = $state<ReturnType<typeof WorkspaceCreateDialog>>();

  const emptyKind = $derived.by(() => {
    const view = data.organization;
    if (view === null || !view.me.is_admin) return 'default';
    if (!view.organization.has_workspaces) return 'firstWorkspace';
    return view.workspaces.length === 0 ? 'noMembership' : 'default';
  });

  let health = $state(getHealth());
  let checking = $state(false);
  let detailOpen = $state(false);
  let detailDialog = $state<ReturnType<typeof Dialog>>();

  // 結果が出てから、成功と失敗を分けて知らせる。確かめている間は押せない
  async function recheck(): Promise<void> {
    checking = true;
    const next = getHealth();
    health = next;
    const result = await next.catch(() => null);
    checking = false;
    if (result?.ok) showToast(t('apiRecheckOk'), 'check');
    else showToast(t('apiRecheckFailed'), 'alert');
  }
</script>

<svelte:head>
  <title>{t('pageTitle', { page: t('pageToday'), app: t('appName') })}</title>
</svelte:head>

<PageHead title={t('pageToday')} />

<Section id="s-today" title={t('sectionToday')} hint={t('sectionTodayHint')}>
  {#if emptyKind === 'firstWorkspace'}
    <EmptyState
      icon="sun"
      art="map"
      title={t('firstWorkspaceTitle', { workspace: t('workspace') })}
      text={t('firstWorkspaceText', { workspace: t('workspace'), leader: t('leader') })}
    >
      {#snippet actions()}
        <button class="btn is-sm" type="button" onclick={(event) => createDialog?.show(event.currentTarget)}>
          <Icon name="plus" />{t('workspaceCreateAction', { workspace: t('workspace') })}
        </button>
      {/snippet}
    </EmptyState>
  {:else if emptyKind === 'noMembership'}
    <EmptyState
      icon="sun"
      art="notice"
      title={t('noMembershipTitle', { workspace: t('workspace') })}
      text={t('noMembershipText', { workspace: t('workspace') })}
    />
  {:else}
    <EmptyState icon="sun" art="notice" title={t('todayEmptyTitle')} text={t('todayEmptyText')} />
  {/if}
</Section>

<Section id="s-api" title={t('apiHeading')}>
  <p role="status" class="wrap-anywhere">
    {#await health}
      {t('apiChecking')}
    {:then result}
      {#if result.ok}
        {t('apiStatus', { status: result.data.status, version: result.data.version })}
      {:else}
        {t('apiUnreachableStatus', { status: result.status })}
      {/if}
    {:catch}
      {t('apiUnreachable')}
    {/await}
  </p>
  <div class="form-actions">
    <!-- Safari と Firefox はクリックでボタンにフォーカスを移さないので、開く操作を起こしたボタンを渡す -->
    <button class="btn is-sm" type="button" onclick={(event) => detailDialog?.show(event.currentTarget)}>
      {t('apiShowDetail')}
    </button>
    <button class="btn is-sm" type="button" disabled={checking} onclick={recheck}>{t('apiRecheck')}</button>
  </div>
</Section>

{#if data.organization?.me.is_admin}
  <WorkspaceCreateDialog bind:this={createDialog} slug={data.slug} meId={data.organization.me.id} />
{/if}

<Dialog bind:this={detailDialog} bind:open={detailOpen} title={t('apiDetailTitle')}>
  <p>{t('apiDetailBody')}</p>
  <!-- ダイアログは閉じていても中身を描くので、ここでも拒否を受けないと処理されない例外になる -->
  {#await health then result}
    <p class="mono wrap-anywhere">{JSON.stringify(result)}</p>
  {:catch}
    <p>{t('apiUnreachable')}</p>
  {/await}
  {#snippet footer(close)}
    <button class="btn" type="button" disabled={checking} onclick={recheck}>{t('apiRecheck')}</button>
    <button class="btn is-primary" type="button" onclick={close}>{t('close')}</button>
  {/snippet}
</Dialog>
