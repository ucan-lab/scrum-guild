import type { IconName } from './icons.ts';

export type Toast = { id: number; message: string; icon?: IconName };

// 数秒で消える短い知らせ。kit.js の toast と同じ 4 秒
const toastLifetimeMs = 4000;

export const toasts: Toast[] = $state([]);

let nextId = 0;

// message は文字列として出す（HTML として埋め込まない）。呼ぶ側は辞書を通した文言を渡す
export function showToast(message: string, icon?: IconName): void {
  const id = nextId++;
  toasts.push({ id, message, icon });
  setTimeout(() => {
    const index = toasts.findIndex((toast) => toast.id === id);
    if (index !== -1) toasts.splice(index, 1);
  }, toastLifetimeMs);
}
