import { createApp } from './app.ts';
import { runScheduled } from './scheduled/index.ts';

const app = createApp();

export default {
  fetch: app.fetch,
  // 定期処理の入口。cron の式から処理を引く（scheduled/index.ts）
  scheduled: (controller, env) => runScheduled(controller, env),
} satisfies ExportedHandler<Env>;
