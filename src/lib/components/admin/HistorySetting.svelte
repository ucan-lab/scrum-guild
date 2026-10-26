<script lang="ts">
  import { tick } from 'svelte';
  import { page } from '$app/state';
  import { organizationHistory } from '../../../shared/operations/organization/index.ts';
  import type { OutputOf } from '../../../shared/operations/define.ts';
  import { callOperation } from '../../api.ts';
  import { formatDateTime } from '../../format-datetime.ts';
  import { isUnauthenticated, loginUrl } from '../../login-redirect.ts';
  import { historyActorName, historyEventText, type HistoryEntry } from '../../organization-history.ts';
  import { t } from '../../vocabulary.svelte.ts';
  import Avatar from '../Avatar.svelte';
  import EmptyState from '../EmptyState.svelte';
  import Icon from '../Icon.svelte';
  import Setting from '../Setting.svelte';
  import SectionBoundary from './SectionBoundary.svelte';
  import { SectionLoad } from './section-load.svelte.ts';

  // 組織の管理の画面（admin.html）の変更の履歴の節。最初の50件の読み込みは SectionLoad、その表示は SectionBoundary に任せる。
  // 「さらに読む」は、前のページの最後の行のカーソルで次の50件を読み、今の一覧の後ろに足す。
  // 読んでいる間はボタンを aria-disabled と aria-busy にして押しても無視し、「読み込んでいます」を読み上げに伝える。
  // 続きの読み込みの失敗は、読めた行を残したまま、ボタンの下に理由を出す（もう一度押せば同じカーソルで読み直す）。
  // 最後まで読んでボタンが消えたら、代わりに出す「これより前の履歴はありません」へフォーカスを移す
  let { slug }: { slug: string } = $props();

  type Cursor = NonNullable<OutputOf<typeof organizationHistory>['next']>;

  const currentSlug = $derived(slug);

  let entries = $state<HistoryEntry[]>([]);
  let next = $state<Cursor | null>(null);
  let loadingMore = $state(false);
  let moreFailed = $state(false);
  // 「さらに読む」で最後まで読んだ。最初のページで終わったときは、終わりの文を出さない
  let reachedEnd = $state(false);
  let endNote = $state<HTMLElement>();

  const section = new SectionLoad(
    () => callOperation(organizationHistory, {}, { slug: currentSlug }),
    (data) => {
      entries = data.entries;
      next = data.next;
      reachedEnd = false;
      moreFailed = false;
    },
  );

  // slug が替わったら、前の組織の履歴を捨てて読み直す
  section.attach(
    () => currentSlug,
    () => {
      entries = [];
      next = null;
      loadingMore = false;
      moreFailed = false;
      reachedEnd = false;
    },
  );

  async function loadMore(): Promise<void> {
    if (loadingMore || next === null) return;
    const token = section.token();
    const before = next;
    loadingMore = true;
    moreFailed = false;
    try {
      const result = await callOperation(organizationHistory, { before }, { slug: currentSlug });
      if (!section.isCurrent(token)) return;
      if (isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url, result));
        return;
      }
      if (!result.ok) {
        moreFailed = true;
        return;
      }
      // カーソルより前の行だけが返るので重ならないが、同じ id の行を2度描かない（each の key が重なると描けない）
      const seen = new Set(entries.map((entry) => entry.id));
      entries = [...entries, ...result.data.entries.filter((entry) => !seen.has(entry.id))];
      next = result.data.next;
      if (next === null) {
        reachedEnd = true;
        // 押したボタンが消えるので、終わりの文へフォーカスを移す
        await tick();
        if (section.isCurrent(token)) endNote?.focus();
      }
    } finally {
      if (section.isCurrent(token)) loadingMore = false;
    }
  }
</script>

<Setting
  title={t('historyTitle')}
  description={t('historyDesc', {
    admin: t('admin'),
    workspace: t('workspace'),
    organization: t('organization'),
    member: t('member'),
  })}
>
  <SectionBoundary {section} failedTitle={t('historyLoadFailed')} refreshFailedText={t('historyRefreshFailed')}>
    {#if entries.length === 0}
      <EmptyState
        icon="clock"
        title={t('historyEmptyTitle')}
        text={t('historyEmptyText', { admin: t('admin'), workspace: t('workspace') })}
      />
    {:else}
      <div class="table-wrap">
        <table class="table is-stacked" aria-label={t('historyListLabel', { organization: t('organization') })}>
          <thead>
            <tr>
              <th>{t('historyColumnAt')}</th>
              <th>{t('historyColumnActor')}</th>
              <th>{t('historyColumnEvent')}</th>
            </tr>
          </thead>
          <tbody>
            {#each entries as entry (entry.id)}
              {@const actorName = historyActorName(entry.actor, t)}
              <tr>
                <td class="mono"><time datetime={entry.created_at}>{formatDateTime(entry.created_at)}</time></td>
                <td data-label={t('historyColumnActor')}>
                  {#if entry.actor.kind === 'user'}
                    <span class="person is-wrap"
                      ><Avatar userId={entry.actor.id} name={actorName} decorative />{actorName}</span
                    >
                  {:else}
                    <span class="props-note">{actorName}</span>
                  {/if}
                </td>
                <td data-label={t('historyColumnEvent')}>{historyEventText(entry.event, t)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if next !== null}
        <div class="form-actions">
          <button
            class="btn is-sm"
            type="button"
            aria-disabled={loadingMore}
            aria-busy={loadingMore}
            onclick={loadMore}
          >
            {t('historyMore')}
          </button>
          <span class="field-hint" role="status">{loadingMore ? t('loading') : ''}</span>
        </div>
      {:else if reachedEnd}
        <!-- tabindex="-1" は、最後まで読んで「さらに読む」が消えたときに、プログラムからフォーカスを置くため -->
        <p class="props-note" tabindex="-1" bind:this={endNote}>{t('historyEnd')}</p>
      {/if}
      <!-- 続きの読み込みの失敗。領域は常に置き、中身だけを替える -->
      <div role="alert">
        {#if moreFailed}<span class="field-error"><Icon name="alert" />{t('historyMoreFailed')}</span>{/if}
      </div>
    {/if}
  </SectionBoundary>
</Setting>
