// scripts/e2e-shard-weights.json を作り直す道具: CI の e2e のログ（Playwright の list reporter の行）から、e2e のテストのファイルごとの
// 合計の秒を数え、重みの JSON と同じ形で標準出力に出す。使い方は docs/development.md の「e2e のシャードの割り方」。
//   node scripts/e2e-shard-weights.ts <ログのファイル…>   （ファイルを渡さないか - を渡すと標準入力を読む）
// 複数のログ（3 つのシャードなど）を渡せば合算する。ログはジョブの 1 つ分でもよく、ジョブ全体の生のログ（行頭に時刻が付く）でもよい。
// ワークフローは pnpm install の前でも動くように、node: の組み込みだけを import する
import { readFileSync } from 'node:fs';

// 例: "  ✓   12 [chromium] › e2e/task-drawer.test.ts:30:5 › 題 (1.2s)"、"(495ms)"、"(1.5m)"。落ちたテストの ✘ も時間を使うので数える。
// 題の中にも括弧が入りうるので、行末の括弧だけを秒数として読む
const LINE = /[✓✘]\s+\d+\s+\[[^\]]+\]\s+›\s+e2e\/([a-z0-9-]+\.test\.ts):\d+:\d+.*\((\d+(?:\.\d+)?)(ms|s|m)\)\s*$/;
// 飛ばしたテスト（"-  5 [chromium] › e2e/dev-warnings.test.ts:…"。本番の build の e2e での dev-warnings.test.ts など）は秒が無いが、
// ファイルは載せる（開発モードの build の e2e-dev では動くので、重みに載らないと中央値で割られる）
const SKIPPED_LINE = /(?:^|\s)-\s+\d+\s+\[[^\]]+\]\s+›\s+e2e\/([a-z0-9-]+\.test\.ts):\d+:\d+/;
// eslint-disable-next-line no-control-regex -- 色の制御文字を取り除く
const ANSI = /\x1b\[[0-9;]*m/g;
const UNIT_SECONDS = { ms: 0.001, s: 1, m: 60 } as const;

// ログの本文を足し合わせ、ファイル名（e2e/ を除く）ごとの秒（整数に丸め、1 未満は 1）を名前順に返す。テストが 1 行も無ければ空
export function sumDurations(logs: readonly string[]): Record<string, number> {
  const totals = new Map<string, number>();
  for (const log of logs) {
    for (const line of log.replace(ANSI, '').split('\n')) {
      const skipped = SKIPPED_LINE.exec(line);
      if (skipped) totals.set(skipped[1]!, totals.get(skipped[1]!) ?? 0);
      const match = LINE.exec(line);
      if (!match) continue;
      const [, file, amount, unit] = match as unknown as [string, string, string, keyof typeof UNIT_SECONDS];
      totals.set(file, (totals.get(file) ?? 0) + Number(amount) * UNIT_SECONDS[unit]);
    }
  }
  return Object.fromEntries(
    [...totals]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([file, seconds]) => [file, Math.max(1, Math.round(seconds))]),
  );
}

function main(paths: readonly string[]): void {
  const sources = paths.length === 0 ? ['-'] : paths;
  const logs = sources.map((path) => readFileSync(path === '-' ? 0 : path, 'utf8'));
  const weights = sumDurations(logs);
  if (Object.keys(weights).length === 0) {
    throw new Error('ログにテストの行（✓ n [chromium] › e2e/<名前>.test.ts:… (1.2s)）が 1 つも無い');
  }
  console.log(JSON.stringify(weights, null, 2));
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
