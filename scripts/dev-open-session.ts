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
  // 付けるのは環境変数で渡されたときだけ。.dev-port-offset とワークツリーの名前から決まった値は、立てる側でも同じに決まる
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
    // 運用者は OPERATOR_LOGIN_IDS で決まる。.dev.vars の置き方と直し先（本体へのリンク、リンクの無いワークツリー、独立したファイル）は docs にだけ書く
    const operatorHint =
      target.who === 'operator'
        ? `。または .dev.vars が無いか、その OPERATOR_LOGIN_IDS に seed の運用者の ${SEED_OPERATOR_LOGIN_ID} が無い（直し方は docs/development.md の「ワークツリーで作業する」。直したら立て直す）`
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
