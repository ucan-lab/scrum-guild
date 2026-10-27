<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import { goto, invalidate } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import Icon from '../../../../lib/components/Icon.svelte';
  import LoadFailed from '../../../../lib/components/LoadFailed.svelte';
  import NotFoundPage from '../../../../lib/components/NotFoundPage.svelte';
  import TaskDrawer from '../../../../lib/components/TaskDrawer.svelte';
  import { focusPageHeading } from '../../../../lib/focus-heading.ts';
  import { formatLocalDate } from '../../../../lib/format.ts';
  import { setWorkspaceVocabulary, t } from '../../../../lib/vocabulary.svelte.ts';
  import type { LayoutData } from './$types';

  // ワークスペースの枠。workspace の操作の結果で、ワークスペースの中の言葉づかいを当てる（離れるときに戻す）。
  // 最初の描画から当たるよう、描く前に走る $effect.pre で入れる。
  // 左のメニューのワークスペースの節と、上の帯の「所属せず管理者として開いています」の印は、組織の枠が page.data から出す。
  // 存在しない ID と別の組織の ID（404）は、同じ「見つからない」。所属していない一般のユーザー（403）も、
  // 読み直しても直らないので「入れない」の案内にする（組織の枠の 403 とは違い、ここでは「もう一度試す」を出さない）。
  // ほかの失敗（通信、5xx）は読み込みの失敗。
  // 終了したワークスペースには、読み取り専用の帯を出す（部品は components.css の .callout）
  // タスクの詳細の引き出しは、URL の `?task=<ID>` が付いている間、ワークスペースのどの画面の上にも置く（タスクが替わったら、置き直す）。
  // 閉じるときは、開いている画面の URL から `task` だけを外し（履歴は積まない）、開いた行のリンクへフォーカスを戻す。行が無ければ（消えた、
  // 画面にまだ無い）画面の見出しへ移す。保存した欄は、木だけを読み直して行に反映する（`app:backlog-tree`）。引き出しが読み直すのは、
  // 木かこの枠（`app:workspace`）だけで、組織の枠は読み直さない（組織の枠の失敗で、引き出しと書きかけが消えないため）。
  // 終了したワークスペースでは、引き出しを読み取り専用で開く
  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  const workspace = $derived(data.workspace);
  const isAdmin = $derived(data.organization?.me.is_admin === true);
  const status = $derived(data.workspaceFailure?.status);
  const code = $derived(data.workspaceFailure?.code);
  const unavailable = $derived((status === 404 && code === 'not_found') || (status === 403 && code === 'forbidden'));
  const taskId = $derived(page.url.searchParams.get('task'));
  const canWrite = $derived(workspace !== null && workspace.closedAt === null);

  $effect.pre(() => {
    if (!workspace) return;
    setWorkspaceVocabulary(workspace.vocabulary);
    return () => setWorkspaceVocabulary(null);
  });

  // 今の URL から `task` だけを外した画面。開いた画面（バックログ、メンバーなど）のまま、ほかのクエリも残す
  const withoutTask = () => {
    const rest = new SvelteURLSearchParams(page.url.search);
    rest.delete('task');
    const query = rest.size > 0 ? `?${rest}` : '';
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- 今の画面の経路（page.url.pathname）に、残すクエリだけを足している
    return goto(page.url.pathname + query, {
      replace: true,
      reset: false,
    });
  };

  // 閉じたら、開いた行のリンクへフォーカスを戻す。行が無ければ（消えた、画面にまだ無い）画面の見出しへ移す。
  // 閉じるボタンと Esc だけでなく、戻る／進むで `?task=` が外れて閉じたときも同じ。タスクが消えて閉じたときは、
  // 木を読み直した後に見出しへ移す（removed）ので、ここでは移さない
  let shownTaskId: string | null = null;
  let focusAfterReload = false;
  $effect(() => {
    const previous = shownTaskId;
    shownTaskId = taskId;
    if (previous === null || taskId !== null) return;
    if (focusAfterReload) {
      focusAfterReload = false;
      return;
    }
    void tick().then(() => {
      const row = document.querySelector<HTMLElement>(`a[data-task-id="${CSS.escape(previous)}"]`);
      if (row) row.focus();
      else focusPageHeading();
    });
  });

  // タスクが消えた（削除した、見つからない）。閉じて、木を読み直し、フォーカスを見出しへ移す（戻る先の行が無いため）
  async function removed(): Promise<void> {
    focusAfterReload = true;
    await withoutTask();
    await invalidate('app:backlog-tree');
    await tick();
    focusPageHeading();
  }
</script>

{#if workspace}
  <!-- 終了していれば、ワークスペースの中のどの画面にも帯を出す。再開するボタンは置かず、管理者には組織の管理の画面へのリンクを添える -->
  {#if workspace.closedAt !== null}
    <div class="callout is-info">
      <Icon name="archive" />
      <span>
        {t('workspaceClosedBanner', { date: formatLocalDate(workspace.closedAt) })}
        {#if isAdmin}
          <a href={resolve('/[slug]/admin', { slug: data.slug })}
            >{t('workspaceClosedBannerLink', { page: t('pageOrgAdmin') })}</a
          >
        {/if}
      </span>
    </div>
  {/if}
  {@render children()}
  {#if taskId !== null}
    {#key taskId}
      <TaskDrawer
        slug={page.params.slug ?? ''}
        workspaceId={workspace.id}
        {taskId}
        {canWrite}
        definitionOfDone={workspace.definitionOfDone}
        onclose={() => void withoutTask()}
        onchanged={() => void invalidate('app:backlog-tree')}
        onstale={() => void invalidate('app:workspace')}
        onremoved={() => void removed()}
      />
    {/key}
  {/if}
{:else if unavailable}
  <NotFoundPage
    slug={page.params.slug ?? ''}
    title={t('workspaceNotFoundTitle', { workspace: t('workspace') })}
    text={t('workspaceNotFoundText', { workspace: t('workspace') })}
  />
{:else}
  <LoadFailed inShell />
{/if}
