// CI（.github/workflows/ci.yml）が使う判定。ワークフローに書かず、ここで node --test にかける。

// docs/development.md の「文書だけの PR」に書いた範囲。片方を変えるときは両方を直す
const docsPatterns: RegExp[] = [
  /^docs\//,
  /^CLAUDE\.md$/,
  /^\.claude\/(skills|agents|checklists)\//,
  /^\.github\/ISSUE_TEMPLATE\//,
];

// git diff --name-only -z の出力を名前の一覧にする。-z を付けないと、日本語や空白を含む名前を git が引用して書き換える。
// 名前の前後の空白も名前の一部なので削らない
export function parseNulSeparated(output: string): string[] {
  return output.split('\0').filter((path) => path !== '');
}

// 変わったファイルがすべて文書の範囲の .md のときだけ真。範囲の中でもスクリプトなどは、検査で確かめるものなので
// 文書に数えない。一覧が空なら、判定を誤ったとみて偽にする（重いジョブを回す側に倒す）
export function isDocsOnly(paths: readonly string[]): boolean {
  return (
    paths.length > 0 &&
    paths.every((path) => path.endsWith('.md') && docsPatterns.some((pattern) => pattern.test(path)))
  );
}

// 開発モードの e2e（e2e-dev。#375）を走らせる変更。Svelte と SvelteKit の開発時の警告は、画面のコードのほか、
// 依存の版上げ（#368 の警告は SvelteKit 3 への上げで出た）と、e2e と build の仕組み、CI の用意、e2e が開くデータ（seed）の
// 変更でも出方が変わる。docs/development.md の「CI」に書いた範囲。片方を変えるときは両方を直す
const devBuildPatterns: RegExp[] = [
  /^src\/(?!server\/)/,
  /^e2e\//,
  /^static\//,
  /^seed\//,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^\.node-version$/,
  /^tsconfig\.json$/,
  /^vite\.config\.ts$/,
  /^playwright\.config\.ts$/,
  /^wrangler\.jsonc$/,
  /^scripts\/(e2e-server|dev-warnings|dev|dev-ports|write-headers|headers|db-seed)\.ts$/,
  /^\.github\/workflows\/ci\.yml$/,
  /^\.github\/actions\//,
];

// 一覧が空なら、isDocsOnly と同じく判定を誤ったとみて走らせる側に倒す
export function needsDevBuild(paths: readonly string[]): boolean {
  return paths.length === 0 || paths.some((path) => devBuildPatterns.some((pattern) => pattern.test(path)));
}

// e2e-repeat（#451）が繰り返す名前の形。repeat_files は GITHUB_OUTPUT の1行に空白区切りで書き、シェルが引用せずに語に分けるので、
// 空白、改行、グロブやシェルの記号を含みえない形に限る
const repeatFileName = /^e2e\/[a-z0-9-]+\.test\.ts$/;

// 足したか変えたファイルの一覧（git diff --diff-filter=AM）から、e2e-repeat が繰り返すテストのファイルを選ぶ。
// 共通のファイル（e2e/fixtures.ts など）と画面のコードは選ばない（docs/development.md の「CI」）。
// テストのファイルらしい名前（e2e/ で始まり .test.ts で終わる）が形に合わなければ、黙って外さずに例外にして changes を落とす
export function repeatFiles(paths: readonly string[]): string[] {
  const files = paths.filter((path) => path.startsWith('e2e/') && path.endsWith('.test.ts'));
  const bad = files.filter((path) => !repeatFileName.test(path));
  if (bad.length > 0) {
    throw new Error(`e2e のテストのファイルの名前が ${repeatFileName} に合わない: ${JSON.stringify(bad)}`);
  }
  return [...new Set(files)].sort();
}

// 繰り返しに耐えず、選ばれても e2e-repeat が繰り返さないファイルと、直す Issue の番号。2026-10-29 に全件を
// --workers=1 --repeat-each=2 で回し、2回目で落ちたファイル（seed の行を変えたまま終えるか、同じ名前の行を毎回作る）。
// 直したファイルから外す。足さない（新しいテストは繰り返しに耐えるように書く。docs/development.md の「e2e の書き方」）
export const REPEAT_EXCLUDED: ReadonlyMap<string, number> = new Map([
  ['e2e/history.test.ts', 459],
  ['e2e/invitations.test.ts', 459],
  ['e2e/layout-narrow.test.ts', 459],
  ['e2e/logout.test.ts', 459],
  ['e2e/members.test.ts', 459],
  ['e2e/users.test.ts', 459],
  ['e2e/workspace-close.test.ts', 459],
]);

// 選んだファイルを、繰り返すものと外す一覧に当たるもの（Issue の番号つき）に分ける
export function splitRepeatExcluded(
  files: readonly string[],
  excluded: ReadonlyMap<string, number> = REPEAT_EXCLUDED,
): { files: string[]; excluded: [string, number][] } {
  return {
    files: files.filter((path) => !excluded.has(path)),
    excluded: files.flatMap((path): [string, number][] => {
      const issue = excluded.get(path);
      return issue === undefined ? [] : [[path, issue]];
    }),
  };
}

// e2e-repeat が回すテストの件数の上限。1件を5回で約10秒、3つのシャードで上限いっぱいでも1つ約5分（#451）
export const REPEAT_TEST_LIMIT = 60;

// playwright test --list --reporter=json の出力のうち、件数を数えるのに読む形
type ListedSuite = { specs?: { tests?: unknown[] }[]; suites?: ListedSuite[] };
export type ListReport = { suites?: ListedSuite[]; errors?: unknown[] };

// --list の出力のテストの件数。describe は suites の入れ子になるので、たどって specs の tests（プロジェクトごとに1つ）を数える
export function countListedTests(report: ListReport): number {
  const count = (suites: readonly ListedSuite[] = []): number =>
    suites.reduce(
      (sum, suite) =>
        sum + (suite.specs ?? []).reduce((n, spec) => n + (spec.tests?.length ?? 0), 0) + count(suite.suites),
      0,
    );
  return count(report.suites);
}

// e2e-repeat が繰り返すか。上限ちょうどまでは回す。テストのファイルが読めない（構文の誤りなど）ときは、
// 回さずに通すのでなく例外にしてジョブを落とす。ファイルを渡したのに 0 件なら、Playwright の更新で出力の形が変わり
// 数えられなくなったとみて落とす（黙って 0 件と数えると上限が効かない。テストの無いファイルだけなら --list が先に落ちる）
export function repeatVerdict(report: ListReport, fileCount: number): { run: boolean; count: number } {
  if ((report.errors ?? []).length > 0) {
    throw new Error(`playwright test --list がエラーを返した: ${JSON.stringify(report.errors)}`);
  }
  const count = countListedTests(report);
  if (fileCount > 0 && count === 0) {
    throw new Error(
      `${fileCount} 個のファイルを渡したのに 0 件と数えた。--list の出力の形が変わっていないかを確かめる`,
    );
  }
  return { run: count <= REPEAT_TEST_LIMIT, count };
}

// ci-ok のジョブが受け取る toJSON(needs) の形
export type Needs = Record<string, { result: string; outputs?: Record<string, string> }>;

// 変わったファイルで走るかが決まる重いジョブと、それを決める changes の出力の名前。
// Map にするのは、ジョブの名前が toString などのときに Object.prototype のメンバーを引かないため
const conditionalJobs = new Map([
  ['e2e-dev', 'dev_build'],
  ['e2e-repeat', 'repeat'],
]);

// changes を除く needs のジョブすべてを重いジョブとして見る。ジョブを足したときは needs に入れれば判定に入る。
// 文書だけなら重いジョブがすべて skipped、そうでなければすべて success のときだけ通す。
// ただし conditionalJobs のジョブは、文書だけでなくても changes の出力が偽なら skipped を期待する。
// 出力が 'true' でも 'false' でもなければ（changes の出力の欠け）、判定を誤ったとみて通さない
export function ciOkVerdict(needs: Needs): { ok: true } | { ok: false; reason: string } {
  const changes = needs.changes;
  if (changes?.result !== 'success') {
    return { ok: false, reason: `changes が success でない（${changes?.result ?? '無し'}）` };
  }
  const heavy = Object.entries(needs).filter(([name]) => name !== 'changes');
  if (heavy.length === 0) return { ok: false, reason: '重いジョブが needs に無い' };

  const docsOnly = changes.outputs?.docs_only === 'true';
  if (!docsOnly) {
    for (const [name] of heavy) {
      const output = conditionalJobs.get(name);
      const value = output === undefined ? undefined : changes.outputs?.[output];
      if (output !== undefined && value !== 'true' && value !== 'false') {
        return { ok: false, reason: `changes の出力 ${output} が無いか、真偽でない（${value ?? '無し'}）` };
      }
    }
  }
  const expectedOf = (name: string): string => {
    if (docsOnly) return 'skipped';
    const output = conditionalJobs.get(name);
    return output === undefined || changes.outputs?.[output] === 'true' ? 'success' : 'skipped';
  };
  const unexpected = heavy.filter(([name, job]) => job.result !== expectedOf(name));
  if (unexpected.length > 0) {
    const list = unexpected.map(([name, job]) => `${name}=${job.result}（期待は ${expectedOf(name)}）`).join(', ');
    return { ok: false, reason: `期待と違うジョブがある: ${list}` };
  }
  return { ok: true };
}

// wrangler d1 migrations apply が当てるのは migrations/ 直下の .sql だけ
export function migrationFiles(names: readonly string[]): string[] {
  return names.filter((name) => name.endsWith('.sql')).sort();
}
