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

// 変わったファイルがすべて文書の範囲の .md のときだけ真。範囲の中でもスクリプトなどは、needs-human も付かないまま
// 検査を飛ばすことになるので文書に数えない。一覧が空なら、判定を誤ったとみて偽にする（重いジョブを回す側に倒す）
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

// ci-ok のジョブが受け取る toJSON(needs) の形
export type Needs = Record<string, { result: string; outputs?: Record<string, string> }>;

// 変わったファイルで走るかが決まる重いジョブと、それを決める changes の出力の名前。
// Map にするのは、ジョブの名前が toString などのときに Object.prototype のメンバーを引かないため
const conditionalJobs = new Map([['e2e-dev', 'dev_build']]);

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
