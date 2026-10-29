<script lang="ts">
  import { tick } from 'svelte';
  import { goto, invalidate } from '$app/navigation';
  import { navigating, page } from '$app/state';
  import { resolve } from '$app/paths';
  import Avatar from '../../../../../../lib/components/Avatar.svelte';
  import DefinitionChip from '../../../../../../lib/components/DefinitionChip.svelte';
  import DueChip from '../../../../../../lib/components/DueChip.svelte';
  import Emblem from '../../../../../../lib/components/Emblem.svelte';
  import EmptyState from '../../../../../../lib/components/EmptyState.svelte';
  import EpicDialog from '../../../../../../lib/components/EpicDialog.svelte';
  import EpicPartyAssignDialog from '../../../../../../lib/components/EpicPartyAssignDialog.svelte';
  import EpicTier from '../../../../../../lib/components/EpicTier.svelte';
  import Icon from '../../../../../../lib/components/Icon.svelte';
  import LoadFailed from '../../../../../../lib/components/LoadFailed.svelte';
  import Markdown from '../../../../../../lib/components/Markdown.svelte';
  import PageHead from '../../../../../../lib/components/PageHead.svelte';
  import Progress from '../../../../../../lib/components/Progress.svelte';
  import Section from '../../../../../../lib/components/Section.svelte';
  import { callOperation } from '../../../../../../lib/api.ts';
  import { focusPageHeading } from '../../../../../../lib/focus-heading.ts';
  import { isUnauthenticated, loginUrl } from '../../../../../../lib/login-redirect.ts';
  import { showToast } from '../../../../../../lib/toast.svelte.ts';
  import { t } from '../../../../../../lib/vocabulary.svelte.ts';
  import { epicPartyJoin, epicPartyLeave } from '../../../../../../shared/operations/epic/index.ts';
  import type { PageProps } from './$types';

  // エピックの画面（epic.html）。木のエピックの題から開く。概要（本文、リンク）、依頼主、クリア報酬の段階と額、期日、区分、
  // 討伐隊の一覧（離脱済みの人も、名前に「（離脱済み）」を添えて出す。レベルは紋章だけで、経験値の数値は API も返さない）、
  // 配下のストーリー（削除していないもの、並びの順。完了の印と、完了 / 全体のポイント）を出す。
  // 討伐隊の面の下に、書き込めて終わっていないエピックで、討伐隊に入れる人（can_join）には「受注する」か「抜ける」を、
  // 依頼主とリーダー（can_manage）には「<討伐隊>に割り振る」（EpicPartyAssignDialog）を出す。どちらも済んだら画面の値を読み直す。
  // 報酬と依頼主の変更、クリア、中止、添付ファイルは、後の Issue で足す。
  // 見出しの横の「直す」は、エピックのダイアログ（EpicDialog）を開く。書き込めるときだけ出し、終了したワークスペースでは出さない
  // （ダイアログの欄は、この画面がすべて読み取りで出している）。直したら画面の値を読み直し、削除したか消えていたらバックログへ戻る。
  // 無いエピック（別の組織、別のワークスペース、削除済み）は「見つかりません」、読めなかったときは読み込みの失敗を出す。
  // 同じ画面の値を読み直している間は、本文の枠を aria-busy にする
  let { data }: PageProps = $props();

  const workspace = $derived(data.workspace);
  // 直した後の読み直しに失敗しても（data.detail が null）、同じエピックの前に読めた値を残して知らせだけを出す。
  // 別のエピックへ移ったときは持ち越さない
  let kept = $state<{ id: string; detail: NonNullable<typeof data.detail> } | null>(null);
  $effect.pre(() => {
    if (data.detail !== null) kept = { id: page.params.epicId ?? '', detail: data.detail };
  });
  const detail = $derived(data.detail ?? (kept?.id === (page.params.epicId ?? '') ? kept.detail : null));
  const stale = $derived(data.detail === null && detail !== null && !data.notFound);
  const slug = $derived(page.params.slug ?? '');
  const canWrite = $derived(workspace !== null && workspace.closedAt === null);
  // ダイアログで直した後に、この画面の値を読み直している間（invalidate は navigating を立てない）
  let refreshing = $state(false);
  const reloading = $derived(
    refreshing || (navigating.to !== null && navigating.to.url.pathname === page.url.pathname),
  );
  const backlogHref = $derived(resolve('/[slug]/w/[id]', { slug, id: page.params.id ?? '' }));
  const finished = $derived(detail !== null && (detail.epic.completed_at !== null || detail.epic.canceled_at !== null));

  const pointsDone = $derived(detail?.stories.reduce((sum, story) => sum + story.points_done, 0) ?? 0);
  const pointsAll = $derived(detail?.stories.reduce((sum, story) => sum + story.points_all, 0) ?? 0);
  const tallies = $derived(
    detail === null
      ? []
      : [
          {
            icon: 'check' as const,
            label: t('epicPageTallyDone', { done: t('done'), points: t('points') }),
            count: pointsDone,
          },
          { label: t('epicPageTallyRemaining', { points: t('points') }), count: pointsAll - pointsDone },
          { icon: 'users' as const, label: t('party'), count: detail.party.length },
        ],
  );

  let epicDialog = $state<ReturnType<typeof EpicDialog>>();
  let assignDialog = $state<ReturnType<typeof EpicPartyAssignDialog>>();
  // 受注か抜けるを送っている間。押しても無視する
  let partyBusy = $state(false);
  // 受注は討伐隊に入れる人（can_join）だけ。抜けるは、討伐隊にいれば（joined）入れる人でなくなっていても出す
  const showJoin = $derived(canWrite && !finished && detail !== null && (detail.joined || detail.can_join));
  const showAssign = $derived(canWrite && !finished && detail !== null && detail.can_manage);

  // ダイアログで直した。この画面の値だけを読み直す（枠は読み直さない）
  async function saved(): Promise<void> {
    refreshing = true;
    try {
      await invalidate('app:epic-detail');
    } finally {
      refreshing = false;
    }
  }

  // 受注する、抜ける。失敗はどれも、もう一度押しても直らないことが多いので、トーストで知らせて読み直す。
  // 何も書かなかった（changed が偽。別の画面で先に受注した、抜けた）ときは、済んだとは言わず、もう変わっていたことを知らせる。
  // 読み直した後は、同じボタン（文字が替わる）へ、無くなっていれば画面の見出しへフォーカスを移す
  async function toggleJoin(): Promise<void> {
    if (partyBusy || workspace === null || detail === null) return;
    const joining = !detail.joined;
    const input = { workspace_id: workspace.id, epic_id: detail.epic.id };
    partyBusy = true;
    try {
      const result = joining
        ? await callOperation(epicPartyJoin, input, { slug })
        : await callOperation(epicPartyLeave, input, { slug });
      if (!result.ok && isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url, result));
        return;
      }
      const words = { party: t('party'), epic: t('epic'), workspace: t('workspace') };
      if (result.ok && result.data.changed) showToast(t(joining ? 'epicPartyJoined' : 'epicPartyLeft', words), 'check');
      else if (result.ok) showToast(t('epicPartyAlreadyChanged', words), 'alert');
      else if (result.status === 403) {
        // 権限を失った（ワークスペースから外された）。もう一度押しても直らないので、枠も読み直す
        showToast(t('epicPartyForbidden', words), 'alert');
        await invalidate('app:workspace');
      } else if (result.error?.code === 'workspace_closed') {
        showToast(t('workspaceClosedReadOnly', words), 'alert');
        await invalidate('app:workspace');
      } else if (result.status === 409) showToast(t('epicPartyFinished', words), 'alert');
      else if (result.status === 404) showToast(t('epicPartyGone', words), 'alert');
      else showToast(t('epicPartyFailed', words), 'alert');
      await saved();
    } finally {
      partyBusy = false;
    }
    await tick();
    const button = document.querySelector<HTMLElement>('[data-party-join]');
    if (button) button.focus();
    else focusPageHeading();
  }

  // ダイアログで削除した、または直そうとしたら無かった。バックログへ戻り、見出しへフォーカスを移す
  async function gone(): Promise<void> {
    await goto(backlogHref, { refreshAll: true });
    await tick();
    focusPageHeading();
  }
</script>

<svelte:head>
  <!-- 読み込みに失敗した画面の題は LoadFailed が持つ -->
  {#if workspace && data.notFound}
    <title>{t('pageTitle', { page: t('epicPageNotFoundTitle', { epic: t('epic') }), app: t('appName') })}</title>
  {:else if workspace && detail !== null}
    <title>{t('pageTitle', { page: detail.epic.title, app: t('appName') })}</title>
  {/if}
</svelte:head>

{#snippet backLink()}
  <a class="btn is-sm is-quiet" href={backlogHref}>{t('epicPageBack', { backlog: t('backlog') })}</a>
{/snippet}

{#if workspace && data.notFound}
  <PageHead title={t('epicPageNotFoundTitle', { epic: t('epic') })} eyebrow={workspace.name} focusable />
  <EmptyState
    icon="search"
    title={t('epicPageNotFoundTitle', { epic: t('epic') })}
    text={t('epicPageNotFoundText', { workspace: t('workspace'), epic: t('epic') })}
  >
    {#snippet actions()}{@render backLink()}{/snippet}
  </EmptyState>
{:else if workspace && detail === null}
  <LoadFailed inShell />
{:else if workspace && detail !== null}
  {@const epic = detail.epic}
  {#snippet status()}
    {#if epic.completed_at !== null}
      <div><span class="chip is-done"><Icon name="check" />{t('epicCleared')}</span></div>
    {:else if epic.canceled_at !== null}
      <div><span class="chip">{t('epicCanceled')}</span></div>
    {/if}
  {/snippet}
  {#snippet actions()}
    {@render backLink()}
    {#if canWrite}
      <button class="btn" type="button" onclick={(event) => epicDialog?.show(event.currentTarget, epic.id)}>
        <Icon name="pen" />{t('epicPageEdit', { epic: t('epic') })}
      </button>
    {/if}
  {/snippet}
  <PageHead
    title={epic.title}
    eyebrow={epic.category === null ? t('epic') : `${t('epic')}・${epic.category.name}`}
    {tallies}
    {actions}
    meta={epic.completed_at !== null || epic.canceled_at !== null ? status : undefined}
    focusable
  />

  {#if stale}
    <div class="callout is-warn">
      <Icon name="alert" /><span role="alert">{t('epicPageStale')}</span>
    </div>
  {/if}

  <div class="layout-aside" aria-busy={reloading}>
    <div class="layout-main">
      {#if epic.body_md !== null || epic.link_url !== null}
        <!-- 見える見出しは無いので、本文の見出し（h3 から）の前に h2 を置いて段を飛ばさない -->
        <section class="section" aria-labelledby="epic-overview">
          <h2 class="visually-hidden" id="epic-overview">{t('epicPageOverview', { epic: t('epic') })}</h2>
          {#if epic.body_md !== null}<Markdown source={epic.body_md} headingStart={3} />{/if}
          {#if epic.link_url !== null}
            <!-- URL は折り返して全文を出し、外のサイトは新しいタブで開く「開く」を横に置く（引き出しのリンクと同じ組み方）。
                 読み上げにも、新しいタブで開くことを含める -->
            <div class="form-actions">
              <span class="source-key is-wrap"><Icon name="link" /> {epic.link_url}</span>
              <a
                class="btn is-sm"
                href={epic.link_url}
                target="_blank"
                rel="external noopener noreferrer"
                aria-label={t('epicLinkOpenLabel')}>{t('epicLinkOpen')}</a
              >
            </div>
          {/if}
        </section>
      {/if}

      <Section id="epic-stories" title={t('epicPageStories', { story: t('story') })} count={detail.stories.length}>
        {#if detail.stories.length === 0}
          <EmptyState icon="flag" title={t('epicNoStories', { story: t('story') })} />
        {:else}
          {#each detail.stories as story (story.id)}
            <div class="story-block">
              <div class="story-head">
                <span class="kind is-story"><Icon name="check" /></span>
                <h3 class="story-title">{story.title}</h3>
                {#if story.completed_at !== null}
                  <span class="chip is-done"><Icon name="check" />{t('done')}</span>
                {/if}
                <Progress done={story.points_done} all={story.points_all} />
              </div>
            </div>
          {/each}
        {/if}
      </Section>
    </div>

    <!-- 討伐隊は人数に上限が無いので、脇を貼り付けず本文と一緒にスクロールさせる（.layout-side.is-static） -->
    <aside class="layout-side is-static">
      <section class="panel" aria-labelledby="epic-request">
        <div class="panel-title"><h2 id="epic-request">{t('epicPageRequest')}</h2></div>
        <dl class="props">
          <div>
            <dt>{t('requester')}</dt>
            <dd>
              <Avatar
                userId={detail.requester.id}
                name={detail.requester.name}
                left={detail.requester.left}
                decorative
              />{detail.requester.name}{#if detail.requester.left}<span class="props-note">{t('leftMember')}</span>{/if}
              <!-- 朱の印は飾り。中世風のテーマだけに出る（components.css の .seal） -->
              <span class="seal" aria-hidden="true">印</span>
            </dd>
          </div>
          <div>
            <dt>{t('reward')}</dt>
            <dd><EpicTier tier={detail.reward_tier} xp={detail.reward_xp} /></dd>
          </div>
          <div>
            <dt>{t('due')}</dt>
            <dd>
              {#if epic.due_on !== null}
                <DueChip dueOn={epic.due_on} today={detail.today} weekStart={detail.week_start} done={finished} />
              {:else}
                <span class="props-note">—</span>
              {/if}
            </dd>
          </div>
          <div>
            <dt>{t('category')}</dt>
            <dd>
              {#if epic.category !== null}
                <DefinitionChip kind="category" name={epic.category.name} />
              {:else}
                <span class="props-note">{t('categoryNone', { category: t('category') })}</span>
              {/if}
            </dd>
          </div>
        </dl>
        <p class="panel-note">
          {t(
            epic.canceled_at !== null
              ? 'epicPageRewardNoteCanceled'
              : epic.completed_at !== null
                ? 'epicPageRewardNoteCleared'
                : 'epicPageRewardNote',
            { reward: t('reward'), party: t('party') },
          )}
        </p>
      </section>

      <section class="panel" aria-labelledby="epic-party">
        <div class="panel-title">
          <h2 id="epic-party">{t('party')}</h2>
          {t('epicPagePartyCount', { count: detail.party.length })}
        </div>
        {#if detail.party.length === 0}
          <p class="panel-note">{t('epicPagePartyEmpty')}</p>
        {:else}
          <ul class="party-list">
            {#each detail.party as member (member.id)}
              <li>
                <Avatar userId={member.id} name={member.name} left={member.left} decorative />
                <span class="party-list-text">
                  {member.name}{#if member.left}<span class="props-note">{t('leftMember')}</span>{/if}
                </span>
                {#if member.id === detail.requester.id}<span class="role">{t('requester')}</span>{/if}
                <Emblem level={member.level} small />
              </li>
            {/each}
          </ul>
        {/if}
        {#if showJoin || showAssign}
          <div class="actions-col">
            {#if showJoin}
              <button
                class="btn"
                class:is-primary={!detail.joined}
                type="button"
                data-party-join
                aria-disabled={partyBusy}
                onclick={() => void toggleJoin()}
              >
                <Icon name="users" />{detail.joined ? t('leave') : t('accept')}
              </button>
            {/if}
            {#if showAssign}
              <button class="btn" type="button" onclick={(event) => assignDialog?.show(event.currentTarget)}>
                {t('epicPageAssign', { party: t('party') })}
              </button>
            {/if}
          </div>
          <!-- 送っている間の読み上げ。常に置き、中の文字だけを替える -->
          <span class="visually-hidden" role="status"
            >{partyBusy ? t('epicPartyUpdating', { party: t('party') }) : ''}</span
          >
        {/if}
      </section>
    </aside>
  </div>

  <EpicDialog
    bind:this={epicDialog}
    {slug}
    workspaceId={workspace.id}
    {canWrite}
    categories={data.definitions?.categories ?? []}
    categoriesFailed={data.definitions === null}
    onsaved={() => void saved()}
    ongone={() => void gone()}
  />

  <EpicPartyAssignDialog
    bind:this={assignDialog}
    {slug}
    workspaceId={workspace.id}
    epicId={epic.id}
    partyIds={detail.party.map((member) => member.id)}
    onassigned={() => void saved()}
  />
{/if}
