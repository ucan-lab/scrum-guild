// pnpm dev:open [--preview] [who] [path]: seed のセッション（seed/sessions.ts）の Cookie を置いた、画面の見えるブラウザで手元の画面を開く。
// e2e の signIn（e2e/helpers.ts）と同じやり方を、人が見るためのコマンドにしたもの。引数と開く先の判定は dev-open-target.ts
import { chromium, type Browser } from '@playwright/test';
import { operationPath } from '../src/shared/operations/define.ts';
import { me } from '../src/shared/operations/session/index.ts';
import { resolveDevOpenTarget, type DevOpenTarget } from './dev-open-target.ts';

const REQUEST_TIMEOUT_MS = 10_000;

function stop(message: string): never {
  console.error(message);
  process.exit(1);
}

// 開く前に me を1回呼び、サーバーが立っていることと seed のセッションが生きていることを確かめる
async function checkSession(target: DevOpenTarget): Promise<void> {
  const serve = target.preview ? 'pnpm preview' : 'pnpm dev';
  const offset = process.env.DEV_PORT_OFFSET;
  const serveCommand = offset ? `DEV_PORT_OFFSET=${offset} ${serve}` : serve;

  let res: Response;
  try {
    res = await fetch(`${target.origin}${operationPath(me)}`, {
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
      stop(`${target.origin} の me が ${REQUEST_TIMEOUT_MS / 1000} 秒で答えない。サーバーのログを見る`);
    }
    stop(`${target.origin} につながらない。別の端末で ${serveCommand} を立ててから、もう一度打つ`);
  }
  if (res.status === 401) {
    // 運用者は OPERATOR_LOGIN_IDS で決まる。.dev.vars は git の外なので、新しいワークツリーには無い
    const operatorHint =
      target.who === 'operator'
        ? '。または .dev.vars が無い（.dev.vars.example を写す。ワークツリーには写されない）'
        : '';
    stop(
      `${target.who} のセッションが無い（seed を流していない、30日で切れた、別のワークツリーの D1 を見ている）。pnpm db:seed を流してから、もう一度打つ${operatorHint}`,
    );
  }
  if (!res.ok) stop(`${target.origin} の me が ${res.status} を返した。サーバーのログを見る`);
}

async function open(target: DevOpenTarget): Promise<void> {
  let browser: Browser;
  try {
    // Ctrl+C は下の SIGINT で受ける。Playwright に任せると、終了コードを選べない
    browser = await chromium.launch({ headless: false, handleSIGINT: false });
  } catch (err) {
    const detail = err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err);
    stop(`Chromium を起動できない（${detail}）。pnpm exec playwright install chromium を流してから、もう一度打つ`);
  }

  let disconnected = false;
  const closed = new Promise<void>((resolve) => {
    browser.on('disconnected', () => {
      disconnected = true;
      resolve();
    });
  });
  process.on('SIGINT', () => {
    browser
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });

  const context = await browser.newContext();
  await context.addCookies([{ name: target.cookieName, value: target.token, url: target.origin, httpOnly: true }]);
  // 開いたページがすべて閉じたら終える（macOS では最後のウィンドウを閉じてもブラウザのプロセスが残ることがある）
  context.on('page', (page) => {
    page.on('close', () => {
      if (context.pages().length === 0) void browser.close().catch(() => undefined);
    });
  });
  const page = await context.newPage();
  try {
    await page.goto(target.url);
  } catch (err) {
    // 読み込みの途中で人がウィンドウを閉じたときは、開けなかったのではなく、終えただけ
    if (disconnected || page.isClosed()) {
      await closed;
      return;
    }
    await browser.close().catch(() => undefined);
    stop(`${target.url} を開けない（${err instanceof Error ? err.message : String(err)}）`);
  }
  console.log(`${target.who} として ${target.url} を開いた。ブラウザを閉じると終わる`);
  await closed;
}

const resolved = resolveDevOpenTarget(process.argv.slice(2), process.env);
if (!resolved.ok) stop(resolved.reason);

await checkSession(resolved);
await open(resolved);
