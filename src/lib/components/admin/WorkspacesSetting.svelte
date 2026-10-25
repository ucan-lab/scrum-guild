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
  import SectionBoundary from './SectionBoundary.svelte';
  import { SectionLoad } from './section-load.svelte.ts';
  import WorkspaceCloseDialog from './WorkspaceCloseDialog.svelte';

  // 組織の管理の画面（admin.html）のワークスペースの節。読み込みの状態（読み込み中、失敗、読み直し、401、古い応答の破棄）は
  // SectionLoad、その表示は SectionBoundary に任せ、この部品は一覧と操作だけを持つ。
  // ほかの節の部品も同じ形にして、画面（+page.svelte）には並べるだけにする。
  // 初回の読み込みだけ「読み込んでいます」を出し、終了する／再開するの後の読み直しは、一覧を残したまま入れ替える
  // （押したボタンを消さず、フォーカスを保つ）。
  // 「終了する」は確認のダイアログを経て、「再開する」は確認なしで送る。
  // 操作を送っている間は、どの行のボタンも aria-disabled にして押しても無視する。
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

  // 組織の枠のデータを読み直すと slug の props は新しい getter になるが、値が同じなら $derived は変わらない
  const currentSlug = $derived(slug);

  let workspaces = $state<Workspace[]>([]);
  // 開き直す操作を送っている行
  let reopeningId = $state<string | null>(null);
  let createDialog = $state<ReturnType<typeof WorkspaceCreateDialog>>();
  let closeDialog = $state<ReturnType<typeof WorkspaceCloseDialog>>();
  // 閉じる確認の対象。ダイアログの結果を受けるとき、どの行だったかを名前で知らせるのに使う
  let closing = $state<Workspace | null>(null);

  const section = new SectionLoad(
    () => callOperation(workspaceList, {}, { slug: currentSlug }),
    (data) => {
      workspaces = data.workspaces;
      onopencount(data.workspaces.filter((workspace) => workspace.closed_at === null).length);
    },
  );

  export function showCreate(trigger?: HTMLElement | null): void {
    createDialog?.show(trigger);
  }

  // slug が替わったら、前の組織の一覧を捨てて読み直す
  section.attach(
    () => currentSlug,
    () => {
      workspaces = [];
      onopencount(null);
      reopeningId = null;
    },
  );

  async function reopen(workspace: Workspace): Promise<void> {
    if (reopeningId !== null) return;
    const token = section.token();
    reopeningId = workspace.id;
    try {
      const result = await callOperation(workspaceReopen, { workspace_id: workspace.id }, { slug: currentSlug });
      if (!section.isCurrent(token)) return;
      if (result.ok) {
        showToast(t('workspaceReopened', { workspace: t('workspace') }), 'check');
      } else if (isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url));
        return;
      } else if (result.status === 409 && result.error?.code === 'conflict') {
        // 別の画面で先に操作されていた。開き直されたのか、閉じ直されたのかは言い切らず、読み直した一覧を見てもらう
        showToast(t('workspaceStateChanged', { name: workspace.name }), 'alert');
      } else if (result.status === 404 || result.status === 403) {
        showToast(t('workspaceUnavailable', { name: workspace.name }), 'alert');
      } else {
        showToast(t('workspaceReopenFailed', { workspace: t('workspace') }), 'alert');
      }
      await section.load();
    } finally {
      if (section.isCurrent(token)) reopeningId = null;
    }
  }

  function closeFinished(name: string, outcome: 'closed' | 'state_changed' | 'unavailable' | 'unauthenticated'): void {
    if (outcome === 'unauthenticated') {
      window.location.assign(loginUrl(page.url));
      return;
    }
    if (outcome === 'closed') showToast(t('workspaceClosed', { workspace: t('workspace') }), 'check');
    else if (outcome === 'state_changed') showToast(t('workspaceStateChanged', { name }), 'alert');
    else showToast(t('workspaceUnavailable', { name }), 'alert');
    void section.load();
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
</script>

<Setting
  title={t('workspace')}
  description={t('adminWorkspacesDesc', { workspace: t('workspace'), member: t('member'), leader: t('leader') })}
>
  <SectionBoundary
    {section}
    failedTitle={t('workspaceListLoadFailed', { workspace: t('workspace') })}
    refreshFailedText={t('workspaceListRefreshFailed', { workspace: t('workspace') })}
  >
    {#if workspaces.length === 0}
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
              <th class="is-actions"><span class="visually-hidden">{t('workspaceActionsHeader')}</span></th>
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
                <td class="is-actions">
                  <!-- 終了した行は「再開する」、進行中の行は「終了する」。同じ要素のまま文字だけを替え、読み直しでフォーカスを失わない。
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
  </SectionBoundary>
  <!-- 開き直しを送っている間の読み上げ。領域は常に置き、中の文字だけを替える -->
  <span class="visually-hidden" role="status">{status}</span>
</Setting>

<WorkspaceCreateDialog bind:this={createDialog} {slug} {meId} {organizationVocabulary} />
<WorkspaceCloseDialog
  bind:this={closeDialog}
  {slug}
  onfinish={(outcome) => closeFinished(closing?.name ?? '', outcome)}
/>
