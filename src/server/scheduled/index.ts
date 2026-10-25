// 定期処理の表。wrangler.jsonc の triggers.crons の式から処理を引く。表に無い式で起きたら、設定の食い違いなので例外にする
import { cleanupExpired } from './cleanup-expired.ts';

type ScheduledJob = (env: Env, scheduledTime: Date) => Promise<void>;

const scheduledJobs: ReadonlyMap<string, ScheduledJob> = new Map<string, ScheduledJob>([
  // 毎分: 期限を過ぎた行を消す
  ['* * * * *', (env, scheduledTime) => cleanupExpired(env, scheduledTime)],
]);

export async function runScheduled(controller: ScheduledController, env: Env): Promise<void> {
  const job = scheduledJobs.get(controller.cron);
  if (job === undefined) throw new Error(`定期処理の表に無い cron の式: ${controller.cron}`);
  await job(env, new Date(controller.scheduledTime));
}
