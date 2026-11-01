<script lang="ts">
  import { resolve } from '$app/paths';
  import type { FirstStep, FirstStepKey, FirstStepRole } from '../../shared/operations/organization/first-steps.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Art from './Art.svelte';
  import Icon from './Icon.svelte';

  // kit.js の firstSteps。初めて使う人の今日やることの先頭に、ロールごとの手順を出す。
  // 手順と済みはサーバー（first-steps）が今のデータから決めて返すので、閉じた印は持たない。必須が済むとサーバーが空を返し、この面は置かれない。
  // 主ボタンは、まだ済んでいない最初の手順にだけ付ける。ワークスペースを作る手順は、押すと onCreateWorkspace を呼ぶ（ダイアログは画面が持つ）
  let {
    slug,
    role,
    steps,
    organizationName = '',
    onCreateWorkspace,
  }: {
    slug: string;
    role: FirstStepRole;
    steps: FirstStep[];
    organizationName?: string;
    onCreateWorkspace?: (opener: HTMLElement) => void;
  } = $props();

  // 今日やるの印を付ける口は、印と完了を足す Issue（今日やることの3本目）まで画面に無い。押せない手順を案内しないよう、それまで出さない
  const NOT_YET: readonly FirstStepKey[] = ['mark_today'];

  const titleId = $props.id();
  const shown = $derived(steps.filter((step) => !NOT_YET.includes(step.key)));
  const doneCount = $derived(shown.filter((step) => step.done).length);

  type Action = { label: string; href?: string; click?: (opener: HTMLElement) => void; plus?: boolean };
  type Row = FirstStep & { title: string; note: string; action: Action | null };

  function backlogHref(step: FirstStep): string | null {
    return step.workspace === null ? null : resolve('/[slug]/w/[id]', { slug, id: step.workspace.id });
  }

  function rowOf(step: FirstStep): Row {
    const name = step.workspace?.name ?? '';
    const base = { ...step, action: null };
    switch (step.key) {
      case 'joined_workspace':
        return {
          ...base,
          title: t('firstStepJoinedTitle', { workspace: t('workspace'), name }),
          note: t('firstStepJoinedNote'),
        };
      case 'prepare_task': {
        const href = backlogHref(step);
        return {
          ...base,
          title: t('firstStepPrepareTaskTitle', { task: t('task') }),
          note: t('firstStepPrepareTaskNote', { backlog: t('backlog'), create: t('create'), points: t('points') }),
          action: href === null ? null : { label: t('todayEmptyAction', { backlog: t('backlog') }), href },
        };
      }
      case 'mark_today':
        // NOT_YET で出さない。型の網羅のために置く
        return { ...base, title: '', note: '' };
      case 'became_leader':
        return {
          ...base,
          title: t('firstStepBecameLeaderTitle', { workspace: t('workspace'), name, leader: t('leader') }),
          note: t('firstStepBecameLeaderNote', { admin: t('admin'), workspace: t('workspace') }),
        };
      case 'invite_members':
        return {
          ...base,
          title: t('firstStepInviteTitle', { member: t('member') }),
          note: t('firstStepInviteNote', { organization: t('organization') }),
          action:
            step.workspace === null
              ? null
              : {
                  label: t('firstStepInviteTitle', { member: t('member') }),
                  href: resolve('/[slug]/w/[id]/members', { slug, id: step.workspace.id }),
                },
        };
      case 'first_backlog_task': {
        const href = backlogHref(step);
        return {
          ...base,
          title: t('firstStepFirstTaskTitle', { backlog: t('backlog'), task: t('task') }),
          note: t('firstStepFirstTaskNote', { create: t('create'), member: t('member') }),
          action: href === null ? null : { label: t('todayEmptyAction', { backlog: t('backlog') }), href },
        };
      }
      case 'start_sprint':
        return {
          ...base,
          title: t('firstStepSprintTitle', { sprint: t('sprint') }),
          note: t('firstStepSprintNote', {
            plan: t('plan'),
            backlog: t('backlog'),
            task: t('task'),
            sprint: t('sprint'),
          }),
          action:
            step.workspace === null
              ? null
              : {
                  label: t('firstStepSprintAction', { plan: t('plan') }),
                  href: resolve('/[slug]/w/[id]/plan', { slug, id: step.workspace.id }),
                },
        };
      case 'became_admin':
        return {
          ...base,
          title: t('firstStepBecameAdminTitle', {
            organization: t('organization'),
            name: organizationName,
            admin: t('admin'),
          }),
          note: t('firstStepBecameAdminNote', { organization: t('organization') }),
        };
      case 'create_workspace':
        return {
          ...base,
          title: t('firstStepCreateWorkspaceTitle', { workspace: t('workspace') }),
          note: t('firstStepCreateWorkspaceNote', { leader: t('leader') }),
          action:
            onCreateWorkspace === undefined
              ? null
              : {
                  label: t('workspaceCreateAction', { workspace: t('workspace') }),
                  click: onCreateWorkspace,
                  plus: true,
                },
        };
      case 'invite_by_admin':
        return {
          ...base,
          title: t('firstStepInviteTitle', { member: t('member') }),
          note: t('firstStepAdminInviteNote', { workspace: t('workspace'), leader: t('leader'), member: t('member') }),
        };
      case 'register_holiday':
        return {
          ...base,
          title: t('firstStepHolidayTitle', { organization: t('organization') }),
          note: t('firstStepHolidayNote', { capacity: t('capacity') }),
          action: {
            label: t('firstStepHolidayAction', { page: t('pageOrgAdmin') }),
            href: resolve('/[slug]/admin', { slug }),
          },
        };
    }
  }

  const rows = $derived(shown.map(rowOf));
  // 主ボタンは、まだ済んでいない最初の手順（押せる操作を持つもの）にだけ付ける
  const nextIndex = $derived(rows.findIndex((row) => !row.done && row.action !== null));

  // 末尾の一言。自分の設定、またはワークスペースの設定へ案内するリンクを文の中に置く
  const hint = $derived.by(() => {
    if (role === 'member') {
      const label = t('pageMe');
      return {
        text: t('firstHintMember', { capacity: t('capacity'), setting: label }),
        label,
        href: resolve('/[slug]/me', { slug }),
      };
    }
    if (role === 'leader') {
      const workspace = steps.find((step) => step.workspace !== null)?.workspace;
      if (workspace === null || workspace === undefined) return null;
      const label = t('pageSettings');
      return {
        text: t('firstHintLeader', { column: t('column'), detail: t('detail'), setting: label }),
        label,
        href: resolve('/[slug]/w/[id]/settings', { slug, id: workspace.id }),
      };
    }
    return null;
  });
  const hintParts = $derived.by(() => {
    if (hint === null) return null;
    const at = hint.text.lastIndexOf(hint.label);
    return at < 0 ? null : { before: hint.text.slice(0, at), after: hint.text.slice(at + hint.label.length) };
  });
</script>

<section class="panel" aria-labelledby={titleId}>
  <div class="panel-title">
    <Art name="map" lead /><b id={titleId}>{t('firstStepsTitle')}</b>{t('firstStepsProgress', {
      done: doneCount,
      total: shown.length,
    })}
  </div>
  <ol class="steps">
    {#each rows as row, index (row.key)}
      <li class="step" class:is-done={row.done}>
        <div class="step-body">
          <span class="step-title"
            >{#if row.done}<span class="visually-hidden">{t('firstStepDone')}: </span>{/if}{row.title}{#if row.optional}
              <span class="chip">{t('firstStepOptional')}</span>{/if}</span
          >
          <span class="action-note">{row.note}</span>
          {#if !row.done && row.action !== null}
            <div class="form-actions">
              {#if row.action.href !== undefined}
                <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- href は rowOf が resolve した経路 -->
                <a class="btn is-sm" class:is-primary={index === nextIndex} href={row.action.href}>{row.action.label}</a
                >
              {:else}
                <button
                  class="btn is-sm"
                  class:is-primary={index === nextIndex}
                  type="button"
                  onclick={(event) => row.action?.click?.(event.currentTarget)}
                  >{#if row.action.plus}<Icon name="plus" />{/if}{row.action.label}</button
                >
              {/if}
            </div>
          {/if}
        </div>
      </li>
    {/each}
  </ol>
  {#if hint !== null && hintParts !== null}
    <p class="panel-note">{hintParts.before}<a href={hint.href}>{hint.label}</a>{hintParts.after}</p>
  {/if}
</section>
