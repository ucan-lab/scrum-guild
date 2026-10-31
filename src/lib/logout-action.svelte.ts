import { callOperation } from './api.ts';
import { loggedOutPath, logoutOutcome } from './logout.ts';
import { showToast } from './toast.svelte.ts';
import { t } from './vocabulary.svelte.ts';
import { logout } from '../shared/operations/session/index.ts';

// ログアウトの呼び出し。組織の中のメニューの項目（AccountMenu）と、組織の外の紙の下のボタン（LogoutButton）が共有する。
// busy の間は、どちらの入口も押せない（二重に送らない）。
export const logoutState = $state({ busy: false });

export async function performLogout(): Promise<void> {
  if (logoutState.busy) return;
  logoutState.busy = true;
  const result = await callOperation(logout, {});
  if (logoutOutcome(result) === 'leave') {
    // goto は使わない。組織のテーマ、読み込み済みのデータがメモリに残るので、ページごと読み直す。
    // assign ではなく replace: 履歴に残すと、「戻る」で前の人の組織の画面が戻る（共有の端末で見える）。
    // それでも bfcache から戻る場合は、root のレイアウトが pageshow で読み直す。
    // 移った先で busy は戻さない（読み直しで消える）。return_to は付けない（別の人が同じ端末で入り直すため）
    location.replace(loggedOutPath);
    return;
  }
  logoutState.busy = false;
  showToast(t('logoutFailed'), 'alert');
}
