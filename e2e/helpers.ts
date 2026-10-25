import type { BrowserContext, Page } from '@playwright/test';
import { SEED_SESSIONS } from '../seed/sessions.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';

// CSP の違反は、ページのスクリプトより先に securitypolicyviolation を拾い、コンソールのエラーと合わせて集める
export async function watchViolations(page: Page): Promise<() => Promise<string[]>> {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await page.addInitScript(() => {
    const violations: string[] = [];
    (window as unknown as { __cspViolations: string[] }).__cspViolations = violations;
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return async () => {
    const violations = await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
    return [...violations, ...consoleErrors];
  };
}

// seed のセッション（seed/sessions.ts）の Cookie を置いて、ログインした状態にする。
// 名前は画面を開く URL で決まる（e2e は pnpm preview の http の localhost なので sg_session）
export async function signIn(
  context: BrowserContext,
  baseURL: string | undefined,
  who: keyof typeof SEED_SESSIONS,
): Promise<void> {
  if (baseURL === undefined) throw new Error('baseURL が無い');
  await context.addCookies([
    { name: sessionCookieName(baseURL), value: SEED_SESSIONS[who].token, url: baseURL, httpOnly: true },
  ]);
}
