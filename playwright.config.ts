// e2e（pnpm e2e）: pnpm preview と同じく build して wrangler dev を立て、本番と同じ配り方の画面と API を確かめる。
import { defineConfig, devices } from '@playwright/test';
import { devPorts } from './scripts/dev-ports.ts';
import { applyE2eServerVersion, E2E_SERVER_COMMAND, reuseExistingServer } from './scripts/e2e-server.ts';

const baseURL = `http://localhost:${devPorts(process.env).api}`;

// サーバーの build と、e2e/global-setup.ts と e2e/shell.test.ts が比べる版（scripts/e2e-server.ts）
applyE2eServerVersion(process.env, Date.now());

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  // サーバーの版の確かめと seed の入れ直し。webServer が立ってから動く
  globalSetup: './e2e/global-setup.ts',
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL,
    // 通ったテストの画面は e2e/fixtures.ts が通信とアニメーションの止まるのを待って evidence-<n>.png に撮る。
    // ここでは落ちたテストの画面だけを撮る。どちらも CI の成果物に上げる（docs/development.md の「CI」）
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // 描画を1本のスレッドで丸ごと行い、同じ画面なら撮り直しても同じ画像にする（CI の evidence がハッシュで比べるため）。
        // 無いと、影や罫線の数画素が色の値 1〜2 だけ揺れ、同じコミットの2回撮りで約 20 画面が違った（#337）
        launchOptions: { args: ['--disable-partial-raster', '--num-raster-threads=1', '--disable-gpu-rasterization'] },
      },
    },
  ],
  webServer: {
    // package.json の preview と同じ中身（scripts/e2e-server.test.ts が一致を確かめる）
    command: E2E_SERVER_COMMAND,
    url: `${baseURL}/api/health`,
    // 既定では、答えるサーバーが既にあれば止まる。使い回すのは E2E_REUSE_SERVER=1 のときだけ（CI では使い回さない）
    reuseExistingServer: reuseExistingServer(process.env),
    timeout: 180_000,
  },
});
