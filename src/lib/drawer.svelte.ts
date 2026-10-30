import { SvelteURL } from 'svelte/reactivity';

export const TASK_OPEN_MODE_KEY = 'task-open-mode';
export const taskOpenModes = ['side', 'center', 'page', 'tab'] as const;
export type TaskOpenMode = (typeof taskOpenModes)[number];

export function readTaskOpenMode(): TaskOpenMode {
  try {
    const value = localStorage.getItem(TASK_OPEN_MODE_KEY);
    return taskOpenModes.includes(value as TaskOpenMode) ? (value as TaskOpenMode) : 'side';
  } catch {
    return 'side';
  }
}

export function effectiveTaskOpenMode(mode: TaskOpenMode, narrow: boolean): TaskOpenMode {
  return mode === 'center' && narrow ? 'side' : mode;
}

export const drawerState = $state<{ mode: TaskOpenMode }>({ mode: readTaskOpenMode() });

export function setTaskOpenMode(mode: TaskOpenMode): void {
  try {
    localStorage.setItem(TASK_OPEN_MODE_KEY, mode);
    drawerState.mode = mode;
  } catch {
    drawerState.mode = 'side';
  }
}

// リンクの通常操作も、修飾キーで別タブに開く操作も、同じ実在する URL を使う。
export function taskDetailHref(href: string): string {
  if (drawerState.mode !== 'page' && drawerState.mode !== 'tab') return href;
  const url = new SvelteURL(href, location.href);
  const id = url.searchParams.get('task');
  const base = url.pathname.match(/^(.*\/w\/[^/]+)/)?.[1];
  return id && base ? `${base}/tasks/${encodeURIComponent(id)}` : href;
}

export function taskPageHref(slug: string, workspaceId: string, taskId: string): string {
  return `/${encodeURIComponent(slug)}/w/${encodeURIComponent(workspaceId)}/tasks/${encodeURIComponent(taskId)}`;
}
