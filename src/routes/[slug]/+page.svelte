<script lang="ts">
  import { resolve } from '$app/paths';
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import FirstSteps from '../../lib/components/FirstSteps.svelte';
  import Icon from '../../lib/components/Icon.svelte';
  import LevelPanel from '../../lib/components/LevelPanel.svelte';
  import LoadFailed from '../../lib/components/LoadFailed.svelte';
  import PageHead, { type Tally } from '../../lib/components/PageHead.svelte';
  import Section from '../../lib/components/Section.svelte';
  import SprintGoalNotice from '../../lib/components/SprintGoalNotice.svelte';
  import TaskEntry from '../../lib/components/TaskEntry.svelte';
  import WorkspaceCreateDialog from '../../lib/components/WorkspaceCreateDialog.svelte';
  import { todaySections } from '../../lib/today-sections.ts';
  import { t } from '../../lib/vocabulary.svelte.ts';
  import type { TodayTask } from '../../shared/operations/organization/today.ts';
  import type { BacklogTask } from '../../shared/operations/task/backlog-tree.ts';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  let createDialog = $state<ReturnType<typeof WorkspaceCreateDialog>>();
  // 管理者でワークスペースが無い、または所属が無いときの案内。ほかは 'default'
  const emptyKind = $derived.by(() => {
    const view = data.organization;
    if (view === null || !view.me.is_admin) return 'default';
    if (!view.organization.has_workspaces) return 'firstWorkspace';
    return view.workspaces.length === 0 ? 'noMembership' : 'default';
  });
  // 次にやることのボタンの行き先（所属する最初のワークスペースのバックログ）
  const firstWorkspace = $derived(data.organization?.workspaces[0] ?? null);
  // today の読み込みの失敗（data.today が null）は、空の一覧と区別して失敗の画面を出す
  const sections = $derived(todaySections(data.today?.tasks ?? []));
  const tallies = $derived<Tally[]>([
    { icon: 'sun', label: t('sectionToday'), count: sections.today.length },
    { tone: 'danger', icon: 'alert', label: t('overdue'), count: sections.overdue.length },
    { tone: 'warn', icon: 'clock', label: t('weekDue'), count: sections.week.length },
    { icon: 'check', label: t('doneToday'), count: sections.done.length },
  ]);

  function taskOf(task: TodayTask): BacklogTask {
    return {
      id: task.id,
      title: task.title,
      points: task.points,
      due_on: task.due_on,
      assignee: task.assignee,
      category: null,
      repository: task.repository,
      sprint: task.sprint,
    };
  }
</script>

<!-- 完了の操作は、印と完了を足す Issue（3本目）まで出さない（canComplete を偽にする） -->
{#snippet rows(list: TodayTask[], options: { done?: boolean; markDueToday?: boolean } = {})}
  <div class="book">
    {#each list as task (task.id)}<TaskEntry
        task={taskOf(task)}
        done={options.done ?? false}
        canComplete={false}
        clock={{ today: task.today, weekStart: task.week_start }}
        workspaceId={task.workspace_id}
        workspaceName={task.workspace_name}
        metaChip={options.markDueToday && task.due_on === task.today ? t('dueIsToday') : undefined}
        metaText={task.carry_days > 0 ? t('carryDays', { days: task.carry_days }) : undefined}
      />{/each}
  </div>
{/snippet}

{#snippet todayEmpty()}
  {#if emptyKind === 'firstWorkspace'}
    <EmptyState
      icon="sun"
      art="map"
      title={t('firstWorkspaceTitle', { workspace: t('workspace') })}
      text={t('firstWorkspaceText', { workspace: t('workspace'), leader: t('leader') })}
    >
      {#snippet actions()}<button
          class="btn is-sm"
          type="button"
          onclick={(event) => createDialog?.show(event.currentTarget)}
          ><Icon name="plus" />{t('workspaceCreateAction', { workspace: t('workspace') })}</button
        >{/snippet}
    </EmptyState>
  {:else if emptyKind === 'noMembership'}
    <EmptyState
      icon="sun"
      art="notice"
      title={t('noMembershipTitle', { workspace: t('workspace') })}
      text={t('noMembershipText', { workspace: t('workspace') })}
    />
  {:else if firstWorkspace !== null}
    <EmptyState
      icon="sun"
      art="notice"
      title={t('todayEmptyTitle', { task: t('task') })}
      text={t('todayEmptyText', { assignee: t('assignee'), task: t('task'), backlog: t('backlog') })}
    >
      {#snippet actions()}<a
          class="btn is-sm"
          href={resolve('/[slug]/w/[id]', { slug: data.slug, id: firstWorkspace.id })}
          >{t('todayEmptyAction', { backlog: t('backlog') })}</a
        >{/snippet}
    </EmptyState>
  {:else}
    <EmptyState
      icon="sun"
      art="notice"
      title={t('todayEmptyTitle', { task: t('task') })}
      text={t('todayEmptyNoWorkspaceText', { workspace: t('workspace'), assignee: t('assignee'), task: t('task') })}
    />
  {/if}
{/snippet}

{#snippet main()}
  <!-- 最初にやること。手順が空（必須が済んだ、出す手順が無い）か読めなかったときは置かない -->
  {#if data.firstSteps !== null && data.firstSteps.role !== null && data.firstSteps.steps.length > 0 && (data.firstSteps.role !== 'admin' || data.organization?.me.is_admin)}
    <FirstSteps
      slug={data.slug}
      role={data.firstSteps.role}
      steps={data.firstSteps.steps}
      organizationName={data.organization?.organization.name ?? ''}
      onCreateWorkspace={data.organization?.me.is_admin ? (opener) => createDialog?.show(opener) : undefined}
    />
  {/if}
  {#if data.today !== null && data.today.sprint_goals.length > 0}
    <div class="notice-grid">
      {#each data.today.sprint_goals as sprint (sprint.workspace_id)}
        <SprintGoalNotice goal={sprint.goal} workspaceName={sprint.workspace_name} />
      {/each}
    </div>
  {/if}
  {#if sections.overdue.length > 0}
    <Section id="s-overdue" title={t('overdue')} count={sections.overdue.length}>
      {@render rows(sections.overdue)}
    </Section>
  {/if}
  <Section id="s-today" title={t('sectionToday')} count={sections.today.length} hint={t('sectionTodayHint')}>
    {#if sections.today.length === 0}
      {@render todayEmpty()}
    {:else}
      {@render rows(sections.today)}
    {/if}
  </Section>
  {#if sections.week.length > 0}
    <Section id="s-week" title={t('weekDue')} count={sections.week.length}>
      {@render rows(sections.week, { markDueToday: true })}
    </Section>
  {/if}
  {#if sections.sprint.length > 0}
    <Section id="s-sprint" title={t('sprintInProgress')} count={sections.sprint.length} folded>
      {@render rows(sections.sprint)}
    </Section>
  {/if}
  {#if sections.done.length > 0}
    <Section id="s-done" title={t('doneToday')} count={sections.done.length}>
      {@render rows(sections.done, { done: true })}
    </Section>
  {/if}
{/snippet}

<!-- 読み込みに失敗したときの題名は LoadFailed が持つ -->
<svelte:head>
  {#if data.today !== null}<title>{t('pageTitle', { page: t('pageToday'), app: t('appName') })}</title>{/if}
</svelte:head>
{#if data.today === null}
  <LoadFailed inShell />
{:else}
  <PageHead title={t('pageToday')} {tallies} />
  {#if data.experience}
    <div class="layout-aside">
      <div class="layout-main">{@render main()}</div>
      <aside class="layout-side" aria-label={t('myRecord')}>
        <LevelPanel
          total={data.experience.total}
          prospective={data.experience.prospective}
          thanksReceived={data.experience.thanks_received}
          workspaces={data.experience.workspaces}
        />
      </aside>
    </div>
  {:else}
    <!-- 経験値を読めなかったときは右の列ごと省く（列の幅だけ空けない） -->
    <div class="layout-main">{@render main()}</div>
  {/if}
  {#if data.organization?.me.is_admin}<WorkspaceCreateDialog
      bind:this={createDialog}
      slug={data.slug}
      meId={data.organization.me.id}
    />{/if}
{/if}
