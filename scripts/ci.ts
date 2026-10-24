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

// 変わったファイルがすべて文書の範囲に収まるときだけ真。一覧が空なら、判定を誤ったとみて偽にする（重いジョブを回す側に倒す）
export function isDocsOnly(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every((path) => docsPatterns.some((pattern) => pattern.test(path)));
}

// wrangler d1 migrations apply が当てるのは migrations/ 直下の .sql だけ
export function migrationFiles(names: readonly string[]): string[] {
  return names.filter((name) => name.endsWith('.sql')).sort();
}
