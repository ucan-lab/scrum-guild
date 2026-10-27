import type { IconName } from './icons.ts';

// action を付けると、文の後ろに押せるボタン（.toast-action）を出す。押すと run を呼んで、そのトーストを消す
export type ToastAction = { label: string; run: () => void };

export type Toast = { id: number; message: string; icon?: IconName; action?: ToastAction };

// 数秒で消える短い知らせ。kit.js の toast と同じ 4 秒。操作を付けたものは、押す間があるよう 10 秒で、
// ポインターが乗っている間とフォーカスがある間は数えるのを止め、外れてから数え直す（pauseToast、resumeToast）。
// 操作は、同じことを画面のほかの場所でもできるものだけにする（消えても、できることを失わないため）
const toastLifetimeMs = 4000;
const actionToastLifetimeMs = 10000;
// 同時に出す数。あふれたら古いものから消す
const maxToasts = 3;

export const toasts: Toast[] = $state([]);

// モーダルのダイアログが開いている数。開いている間、外側は inert で読み上げも届かないので、
// トーストはダイアログの中の領域に出し、外側の領域は隠す（ToastRegion.svelte、Dialog.svelte）
export const modalState = $state({ openCount: 0 });

let nextId = 0;
// トーストごとの、消すまでのタイマー。描き直しには使わないので、リアクティブにしない
const timers: Record<number, ReturnType<typeof setTimeout>> = {};

function stopTimer(id: number): void {
  clearTimeout(timers[id]);
  delete timers[id];
}

export function dismissToast(id: number): void {
  stopTimer(id);
  const index = toasts.findIndex((toast) => toast.id === id);
  if (index !== -1) toasts.splice(index, 1);
}

function schedule(id: number, lifetime: number): void {
  stopTimer(id);
  timers[id] = setTimeout(() => dismissToast(id), lifetime);
}

// 操作の付いたトーストの、消すまでの時間を止める（ポインターが乗った、フォーカスが入った）
export function pauseToast(id: number): void {
  stopTimer(id);
}

// 止めていた時間を、初めから数え直す（ポインターとフォーカスが外れた）
export function resumeToast(id: number): void {
  if (toasts.some((toast) => toast.id === id)) schedule(id, actionToastLifetimeMs);
}

// message は文字列として出す（HTML として埋め込まない）。呼ぶ側は辞書を通した文言を渡す
export function showToast(message: string, icon?: IconName, action?: ToastAction): void {
  const id = nextId++;
  toasts.push({ id, message, icon, ...(action === undefined ? {} : { action }) });
  if (toasts.length > maxToasts) {
    for (const old of toasts.slice(0, toasts.length - maxToasts)) dismissToast(old.id);
  }
  schedule(id, action === undefined ? toastLifetimeMs : actionToastLifetimeMs);
}
