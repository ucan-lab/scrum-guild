// CI の e2e と e2e-dev のシャードの割り方: node scripts/e2e-shard.ts <i> <n> が、i 番目のシャードが走らせる e2e のテストのファイルを
// 空白区切りの 1 行で標準出力に出す（ci.yml が pnpm e2e に渡す。docs/development.md の「CI」）。
// Playwright の --shard はテストの件数で割り、所要時間を見ないので、ファイルごとの重み（秒。scripts/e2e-shard-weights.json）で割る。
// ワークフローは pnpm install の前でも動くように、node: の組み込みだけを import する
import { readdirSync, readFileSync } from 'node:fs';

// 重みの JSON と同じ形。ファイル名（e2e/ を除く）から、2 つのワーカーで走らせたときの合計の秒
export type Weights = Readonly<Record<string, number>>;

// e2e/ の直下で、シェルが引用せずに語に分けても崩れない名前（e2e-repeat と同じ。scripts/ci.ts の repeatFiles）
const FILE_NAME = /^[a-z0-9-]+\.test\.ts$/;

// Playwright は playwright.config.ts にワーカー数を持たず、CI の ubuntu-latest では 2 になる（ログの using 2 workers）
export const WORKERS = 2;

const E2E_DIR = new URL('../e2e/', import.meta.url);
const WEIGHTS_FILE = new URL('./e2e-shard-weights.json', import.meta.url);

export function readWeights(file: URL = WEIGHTS_FILE): Weights {
  return JSON.parse(readFileSync(file, 'utf8')) as Weights;
}

// e2e/ の直下の *.test.ts を名前順に並べる
export function listE2eFiles(dir: URL = E2E_DIR): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.test.ts'))
    .sort();
}

// 重みに載っているファイルの重みの中央値。重みが空なら 1
export function medianWeight(weights: Weights): number {
  const values = Object.values(weights).sort((a, b) => a - b);
  if (values.length === 0) return 1;
  const mid = values.length >> 1;
  return values.length % 2 === 1 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;
}

// 割る対象のファイルの重み。載っていないファイル（新しく足したテスト）は中央値。重みにあって e2e/ に無いファイルは使わない
export function weightsOf(files: readonly string[], weights: Weights): Map<string, number> {
  const median = medianWeight(weights);
  return new Map(files.map((file) => [file, Object.hasOwn(weights, file) ? weights[file]! : median]));
}

// 1 つのシャードの所要時間の見積もり（秒、準備は含まない）。Playwright が WORKERS 個のワーカーで、ファイルを名前順に先頭から取り、
// 先に空いたワーカーへ渡す動きを写す。1 つのファイルの中のテストは 1 つのワーカーが順に走らせる
export function simulateSeconds(files: readonly string[], weight: ReadonlyMap<string, number>): number {
  const free = new Array<number>(WORKERS).fill(0);
  for (const file of [...files].sort()) {
    let at = 0;
    for (let i = 1; i < free.length; i++) if (free[i]! < free[at]!) at = i;
    free[at]! += weight.get(file) ?? 0;
  }
  return Math.max(...free);
}

// 小さいほどよい。最長のシャードの見積もりを先に縮め、同じなら最長と最短の差を縮める
function cost(shards: readonly (readonly string[])[], weight: ReadonlyMap<string, number>): [number, number] {
  const times = shards.map((files) => simulateSeconds(files, weight));
  return [Math.max(...times), Math.max(...times) - Math.min(...times)];
}

function better(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i]! !== b[i]!) return a[i]! < b[i]!;
  return false;
}

// 重みの大きいファイルから順に、そこまでの合計が最も小さいシャードへ入れる（同点は番号の小さいシャード、同じ重みは名前順）
export function greedyShards(files: readonly string[], weight: ReadonlyMap<string, number>, n: number): string[][] {
  const shards: string[][] = Array.from({ length: n }, () => []);
  const sums = new Array<number>(n).fill(0);
  const order = [...files].sort((a, b) => weight.get(b)! - weight.get(a)! || (a < b ? -1 : a > b ? 1 : 0));
  for (const file of order) {
    let at = 0;
    for (let i = 1; i < n; i++) if (sums[i]! < sums[at]!) at = i;
    shards[at]!.push(file);
    sums[at]! += weight.get(file)!;
  }
  return shards;
}

// 近いシャードの割り方。1 つのファイルを別のシャードへ移すか、2 つのシャードのファイルを 1 つずつ入れ替える。決まった順に並べる
function* neighbors(shards: readonly (readonly string[])[]): Generator<string[][]> {
  for (let a = 0; a < shards.length; a++) {
    for (let b = 0; b < shards.length; b++) {
      if (a === b) continue;
      for (const fileA of shards[a]!) {
        yield shards.map((files, i) =>
          i === a ? files.filter((f) => f !== fileA) : i === b ? [...files, fileA] : [...files],
        );
        for (const fileB of shards[b]!) {
          yield shards.map((files, i) =>
            i === a
              ? [...files.filter((f) => f !== fileA), fileB]
              : i === b
                ? [...files.filter((f) => f !== fileB), fileA]
                : [...files],
          );
        }
      }
    }
  }
}

// 合計での割り方は、重いファイルが名前順の後ろに来ると、末尾で 1 つのワーカーだけが走って見積もりが伸びる。
// そこで、シミュレーションの所要時間が縮む限り、ファイルの移動と入れ替えを決まった順に試して採る（乱数は使わない）。
// 縮むたびに採るので必ず止まる
function improve(start: string[][], weight: ReadonlyMap<string, number>): string[][] {
  let shards = start;
  let best = cost(shards, weight);
  for (let improved = true; improved;) {
    improved = false;
    for (const next of neighbors(shards)) {
      if (next.some((files) => files.length === 0)) continue;
      const nextCost = cost(next, weight);
      if (better(nextCost, best)) {
        shards = next;
        best = nextCost;
        improved = true;
        break;
      }
    }
  }
  return shards;
}

// ファイルを n 個のシャードに割る。各シャードのファイルは名前順。名前がシェルの語に分けて崩れる形なら例外
export function assignShards(files: readonly string[], weights: Weights, n: number): string[][] {
  const bad = files.filter((file) => !FILE_NAME.test(file));
  if (bad.length > 0) {
    throw new Error(`e2e のテストのファイルの名前が ${FILE_NAME} に合わない: ${JSON.stringify(bad)}`);
  }
  const weight = weightsOf(files, weights);
  const shards = improve(greedyShards(files, weight, n), weight);
  return shards.map((shardFiles) => [...shardFiles].sort());
}

// i 番目（1 始まり）のシャードのファイル、重みの合計、見積もりの秒。i と n が整数でないか範囲外なら例外。
// シャードが空でも例外（Playwright はファイルが 0 件だと全件を走らせるため）
export function shardFor(
  i: number,
  n: number,
  files: readonly string[],
  weights: Weights,
): { files: string[]; seconds: number; weightSum: number } {
  if (!Number.isInteger(i) || !Number.isInteger(n) || n < 1 || i < 1 || i > n) {
    throw new Error(`シャードの番号と数が正しくない: ${i}/${n}（1 以上の整数で、番号は数以下）`);
  }
  const shards = assignShards(files, weights, n);
  const mine = shards[i - 1]!;
  if (mine.length === 0) {
    throw new Error(`シャード ${i}/${n} のファイルが 0 件（ファイル ${files.length} 件を ${n} 個に割った）`);
  }
  const weight = weightsOf(files, weights);
  return {
    files: mine,
    seconds: simulateSeconds(mine, weight),
    weightSum: mine.reduce((sum, file) => sum + weight.get(file)!, 0),
  };
}

function main(argv: readonly string[]): void {
  if (argv.length !== 2 || !argv.every((arg) => /^[0-9]+$/.test(arg))) {
    throw new Error('使い方: node scripts/e2e-shard.ts <i> <n>（どちらも整数。i は 1 以上 n 以下）');
  }
  const [i, n] = argv.map(Number) as [number, number];
  const shard = shardFor(i, n, listE2eFiles(), readWeights());
  // 標準出力はワークフローが $(...) で受けて pnpm e2e に渡すので、ファイルの一覧だけを書く
  console.error(
    `shard ${i}/${n}: ${shard.files.length} files, weight ${shard.weightSum} s, estimate ${shard.seconds} s (without setup)`,
  );
  console.log(shard.files.map((file) => `e2e/${file}`).join(' '));
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
