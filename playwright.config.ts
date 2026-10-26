// e2e（pnpm e2e）: pnpm preview と同じく build して wrangler dev を立て、本番と同じ配り方の画面と API を確かめる。
import { defineConfig, devices } from '@playwright/test';
import { devPorts } from './scripts/dev-ports.ts';
import { e2eServerVersion, reuseExistingServer } from './scripts/e2e-server.ts';

const baseURL = `http://localhost:${devPorts(process.env).api}`;

// サーバーの build と、e2e/global-setup.ts と e2e/shell.test.ts が比べる版。ワーカーは設定を読み直すが、
// この process.env を受け継ぐので、同じ実行の中では1つの値になる（scripts/e2e-server.ts）
process.env.APP_VERSION = e2eServerVersion(process.env, Date.now());

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  // サーバーの版の確かめと seed の入れ直し。webServer が立ってから動く
  globalSetup: './e2e/global-setup.ts',
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL,
    // CI の成果物に上げる（docs/development.md の「CI」）
    screenshot: 'on',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // pnpm preview と同じ中身。pnpm を通すと、pnpm がスクリプトを別のプロセスグループで動かし、
    // 終わりに Playwright がグループへ送る SIGKILL が wrangler と workerd に届かず、サーバーが残ることがある
    command: 'pnpm build && node scripts/dev.ts --preview',
    url: `${baseURL}/api/health`,
    // 既定では、答えるサーバーが既にあれば止まる。使い回すのは E2E_REUSE_SERVER=1 のときだけ（CI では使い回さない）
    reuseExistingServer: reuseExistingServer(process.env),
    timeout: 180_000,
  },
});
