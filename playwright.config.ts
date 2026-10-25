// e2e（pnpm e2e）: pnpm preview で build して wrangler dev を立て、本番と同じ配り方の画面と API を確かめる。
import { defineConfig, devices } from '@playwright/test';
import { devPorts } from './scripts/dev-ports.ts';

const baseURL = `http://localhost:${devPorts(process.env).api}`;

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  // seed の入れ直し。webServer が立ってから動く
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
    command: 'pnpm preview',
    url: `${baseURL}/api/health`,
    // 手元では立てたままの preview を使えるが、CI では必ずこのコミットで build し直す
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
