<script lang="ts">
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import Icon from '../../lib/components/Icon.svelte';
  import LevelPanel from '../../lib/components/LevelPanel.svelte';
  import PageHead from '../../lib/components/PageHead.svelte';
  import Section from '../../lib/components/Section.svelte';
  import TaskEntry from '../../lib/components/TaskEntry.svelte';
  import WorkspaceCreateDialog from '../../lib/components/WorkspaceCreateDialog.svelte';
  import { t } from '../../lib/vocabulary.svelte.ts';
  import { dueStatus } from '../../shared/due.ts';
  import type { BacklogTask } from '../../shared/operations/task/backlog-tree.ts';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  let createDialog = $state<ReturnType<typeof WorkspaceCreateDialog>>();
  const emptyKind = $derived.by(() => {
    const view = data.organization;
    if (view === null || !view.me.is_admin) return 'default';
    if (!view.organization.has_workspaces) return 'firstWorkspace';
    return view.workspaces.length === 0 ? 'noMembership' : 'default';
  });
  const tasks = $derived(data.today?.tasks ?? []);
  const open = $derived(tasks.filter((task) => !task.is_today_completed));
  const todayTasks = $derived(
    open.filter((task) => task.today_on !== null).sort((a, b) => b.carry_days - a.carry_days || byDue(a, b)),
  );
  const overdueTasks = $derived(
    open
      .filter(
        (task) =>
          task.today_on === null &&
          task.due_on !== null &&
          dueStatus(task.due_on, task.today, task.week_start) === 'overdue',
      )
      .sort(byDue),
  );
  const weekTasks = $derived(
    open
      .filter(
        (task) =>
          task.today_on === null &&
          task.due_on !== null &&
          ['today', 'this_week'].includes(dueStatus(task.due_on, task.today, task.week_start)),
      )
      .sort(byDue),
  );
  const sprintTasks = $derived(
    open
      .filter(
        (task) =>
          task.today_on === null &&
          (task.due_on === null || dueStatus(task.due_on, task.today, task.week_start) === 'later') &&
          task.sprint_active,
      )
      .sort(byDue),
  );
  const doneTasks = $derived(tasks.filter((task) => task.is_today_completed).sort(byDue));
  function byDue(a: (typeof tasks)[number], b: (typeof tasks)[number]): number {
    return (
      (a.due_on ?? '9999').localeCompare(b.due_on ?? '9999') ||
      a.workspace_name.localeCompare(b.workspace_name) ||
      a.position.localeCompare(b.position)
    );
  }
  function taskOf(task: (typeof tasks)[number]): BacklogTask {
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

<svelte:head><title>{t('pageTitle', { page: t('pageToday'), app: t('appName') })}</title></svelte:head>
<PageHead title={t('pageToday')} />
<div class="layout-aside">
  <div class="layout-main">
    <Section id="s-today" title={t('sectionToday')} count={todayTasks.length} hint={t('sectionTodayHint')}>
      {#if todayTasks.length === 0}
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
        {:else}<EmptyState icon="sun" art="notice" title={t('todayEmptyTitle')} text={t('todayEmptyText')} />{/if}
      {:else}<div class="book">
          {#each todayTasks as task (task.id)}<TaskEntry
              task={taskOf(task)}
              clock={{ today: task.today, weekStart: task.week_start }}
              workspaceId={task.workspace_id}
              workspaceName={task.workspace_name}
              metaText={task.carry_days > 0 ? t('carryDays', { days: task.carry_days }) : undefined}
              onComplete={() => {}}
            />{/each}
        </div>{/if}
    </Section>
    {#if data.today?.sprint_goals.length}
      <Section id="s-goals" title={t('sprintGoal')}>
        <div class="notice-grid">
          {#each data.today.sprint_goals as sprint (sprint.workspace_id)}
            <div class="panel">
              <div class="panel-title"><b>{sprint.workspace_name}</b></div>
              <p class="panel-note wrap-anywhere">{sprint.goal}</p>
            </div>
          {/each}
        </div>
      </Section>
    {/if}
    {#if overdueTasks.length}<Section id="s-overdue" title={t('overdue')} count={overdueTasks.length}
        ><div class="book">
          {#each overdueTasks as task (task.id)}<TaskEntry
              task={taskOf(task)}
              clock={{ today: task.today, weekStart: task.week_start }}
              workspaceId={task.workspace_id}
              workspaceName={task.workspace_name}
              onComplete={() => {}}
            />{/each}
        </div></Section
      >{/if}
    {#if weekTasks.length}<Section id="s-week" title={t('weekDue')} count={weekTasks.length}
        ><div class="book">
          {#each weekTasks as task (task.id)}<TaskEntry
              task={taskOf(task)}
              clock={{ today: task.today, weekStart: task.week_start }}
              workspaceId={task.workspace_id}
              workspaceName={task.workspace_name}
              metaText={task.due_on === task.today ? t('dueToday') : undefined}
              onComplete={() => {}}
            />{/each}
        </div></Section
      >{/if}
    {#if sprintTasks.length}<Section
        id="s-sprint"
        title={t('sprintInProgress')}
        count={sprintTasks.length}
        folded
        foldedHint={t('sectionOpen')}
        ><div class="book">
          {#each sprintTasks as task (task.id)}<TaskEntry
              task={taskOf(task)}
              clock={{ today: task.today, weekStart: task.week_start }}
              workspaceId={task.workspace_id}
              workspaceName={task.workspace_name}
              onComplete={() => {}}
            />{/each}
        </div></Section
      >{/if}
    {#if doneTasks.length}<Section id="s-done" title={t('doneToday')} count={doneTasks.length}
        ><div class="book">
          {#each doneTasks as task (task.id)}<TaskEntry
              task={taskOf(task)}
              done
              clock={{ today: task.today, weekStart: task.week_start }}
              workspaceId={task.workspace_id}
              workspaceName={task.workspace_name}
              onComplete={() => {}}
            />{/each}
        </div></Section
      >{/if}
  </div>
  <aside class="layout-side" aria-label={t('pageMe')}>
    {#if data.experience}<LevelPanel
        total={data.experience.total}
        prospective={data.experience.prospective}
        thanksReceived={data.experience.thanks_received}
        workspaces={data.experience.workspaces}
      />{/if}
  </aside>
</div>
{#if data.organization?.me.is_admin}<WorkspaceCreateDialog
    bind:this={createDialog}
    slug={data.slug}
    meId={data.organization.me.id}
  />{/if}
