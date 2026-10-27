// 画面の hooks（SvelteKit のクライアントの hooks）。画面で起きた例外を POST /api/client-errors へ送る送り手を付ける（Issue #376）。
// init は最初の描画より前に動くので、最初の描画と最初の load の例外も拾う。SvelteKit が受けた例外（load と描画の失敗）は
// window の error に出ないことがあるので、handleError からも同じ送り手に渡す
import type { ClientInit, HandleClientError } from '@sveltejs/kit/hooks';
import { version } from '$app/env';
import { page } from '$app/state';
import { installClientErrorReporter, type InstalledClientErrorReporter } from './lib/client-error-report.ts';

let reporter: InstalledClientErrorReporter | undefined;

export const init: ClientInit = () => {
  // 経路は送るときに読む（slug、ID、クエリを送らず、route.id だけ）
  reporter = installClientErrorReporter(() => page.route.id, version);
};

// 送るのは、コードが投げた例外（unknown）だけ。error() で投げた例外（app）と、SvelteKit が作る失敗（framework。見つからない
// 経路の 404 など）は、画面の不具合ではないので送らない。経路は、失敗した移動の先の route.id（page はまだ移る前を指しうる）。
// 最初の描画の失敗では、SvelteKit が渡す event の経路が空のことがあるので、そのときは page の route.id を使う。
// この hook は投げてはいけないので、どこで失敗しても握りつぶす。
// handleError を定義すると SvelteKit の既定（console.error(error)）が動かないので、コードが投げた例外はコンソールにも残す
// （DevTools と pnpm dev で原因を追うため）。SvelteKit の 404 などは、既定と同じく出さない（e2e の watchViolations が数える）
export const handleError: HandleClientError = ({ error, kind, event }) => {
  if (kind !== 'unknown') return;
  console.error(error);
  try {
    reporter?.onCaughtError(error, event?.route?.id ?? page.route.id);
  } catch {
    // 送る処理の例外は握りつぶす
  }
};
