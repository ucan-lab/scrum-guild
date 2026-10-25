// テストの D1 に全マイグレーションを当てる（vitest.config.ts の setupFiles）。当て済みのものは飛ばす
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
