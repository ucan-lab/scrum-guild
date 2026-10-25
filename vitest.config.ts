// API のテストを Workers の実行環境で動かす。scripts/ のテストは node --test で動かす（pnpm test）。
// テストの D1 には、test/apply-migrations.ts が全マイグレーションを当てる。読むのは Node の側でしかできないので、ここで読んで binding で渡す
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/apply-migrations.ts'],
    },
  };
});
