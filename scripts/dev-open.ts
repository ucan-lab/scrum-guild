// pnpm dev:open [--preview] [who] [path]: seed のセッション（seed/sessions.ts）の Cookie を置いた、画面の見えるブラウザで手元の画面を開く。
// e2e の signIn（e2e/helpers.ts）と同じやり方を、人が見るためのコマンドにしたもの。引数と開く先の判定は dev-open-target.ts
import { chromium, type Browser } from '@playwright/test';
import { checkDevOpenSession } from './dev-open-session.ts';
import { resolveDevOpenTarget, type DevOpenTarget } from './dev-open-target.ts';

function stop(message: string): never {
  console.error(message);
  process.exit(1);
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

const session = await checkDevOpenSession(resolved, process.env);
if (!session.ok) stop(session.reason);

await open(resolved);
