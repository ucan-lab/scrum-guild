// 定期処理の表。wrangler.jsonc の triggers.crons の式から処理を引く。表に無い式で起きたら、設定の食い違いなので例外にする
import { cleanupApiTokens } from './cleanup-api-tokens.ts';
import { cleanupExpired } from './cleanup-expired.ts';

type ScheduledJob = (env: Env, scheduledTime: Date) => Promise<void>;

// 片方が失敗しても、もう片方は消す。最初の失敗を、全部を終えてから投げる（cron の失敗として残る）
async function cleanupAll(env: Env, scheduledTime: Date): Promise<void> {
  const failures: unknown[] = [];
  for (const cleanup of [cleanupExpired, cleanupApiTokens]) {
    try {
      await cleanup(env, scheduledTime);
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 0) throw failures[0];
}

const scheduledJobs: ReadonlyMap<string, ScheduledJob> = new Map<string, ScheduledJob>([
  // 毎分: 期限を過ぎた行を消す（oauth_states、sessions、rate_limits と、api_tokens）
  ['* * * * *', cleanupAll],
]);

export async function runScheduled(controller: ScheduledController, env: Env): Promise<void> {
  const job = scheduledJobs.get(controller.cron);
  if (job === undefined) throw new Error(`定期処理の表に無い cron の式: ${controller.cron}`);
  await job(env, new Date(controller.scheduledTime));
}
