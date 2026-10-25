<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { workspaceList, workspaceReopen } from '../../../shared/operations/workspace/index.ts';
  import type { OutputOf } from '../../../shared/operations/define.ts';
  import type { Vocabulary } from '../../../shared/vocabulary.ts';
  import { callOperation } from '../../api.ts';
  import { formatLocalDate } from '../../format.ts';
  import { isUnauthenticated, loginUrl } from '../../login-redirect.ts';
  import { showToast } from '../../toast.svelte.ts';
  import { t } from '../../vocabulary.svelte.ts';
  import EmptyState from '../EmptyState.svelte';
  import Icon from '../Icon.svelte';
  import Setting from '../Setting.svelte';
  import WorkspaceCreateDialog from '../WorkspaceCreateDialog.svelte';
  import WorkspaceCloseDialog from './WorkspaceCloseDialog.svelte';

  // 組織の管理の画面（admin.html）のワークスペースの節。自分で workspace-list を呼び、読み込み中、失敗、空の状態を節の中に持つ
  // （ほかの節が読めなくても、読めた節は出る）。ほかの節の部品も同じ形で、画面（+page.svelte）には並べるだけにする。
  // 初回の読み込みだけ「読み込んでいます」を出し、閉じる／開き直す／作るの後の読み直しは、一覧を残したまま入れ替える
  // （押したボタンを消さず、フォーカスを保つ）。「閉じる」は確認のダイアログを経て、「開き直す」は確認なしで送る。
  // 操作を送っている間は、どの行のボタンも aria-disabled にして押しても無視する。
  // 401 は、今のパスを return_to に入れてログインへ移す。
  // 画面の見出しの集計と右上の「作る」は画面が持つので、開いている数は onopencount で渡し（読めるまでは null）、
  // 作るダイアログは showCreate で開く
  let {
    slug,
    meId,
    organizationVocabulary,
    onopencount,
  }: {
    slug: string;
    meId: string;
    organizationVocabulary: Vocabulary;
    onopencount: (count: number | null) => void;
  } = $props();

  type Workspace = OutputOf<typeof workspaceList>['workspaces'][number];

  let workspaces = $state<Workspace[]>([]);
  let loadState = $state<'loading' | 'ready' | 'failed'>('loading');
  // 失敗の後に読み直している最中と、読み直しても失敗したこと
  let retrying = $state(false);
  let retryFailed = $state(false);
  // 開き直す操作を送っている行
  let reopeningId = $state<string | null>(null);
  let createDialog = $state<ReturnType<typeof WorkspaceCreateDialog>>();
  let closeDialog = $state<ReturnType<typeof WorkspaceCloseDialog>>();
  // 閉じる確認の対象。ダイアログの結果を受けるとき、どの行だったかを名前で知らせるのに使う
  let closing = $state<Workspace | null>(null);

  // 読み込みの世代。slug が替わったときと部品が外れたときに進め、古い応答が今の状態を上書きしない
  let generation = 0;
  const currentSlug = $derived(slug);

  export function showCreate(trigger?: HTMLElement | null): void {
    createDialog?.show(trigger);
  }

  async function load(): Promise<void> {
    const mine = generation;
    const result = await callOperation(workspaceList, {}, { slug: currentSlug });
    if (mine !== generation) return;
    if (isUnauthenticated(result)) {
      window.location.assign(loginUrl(page.url));
      return;
    }
    if (!result.ok) {
      // 一覧を持っているときの読み直しの失敗は、今の一覧を残す（作る／閉じる／開き直すは成功している）
      if (loadState !== 'ready') loadState = 'failed';
      return;
    }
    workspaces = result.data.workspaces;
    onopencount(workspaces.filter((workspace) => workspace.closed_at === null).length);
    loadState = 'ready';
  }

  $effect(() => {
    void currentSlug;
    generation++;
    workspaces = [];
    onopencount(null);
    loadState = 'loading';
    reopeningId = null;
    void load();
    return () => {
      generation++;
    };
  });

  async function retry(): Promise<void> {
    if (retrying) return;
    retrying = true;
    retryFailed = false;
    try {
      await load();
    } finally {
      retrying = false;
    }
    retryFailed = loadState === 'failed';
  }

  async function reopen(workspace: Workspace): Promise<void> {
    if (reopeningId !== null) return;
    const mine = generation;
    reopeningId = workspace.id;
    try {
      const result = await callOperation(workspaceReopen, { workspace_id: workspace.id }, { slug: currentSlug });
      if (mine !== generation) return;
      if (result.ok) {
        showToast(t('workspaceReopened', { workspace: t('workspace') }), 'check');
      } else if (result.status === 401) {
        window.location.assign(loginUrl(page.url));
        return;
      } else if (result.status === 409 && result.error?.code === 'conflict') {
        // 別の画面で先に開き直されていた
        showToast(t('workspaceAlreadyOpen', { name: workspace.name }), 'alert');
      } else {
        showToast(t('workspaceReopenFailed', { workspace: t('workspace') }), 'alert');
      }
      await load();
    } finally {
      if (mine === generation) reopeningId = null;
    }
  }

  function closeFinished(workspace: string, outcome: 'closed' | 'already_closed' | 'unauthenticated'): void {
    if (outcome === 'unauthenticated') {
      window.location.assign(loginUrl(page.url));
      return;
    }
    showToast(
      outcome === 'closed'
        ? t('workspaceClosed', { workspace: t('workspace') })
        : t('workspaceAlreadyClosed', { name: workspace }),
      outcome === 'closed' ? 'check' : 'alert',
    );
    void load();
  }

  function act(workspace: Workspace, trigger: HTMLElement): void {
    if (reopeningId !== null) return;
    if (workspace.closed_at !== null) {
      void reopen(workspace);
      return;
    }
    closing = workspace;
    closeDialog?.show({ id: workspace.id, name: workspace.name }, trigger);
  }

  const status = $derived(reopeningId !== null ? t('workspaceReopening') : '');
  const failedStatus = $derived(retrying ? t('retrying') : retryFailed ? t('retryFailed') : '');
</script>

<Setting
  title={t('workspace')}
  description={t('adminWorkspacesDesc', { workspace: t('workspace'), member: t('member'), leader: t('leader') })}
>
  {#if loadState === 'loading'}
    <EmptyState icon="clock" title={t('loading')} />
  {:else if loadState === 'failed'}
    <EmptyState
      icon="alert"
      title={t('workspaceListLoadFailed', { workspace: t('workspace') })}
      text={t('loadFailedText')}
    >
      {#snippet actions()}
        <button class="btn is-sm" type="button" aria-disabled={retrying} onclick={retry}>{t('retry')}</button>
        <span class="field-hint" role="status">{failedStatus}</span>
      {/snippet}
    </EmptyState>
  {:else if workspaces.length === 0}
    <EmptyState
      icon="users"
      title={t('firstWorkspaceTitle', { workspace: t('workspace') })}
      text={t('workspaceEmptyText', { workspace: t('workspace'), leader: t('leader'), member: t('member') })}
    >
      {#snippet actions()}
        <button class="btn is-sm" type="button" onclick={(event) => createDialog?.show(event.currentTarget)}>
          <Icon name="plus" />{t('workspaceCreateAction', { workspace: t('workspace') })}
        </button>
      {/snippet}
    </EmptyState>
  {:else}
    <div class="table-wrap">
      <table class="table" aria-label={t('workspaceListLabel', { workspace: t('workspace') })}>
        <thead>
          <tr>
            <th class="is-name">{t('fieldName')}</th>
            <th class="is-num">{t('workspaceMemberCountHeader', { member: t('member') })}</th>
            <th class="is-num">{t('workspaceLeaderCountHeader', { leader: t('leader') })}</th>
            <th>{t('createdOn')}</th>
            <th><span class="visually-hidden">{t('workspaceActionsHeader')}</span></th>
          </tr>
        </thead>
        <tbody>
          {#each workspaces as workspace (workspace.id)}
            <tr>
              <td class="is-name">
                <a href={resolve('/[slug]/w/[id]', { slug: currentSlug, id: workspace.id })}>{workspace.name}</a>
                {#if workspace.closed_at !== null}
                  <span class="chip">{t('workspaceClosedChip', { date: formatLocalDate(workspace.closed_at) })}</span>
                {:else if workspace.leader_count === 0}
                  <span class="chip is-warn">{t('workspaceNoLeaderChip', { leader: t('leader') })}</span>
                {/if}
              </td>
              <td class="is-num">{workspace.member_count}</td>
              <td class="is-num">{workspace.leader_count}</td>
              <td class="mono">{workspace.created_on}</td>
              <td>
                <!-- 閉じた行は「開き直す」、開いている行は「閉じる」。同じ要素のまま文字だけを替え、読み直しでフォーカスを失わない。
                     読み上げの名前に、どのワークスペースかを添える -->
                <button
                  class="btn is-sm is-quiet"
                  type="button"
                  aria-disabled={reopeningId !== null}
                  aria-label={workspace.closed_at !== null
                    ? t('workspaceReopenLabel', { name: workspace.name })
                    : t('workspaceCloseLabel', { name: workspace.name })}
                  onclick={(event) => act(workspace, event.currentTarget)}
                >
                  {workspace.closed_at !== null ? t('workspaceReopenAction') : t('workspaceCloseAction')}
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
  <!-- 開き直しを送っている間の読み上げ。領域は常に置き、中の文字だけを替える -->
  <span class="visually-hidden" role="status">{status}</span>
</Setting>

<WorkspaceCreateDialog bind:this={createDialog} {slug} {meId} {organizationVocabulary} />
<WorkspaceCloseDialog
  bind:this={closeDialog}
  {slug}
  onfinish={(outcome) => closeFinished(closing?.name ?? '', outcome)}
/>
