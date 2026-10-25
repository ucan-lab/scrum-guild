import type { IconName } from './icons.ts';

export type Toast = { id: number; message: string; icon?: IconName };

// 数秒で消える短い知らせ。kit.js の toast と同じ 4 秒
const toastLifetimeMs = 4000;
// 同時に出す数。あふれたら古いものから消す
const maxToasts = 3;

export const toasts: Toast[] = $state([]);

// モーダルのダイアログが開いている数。開いている間、外側は inert で読み上げも届かないので、
// トーストはダイアログの中の領域に出し、外側の領域は隠す（ToastRegion.svelte、Dialog.svelte）
export const modalState = $state({ openCount: 0 });

let nextId = 0;

// message は文字列として出す（HTML として埋め込まない）。呼ぶ側は辞書を通した文言を渡す
export function showToast(message: string, icon?: IconName): void {
  const id = nextId++;
  toasts.push({ id, message, icon });
  if (toasts.length > maxToasts) toasts.splice(0, toasts.length - maxToasts);
  setTimeout(() => {
    const index = toasts.findIndex((toast) => toast.id === id);
    if (index !== -1) toasts.splice(index, 1);
  }, toastLifetimeMs);
}
