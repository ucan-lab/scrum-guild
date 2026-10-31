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
  import {
    adjacentTaskIds,
    drawerState,
    taskOrder,
    clearOverlayHandoff,
    markOverlayHandoff,
    openTaskTab,
    setTaskOpenMode,
    taskPageHref,
    type TaskOpenMode,
  } from '../../../../lib/drawer.svelte.ts';
  import { focusPageHeading } from '../../../../lib/focus-heading.ts';
  import { formatLocalDate } from '../../../../lib/format.ts';
  import { t } from '../../../../lib/vocabulary.svelte.ts';
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
  // ページ全体（tasks/[taskId]）は、ルートが TaskDrawer を置くので、ここでは引き出しを重ねない
  // 引き出しの帯に、前後のタスクへ移るボタンを出す。順は開いた画面が置く（バックログ、計画、スプリント。画面の見えている行の順で、端で止まる）。
  // 移るときは `?task=` を置き換え（履歴は積まない）、引き出しは置き直される。閉じたときのフォーカスは、最後に表示したタスクの行へ戻る（下の shownTaskId）
  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  const workspace = $derived(data.workspace);
  const isAdmin = $derived(data.organization?.me.is_admin === true);
  const status = $derived(data.workspaceFailure?.status);
  const code = $derived(data.workspaceFailure?.code);
  const unavailable = $derived((status === 404 && code === 'not_found') || (status === 403 && code === 'forbidden'));
  const taskId = $derived(page.params.taskId ? null : page.url.searchParams.get('task'));
  let modeRevision = $state(0);
  const overlayMode = $derived(drawerState.mode === 'center' ? 'center' : 'side');

  // 帯で形を替える（書きかけの確認は TaskDrawer が済ませている）。移れなかったとき（新しいタブを開けなかった）は false を返し、
  // 引き出しも既定もそのままにする
  function changeMode(mode: TaskOpenMode): boolean {
    if (!taskId) return true;
    if (mode === 'tab') {
      if (!openTaskTab(taskPageHref(data.slug, workspace!.id, taskId))) return false;
      setTaskOpenMode(mode);
      void withoutTask();
      return true;
    }
    setTaskOpenMode(mode);
    if (mode === 'page') {
      // 一覧の上の引き出しからページ全体へ移っても履歴は足さない。足すと、ページ全体を閉じたとき引き出しが開いた状態の一覧に戻る
      markOverlayHandoff();
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- 同じワークスペース内の詳細の URL
      void goto(taskPageHref(data.slug, workspace!.id, taskId), { replace: true }).finally(() => {
        // 移れていれば（URL がページ全体）、ページ側の afterNavigate が印を読む。移れなかったときだけ外す
        if (!location.pathname.includes('/tasks/')) clearOverlayHandoff();
      });
    } else modeRevision += 1;
    return true;
  }
  const canWrite = $derived(workspace !== null && workspace.closedAt === null);
  // 前後のタスク。開いた画面が置いた、今見えている行の順（task-order.ts）の中の隣。順に無い（画面が順を置かない、完了して外れた）ときは渡さない
  const adjacent = $derived(taskId === null ? null : adjacentTaskIds(taskOrder.ids, taskId));

  // 前後のタスクへ移る（書きかけの確認は TaskDrawer が済ませている）。`?task=` だけを置き換え、ほかのクエリは残す。履歴は積まない
  function stepTo(id: string): Promise<void> {
    const query = new SvelteURLSearchParams(page.url.search);
    query.set('task', id);
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- 今の画面の経路（page.url.pathname）に、残すクエリと task だけを足している
    return goto(`${page.url.pathname}?${query}`, { replace: true, reset: false });
  }

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

  // 閉じたら、開いた行の題（data-task-id を持つリンクか、バックログの完了した行の題のボタン）へフォーカスを戻す。
  // 行が無ければ（消えた、画面にまだ無い）画面の見出しへ移す。
  // 閉じるボタンと Esc だけでなく、戻る／進むで `?task=` が外れて閉じたときも同じ。タスクが消えて閉じたときは、
  // 木を読み直した後に見出しへ移す（removed）ので、ここでは移さない
  let shownTaskId: string | null = null;
  let focusAfterReload = false;
  $effect(() => {
    const previous = shownTaskId;
    shownTaskId = taskId;
    if (previous === null || taskId !== null) return;
    // 引き出しからページ全体へ移ったときも taskId は null になる。ページ全体の TaskDrawer が置いたフォーカスを奪わない
    if (page.params.taskId) return;
    if (focusAfterReload) {
      focusAfterReload = false;
      return;
    }
    void tick().then(() => {
      const row = document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(previous)}"]`);
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
    {#key `${taskId}:${modeRevision}`}
      <TaskDrawer
        mode={overlayMode}
        onmode={changeMode}
        adjacent={adjacent ?? undefined}
        onstep={stepTo}
        slug={page.params.slug ?? ''}
        workspaceId={workspace.id}
        {taskId}
        currentUserId={data.organization?.me.id ?? null}
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
