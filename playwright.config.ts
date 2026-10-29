// e2e（pnpm e2e）: pnpm preview と同じく build して wrangler dev を立て、本番と同じ配り方の画面と API を確かめる。
import { defineConfig, devices } from '@playwright/test';
import { EVIDENCE } from './e2e/evidence-mode.ts';
import { devPorts } from './scripts/dev-ports.ts';
import { applyE2eServerVersion, e2eServerCommand, reuseExistingServer } from './scripts/e2e-server.ts';

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
  // 手元はワークツリーを並べて走らせることがあり、混んだマシンでは既定の5秒が切れて、自分の変更で落ちたのかを見分けにくくなる（#364）。
  // CI は既定の5秒のままにし、遅くなった待ちは CI で落とす（docs/development.md の「e2e の書き方」）
  expect: { timeout: process.env.CI ? 5_000 : 15_000 },
  use: {
    baseURL,
    // E2E_EVIDENCE=1（CI）では、通ったテストの画面は e2e/fixtures.ts が通信とアニメーションの止まるのを待って evidence-<n>.png に撮り、
    // ここでは落ちたテストの画面だけを撮る。どちらも CI の成果物に上げる（docs/development.md の「CI」）。
    // 手元では待たずに、テストの終わりの画面を Playwright が撮る
    screenshot: EVIDENCE ? 'only-on-failure' : 'on',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // 描画を1本のスレッドで丸ごと行い、同じ画面なら撮り直しても同じ画像にする（CI の evidence がハッシュで比べるため）。
        // 無いと、影や罫線の数画素が色の値 1〜2 だけ揺れ、同じコミットの2回撮りで約 20 画面が違った（#337）。
        // 描画が遅くなるので、撮る E2E_EVIDENCE=1 のときだけ付ける
        ...(EVIDENCE && {
          launchOptions: {
            args: ['--disable-partial-raster', '--num-raster-threads=1', '--disable-gpu-rasterization'],
          },
        }),
      },
    },
  ],
  webServer: {
    // package.json の preview と同じ中身（scripts/e2e-server.test.ts が一致を確かめる）。E2E_DEV_BUILD=1 では開発モードの build にする
    command: e2eServerCommand(process.env),
    url: `${baseURL}/api/health`,
    // 既定では、答えるサーバーが既にあれば止まる。使い回すのは E2E_REUSE_SERVER=1 のときだけ（CI では使い回さない）
    reuseExistingServer: reuseExistingServer(process.env),
    timeout: 180_000,
  },
});
