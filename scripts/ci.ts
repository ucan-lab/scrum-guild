// CI（.github/workflows/ci.yml）が使う判定。ワークフローに書かず、ここで node --test にかける。

// CLAUDE.md の「守ること」で main に直接入れてよい文書と同じ範囲。片方を変えるときは両方を直す
const docsPatterns: RegExp[] = [
  /^docs\//,
  /^HANDOFF\.md$/,
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

// ci-ok のジョブが受け取る toJSON(needs) の形
export type Needs = Record<string, { result: string; outputs?: Record<string, string> }>;

// changes を除く needs のジョブすべてを重いジョブとして見る。ジョブを足したときは needs に入れれば判定に入る。
// 文書だけなら重いジョブがすべて skipped、そうでなければすべて success のときだけ通す
export function ciOkVerdict(needs: Needs): { ok: true } | { ok: false; reason: string } {
  const changes = needs.changes;
  if (changes?.result !== 'success') {
    return { ok: false, reason: `changes が success でない（${changes?.result ?? '無し'}）` };
  }
  const heavy = Object.entries(needs).filter(([name]) => name !== 'changes');
  if (heavy.length === 0) return { ok: false, reason: '重いジョブが needs に無い' };

  const expected = changes.outputs?.docs_only === 'true' ? 'skipped' : 'success';
  const unexpected = heavy.filter(([, job]) => job.result !== expected);
  if (unexpected.length > 0) {
    const list = unexpected.map(([name, job]) => `${name}=${job.result}`).join(', ');
    return { ok: false, reason: `${expected} でないジョブがある: ${list}` };
  }
  return { ok: true };
}

// wrangler d1 migrations apply が当てるのは migrations/ 直下の .sql だけ
export function migrationFiles(names: readonly string[]): string[] {
  return names.filter((name) => name.endsWith('.sql')).sort();
}
