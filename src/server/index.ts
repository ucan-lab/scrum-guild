import { createApp } from './app.ts';

const app = createApp();

export default {
  fetch: app.fetch,
  // 定期処理の入口。中身は定期の作業を作る Issue で足す
  async scheduled() {},
} satisfies ExportedHandler<Env>;
