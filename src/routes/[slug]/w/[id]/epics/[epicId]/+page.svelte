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
  import EpicTier from '../../../../../../lib/components/EpicTier.svelte';
  import Icon from '../../../../../../lib/components/Icon.svelte';
  import LoadFailed from '../../../../../../lib/components/LoadFailed.svelte';
  import Markdown from '../../../../../../lib/components/Markdown.svelte';
  import PageHead from '../../../../../../lib/components/PageHead.svelte';
  import Progress from '../../../../../../lib/components/Progress.svelte';
  import Section from '../../../../../../lib/components/Section.svelte';
  import { focusPageHeading } from '../../../../../../lib/focus-heading.ts';
  import { t } from '../../../../../../lib/vocabulary.svelte.ts';
  import type { PageProps } from './$types';

  // エピックの画面（epic.html）。木のエピックの題から開く。この版は読むだけで、概要（本文、リンク）、依頼主、クリア報酬の段階と額、期日、区分、
  // 討伐隊の一覧（離脱済みの人も、名前に「（離脱済み）」を添えて出す。レベルは紋章だけで、経験値の数値は API も返さない）、
  // 配下のストーリー（削除していないもの、並びの順。完了の印と、完了 / 全体のポイント）を出す。
  // 受注、割り振り、報酬と依頼主の変更、クリア、中止、添付ファイルは、後の Issue で足す。
  // 見出しの横の「直す」は、エピックのダイアログ（EpicDialog）を開く。書き込めるときだけ出し、終了したワークスペースでは出さない
  // （ダイアログの欄は、この画面がすべて読み取りで出している）。直したら画面の値を読み直し、削除したか消えていたらバックログへ戻る。
  // 無いエピック（別の組織、別のワークスペース、削除済み）は「見つかりません」、読めなかったときは読み込みの失敗を出す。
  // 同じ画面の値を読み直している間は、本文の枠を aria-busy にする
  let { data }: PageProps = $props();

  const workspace = $derived(data.workspace);
  const detail = $derived(data.detail);
  const slug = $derived(page.params.slug ?? '');
  const canWrite = $derived(workspace !== null && workspace.closedAt === null);
  const reloading = $derived(navigating.to !== null && navigating.to.url.pathname === page.url.pathname);
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

  // ダイアログで直した。この画面の値だけを読み直す（枠は読み直さない）
  async function saved(): Promise<void> {
    await invalidate('app:epic-detail');
  }

  // ダイアログで削除した、または直そうとしたら無かった。バックログへ戻り、見出しへフォーカスを移す
  async function gone(): Promise<void> {
    await goto(backlogHref, { refreshAll: true });
    await tick();
    focusPageHeading();
  }
</script>

<svelte:head>
  {#if workspace}
    <title>
      {t('pageTitle', {
        page: detail !== null ? detail.epic.title : t('epicPageNotFoundTitle', { epic: t('epic') }),
        app: t('appName'),
      })}
    </title>
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

  <div class="layout-aside" aria-busy={reloading}>
    <div class="layout-main">
      {#if epic.body_md !== null || epic.link_url !== null}
        <section class="section">
          {#if epic.body_md !== null}<Markdown source={epic.body_md} headingStart={3} />{/if}
          {#if epic.link_url !== null}
            <div>
              <!-- 外のサイトは新しいタブで開く。読み上げにも、新しいタブで開くことを含める -->
              <a
                class="source-key"
                href={epic.link_url}
                target="_blank"
                rel="external noopener noreferrer"
                aria-label={t('epicLinkOpenLabel')}><Icon name="link" /> {epic.link_url}</a
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
            <section class="story-block" aria-labelledby="epic-story-{story.id}">
              <div class="story-head">
                <span class="kind is-story"><Icon name="check" /></span>
                <h3 class="story-title" id="epic-story-{story.id}">{story.title}</h3>
                {#if story.completed_at !== null}
                  <span class="chip is-done"><Icon name="check" />{t('done')}</span>
                {/if}
                <Progress done={story.points_done} all={story.points_all} />
              </div>
            </section>
          {/each}
        {/if}
      </Section>
    </div>

    <aside class="layout-side">
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
        <p class="panel-note">{t('epicPageRewardNote', { reward: t('reward'), party: t('party') })}</p>
      </section>

      <section class="panel" aria-labelledby="epic-party">
        <div class="panel-title">
          <h2 id="epic-party">{t('party')}</h2>
          {t('epicPagePartyCount', { count: detail.party.length })}
        </div>
        {#if detail.party.length === 0}
          <p class="panel-note">{t('epicPagePartyEmpty', { party: t('party') })}</p>
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
{/if}
