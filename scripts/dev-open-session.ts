// pnpm dev:open が開く前に me を1回呼び、サーバーが立っていることと seed のセッションが生きていることを確かめる。
// fetch を差し替えられるようにして、分かれ方を node --test で確かめる（scripts/dev-open-session.test.ts）
import { SEED_OPERATOR_LOGIN_ID } from '../seed/sessions.ts';
import { operationPath } from '../src/shared/operations/define.ts';
import { me } from '../src/shared/operations/session/index.ts';
import type { DevOpenTarget } from './dev-open-target.ts';

export const REQUEST_TIMEOUT_MS = 10_000;

export type SessionCheck = { ok: true } | { ok: false; reason: string };

export async function checkDevOpenSession(
  target: DevOpenTarget,
  env: Record<string, string | undefined>,
  fetcher: typeof fetch = fetch,
): Promise<SessionCheck> {
  const serve = target.preview ? 'pnpm preview' : 'pnpm dev';
  const offset = env.DEV_PORT_OFFSET;
  const serveCommand = offset ? `DEV_PORT_OFFSET=${offset} ${serve}` : serve;

  let res: Response;
  try {
    res = await fetcher(`${target.origin}${operationPath(me)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: target.origin,
        Cookie: `${target.cookieName}=${target.token}`,
      },
      body: '{}',
      // トークンを付けた通信なので、別の先へは辿らない。3xx は下の !res.ok で止める（scripts/deploy.ts の煙のテストと同じ）
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return {
        ok: false,
        reason: `${target.origin} の me が ${REQUEST_TIMEOUT_MS / 1000} 秒で答えない。サーバーのログを見る`,
      };
    }
    return {
      ok: false,
      reason: `${target.origin} につながらない。別の端末で ${serveCommand} を立ててから、もう一度打つ`,
    };
  }
  // 見るのは状態コードだけ。本文を読まずに閉じ、接続を残さない
  await res.body?.cancel().catch(() => undefined);
  if (res.status === 401) {
    // 運用者は OPERATOR_LOGIN_IDS で決まる。ワークツリーの .dev.vars は、post-checkout が張る本体へのリンクのことも、リンクでない独立したファイルのこともある。
    // 本体に .dev.vars が無いうちに切ったワークツリーには、本体に後から作ってもリンクが無いまま残る
    const operatorHint =
      target.who === 'operator'
        ? `。または .dev.vars の OPERATOR_LOGIN_IDS に seed の運用者の ${SEED_OPERATOR_LOGIN_ID} が無い。ワークツリーに .dev.vars が無ければ、本体に用意したうえで、ワークツリーで ln -s <本体>/.dev.vars .dev.vars を人が打つ（先頭に ! を付ける）。リンクなら本体の .dev.vars に、リンクでない独立したファイルならそのファイルに、seed の運用者の ID を足す（自分の ID があればカンマで並べる。本体にも無ければ .dev.vars.example を写す）。直したら立て直す`
        : '';
    return {
      ok: false,
      reason: `${target.who} のセッションが無い（seed を流していない、30日で切れた、別のワークツリーの D1 を見ている）。pnpm db:seed を流してから、もう一度打つ${operatorHint}`,
    };
  }
  if (!res.ok) {
    // pnpm dev は vite が /api を wrangler dev へ転送するので、wrangler dev だけが落ちていると vite が 5xx を返す
    const proxyHint =
      !target.preview && res.status >= 500 ? `。wrangler dev が止まっていれば ${serveCommand} を立て直す` : '';
    return { ok: false, reason: `${target.origin} の me が ${res.status} を返した。サーバーのログを見る${proxyHint}` };
  }
  return { ok: true };
}
