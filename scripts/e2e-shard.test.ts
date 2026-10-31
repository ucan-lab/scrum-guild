import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  assignShards,
  greedyShards,
  listE2eFiles,
  medianWeight,
  readWeights,
  shardFor,
  simulateSeconds,
  weightsOf,
  WORKERS,
} from './e2e-shard.ts';
import { sumDurations } from './e2e-shard-weights.ts';

const SHARDS = 3;
// CI のジョブの準備（checkout、setup、Playwright、build、サーバーの起動。run 41180554724 で約 40 秒）
const SETUP_SECONDS = 40;
// Issue #601 の受け入れ条件
const MAX_SECONDS = 270;
const MAX_SPREAD_SECONDS = 60;

describe('assignShards', () => {
  const weights = {
    'a.test.ts': 50,
    'b.test.ts': 30,
    'c.test.ts': 30,
    'd.test.ts': 20,
    'e.test.ts': 10,
    'f.test.ts': 5,
  };
  const files = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts', 'e.test.ts', 'f.test.ts', 'g.test.ts'];

  test('全ファイルを過不足なく 1 つのシャードに入れ、各シャードは名前順', () => {
    const shards = assignShards(files, weights, 3);
    assert.equal(shards.length, 3);
    assert.deepEqual([...shards.flat()].sort(), files);
    for (const shard of shards) assert.deepEqual(shard, [...shard].sort());
  });

  test('同じ入力には同じ答え（入力の並びにもよらない）', () => {
    const first = assignShards(files, weights, 3);
    assert.deepEqual(assignShards(files, weights, 3), first);
    assert.deepEqual(assignShards([...files].reverse(), weights, 3), first);
  });

  test('重みに無いファイルは、載っている重みの中央値で割る', () => {
    assert.equal(medianWeight(weights), 25);
    assert.equal(medianWeight({ a: 1, b: 9, c: 5 }), 5);
    assert.equal(medianWeight({}), 1);
    const weight = weightsOf(files, weights);
    assert.equal(weight.get('g.test.ts'), 25);
    assert.equal(weight.get('a.test.ts'), 50);
  });

  test('重みにあって e2e/ に無いファイルは無視する', () => {
    const shards = assignShards(['a.test.ts', 'g.test.ts'], { ...weights, 'gone.test.ts': 999 }, 2);
    assert.deepEqual([...shards.flat()].sort(), ['a.test.ts', 'g.test.ts']);
  });

  test('重い 1 ファイルは、ほかのファイルの合計より重くても単独のシャードに入る', () => {
    const shards = assignShards(
      ['big.test.ts', 'x.test.ts', 'y.test.ts'],
      { 'big.test.ts': 100, 'x.test.ts': 5, 'y.test.ts': 5 },
      2,
    );
    assert.deepEqual(shards, [['big.test.ts'], ['x.test.ts', 'y.test.ts']]);
  });

  test('名前がシェルの語に分けて崩れる形のファイルがあれば落とす', () => {
    for (const name of [
      'A.test.ts',
      'a b.test.ts',
      'a_b.test.ts',
      'a.spec.ts',
      '$(x).test.ts',
      'a;b.test.ts',
      '*.test.ts',
    ]) {
      assert.throws(() => assignShards(['a.test.ts', name], weights, 2), /合わない/, name);
    }
  });
});

describe('simulateSeconds', () => {
  test('2 つのワーカーに、名前順で先に空いたほうへ渡す', () => {
    assert.equal(WORKERS, 2);
    const weight = new Map([
      ['a.test.ts', 10],
      ['b.test.ts', 10],
      ['c.test.ts', 10],
      ['d.test.ts', 30],
    ]);
    // a、b が同時に始まり、c は a の後、d は b の後に始まって 10 + 30 = 40 まで走る
    assert.equal(simulateSeconds(['d.test.ts', 'c.test.ts', 'b.test.ts', 'a.test.ts'], weight), 40);
    assert.equal(simulateSeconds([], weight), 0);
  });

  test('重いファイルが名前順の最後にあると、1 つのワーカーだけが走って伸びる', () => {
    const weight = new Map([
      ['a.test.ts', 10],
      ['b.test.ts', 10],
      ['z.test.ts', 40],
    ]);
    assert.equal(simulateSeconds(['a.test.ts', 'b.test.ts', 'z.test.ts'], weight), 50);
  });
});

describe('shardFor', () => {
  const weights = { 'a.test.ts': 10, 'b.test.ts': 20, 'c.test.ts': 30 };
  const files = ['a.test.ts', 'b.test.ts', 'c.test.ts'];

  test('i 番目のシャードのファイル、重みの合計、見積もりを返す', () => {
    const all = [1, 2, 3].map((i) => shardFor(i, 3, files, weights));
    assert.deepEqual(all.flatMap((shard) => shard.files).sort(), files);
    for (const shard of all) {
      assert.equal(
        shard.weightSum,
        shard.files.reduce((sum, file) => sum + weights[file as keyof typeof weights], 0),
      );
      assert.ok(shard.seconds > 0);
    }
  });

  test('番号と数が整数でないか範囲外なら落とす', () => {
    for (const [i, n] of [
      [0, 3],
      [4, 3],
      [1.5, 3],
      [1, 2.5],
      [Number.NaN, 3],
      [1, 0],
      [-1, 3],
    ] as const) {
      assert.throws(() => shardFor(i, n, files, weights), /正しくない/, `${i}/${n}`);
    }
  });

  test('ファイルが 0 件のシャードがあれば落とす（空だと Playwright が全件を走らせる）', () => {
    assert.throws(() => shardFor(4, 4, files, weights), /0 件/);
    assert.throws(() => shardFor(1, 1, [], weights), /0 件/);
  });
});

describe('手元の e2e/ と scripts/e2e-shard-weights.json', () => {
  const files = listE2eFiles();
  const weights = readWeights();
  const weight = weightsOf(files, weights);
  const shards = assignShards(files, weights, SHARDS);
  const seconds = shards.map((shard) => simulateSeconds(shard, weight));

  test('重みの JSON は、ファイル名から正の秒への対応', () => {
    for (const [name, value] of Object.entries(weights)) {
      assert.match(name, /^[a-z0-9-]+\.test\.ts$/);
      assert.ok(Number.isFinite(value) && value > 0, name);
    }
  });

  test('e2e/ の直下のテストのファイルは、名前がシェルの語に分けて崩れない形', () => {
    assert.ok(files.length > 0);
    assert.doesNotThrow(() => assignShards(files, weights, SHARDS));
  });

  test(`${SHARDS} つのシャードに全ファイルが過不足なく入り、どれも空でない`, () => {
    assert.deepEqual([...shards.flat()].sort(), files);
    for (const shard of shards) assert.ok(shard.length > 0);
  });

  test(`見積もりの差が ${MAX_SPREAD_SECONDS} 秒以内（余裕を見て 40 秒以内）`, () => {
    assert.ok(Math.max(...seconds) - Math.min(...seconds) <= 40, JSON.stringify(seconds));
  });

  test(`準備の ${SETUP_SECONDS} 秒を足しても最長が ${MAX_SECONDS} 秒以下`, () => {
    assert.ok(Math.max(...seconds) + SETUP_SECONDS <= MAX_SECONDS, JSON.stringify(seconds));
  });

  test('合計だけの貪欲な割り方では足りず、シミュレーションで詰めている（詰めた割り方が貪欲より最長が短い）', () => {
    const greedy = greedyShards(files, weight, SHARDS).map((shard) => simulateSeconds(shard, weight));
    assert.ok(Math.max(...seconds) < Math.max(...greedy), `${JSON.stringify(seconds)} と ${JSON.stringify(greedy)}`);
  });

  test('重みに無いファイルが増えても、全ファイルがいずれかのシャードに入る', () => {
    const more = [...files, 'zz-new-1.test.ts', 'zz-new-2.test.ts'];
    assert.deepEqual([...assignShards(more, weights, SHARDS).flat()].sort(), more);
  });

  test('重みの合計は、完全に均した下限（約 205 秒）から大きく外れない', () => {
    const total = files.reduce((sum, file) => sum + weight.get(file)!, 0);
    assert.ok(Math.max(...seconds) <= total / SHARDS / WORKERS + 20, `${total} / ${SHARDS} / ${WORKERS}`);
  });
});

describe('node scripts/e2e-shard.ts', () => {
  const script = new URL('./e2e-shard.ts', import.meta.url).pathname;
  const run = (...args: string[]) => spawnSync('node', [script, ...args], { encoding: 'utf8' });

  test('標準出力に e2e/<名前> を空白区切りの 1 行で出し、3 つ合わせて全ファイルになる', () => {
    const out = [1, 2, 3].map((i) => {
      const result = run(String(i), '3');
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^e2e\/[a-z0-9-]+\.test\.ts( e2e\/[a-z0-9-]+\.test\.ts)*\n$/);
      return result.stdout.trim().split(' ');
    });
    assert.deepEqual(
      out.flat().sort(),
      listE2eFiles().map((file) => `e2e/${file}`),
    );
  });

  test('不正な引数と空のシャードは非 0 で、標準出力に何も出さない', () => {
    for (const args of [
      [],
      ['1'],
      ['0', '3'],
      ['4', '3'],
      ['a', '3'],
      ['1', '3', '4'],
      ['1.5', '3'],
      ['1', '-3'],
      ['99', '99'],
    ]) {
      const result = run(...args);
      assert.notEqual(result.status, 0, args.join(' '));
      assert.equal(result.stdout, '', args.join(' '));
    }
  });

  test('ci.yml が e2e と e2e-dev でこのスクリプトを使い、e2e-repeat は --shard のまま', () => {
    const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const job = (name: string) => {
      const start = workflow.indexOf(`\n  ${name}:\n`);
      assert.notEqual(start, -1, name);
      const next = workflow.slice(start + 1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
      const text = workflow.slice(start, next === -1 ? undefined : start + 1 + next);
      // コメントの行は除く（コメントに --shard と書いても判定に入れない）
      return text
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .join('\n');
    };
    for (const name of ['e2e', 'e2e-dev']) {
      assert.match(
        job(name),
        /node scripts\/e2e-shard\.ts \$\{\{ matrix\.shard \}\} \$\{\{ strategy\.job-total \}\}/,
        name,
      );
      assert.doesNotMatch(job(name), /--shard=/, name);
    }
    assert.match(job('e2e-repeat'), /--shard=\$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}/);
  });
});

describe('sumDurations（scripts/e2e-shard-weights.ts）', () => {
  test('list reporter の行の秒をファイルごとに足し、ms と s と m を読む', () => {
    const log = [
      '  ✓   1 [chromium] › e2e/task-drawer.test.ts:30:5 › 開く (1.2s)',
      '  ✓   2 [chromium] › e2e/task-drawer.test.ts:50:5 › 閉じる (800ms)',
      '  ✓   3 [chromium] › e2e/a11y-open.test.ts:10:5 › 題 (括弧) (1.5m)',
      '  ✘   4 [chromium] › e2e/a11y-open.test.ts:20:5 › 落ちた (10s)',
    ].join('\n');
    assert.deepEqual(sumDurations([log]), { 'a11y-open.test.ts': 100, 'task-drawer.test.ts': 2 });
  });

  test('複数のログを合算し、行頭の時刻と色の制御文字を読み飛ばす', () => {
    const a = '2026-10-31T01:02:03.4567890Z   ✓   1 [chromium] › e2e/me.test.ts:5:5 › x (10.4s)\n';
    const b = '\u001b[32m  ✓\u001b[39m   2 [chromium] › e2e/me.test.ts:9:5 › y (20.4s)\n';
    assert.deepEqual(sumDurations([a, b]), { 'me.test.ts': 31 });
  });

  test('飛ばしたテストのファイルは 1 秒で載せ、1 秒未満のファイルも 1 秒にする', () => {
    const log = [
      '  -   1 [chromium] › e2e/dev-warnings.test.ts:5:5 › x',
      '  ✓   2 [chromium] › e2e/operations.test.ts:9:5 › y (6ms)',
    ].join('\n');
    assert.deepEqual(sumDurations([log]), { 'dev-warnings.test.ts': 1, 'operations.test.ts': 1 });
  });

  test('テストの行以外と e2e/ の外のファイルは数えない', () => {
    const log = [
      'Running 3 tests using 2 workers',
      '  ✓   1 [chromium] › src/x.test.ts:5:5 › y (1s)',
      '  3 passed (5.0s)',
    ].join('\n');
    assert.deepEqual(sumDurations([log]), {});
  });

  test('標準入力と複数のファイルを渡して実行できる', () => {
    const script = new URL('./e2e-shard-weights.ts', import.meta.url).pathname;
    const out = execFileSync('node', [script], {
      input: '  ✓   1 [chromium] › e2e/me.test.ts:5:5 › x (3.4s)\n',
      encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(out), { 'me.test.ts': 3 });
    const empty = spawnSync('node', [script], { input: 'なし\n', encoding: 'utf8' });
    assert.notEqual(empty.status, 0);
  });
});
