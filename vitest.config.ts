// 2つのプロジェクトで動かす。scripts/ のテストは node --test で動かす（pnpm test）。
// - workers: API のテストを Workers の実行環境で動かす（test/）。テストの D1 には、test/apply-migrations.ts が全マイグレーションを当てる。読むのは Node の側でしかできないので、ここで読んで binding で渡す
// - web: 画面のコードのテストを node の環境で動かす（src/ の *.test.ts）。Workers の実行環境では .svelte を描けないため、svelte/server の render で HTML にして確かめる
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    test: {
      projects: [
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: './wrangler.jsonc' },
              miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
            }),
          ],
          test: {
            name: 'workers',
            include: ['test/**/*.test.ts'],
            setupFiles: ['./test/apply-migrations.ts'],
          },
        },
        {
          plugins: [svelte({ configFile: false, compilerOptions: { runes: true } })],
          test: {
            name: 'web',
            environment: 'node',
            include: ['src/**/*.test.ts'],
          },
        },
      ],
    },
  };
});
