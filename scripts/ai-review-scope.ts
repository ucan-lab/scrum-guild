// CI の AI レビュー（.github/workflows/ai-review.yml）が見る差分の起点と範囲を決める。
// 印の抽出、候補の選択、差分の生成は export した関数にして node --test にかける。git はシェルを通さない。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SHA = /^[0-9a-f]{40}$/;

// 本文に印を並べると、印ごとに git を起こし、退けた印を scope.md に並べる。調べる数を抑える
export const MAX_MARKERS = 20;

export type MarkerSource = 'done-check' | 'ai-review';
export type Marker = { sha: string; source: MarkerSource };
export type RejectedMarker = { marker: string; reason: string };

export type Scope = {
  mode: 'full' | 'since' | 'none';
  start?: string;
  startSource?: MarkerSource;
  reason: string;
  rejected: RejectedMarker[];
};

type CommentLike = { user?: { login?: unknown; type?: unknown }; body?: unknown };

export function extractMarkers(body: unknown, comments: unknown): Marker[] {
  const result: Marker[] = [];
  const text = typeof body === 'string' ? body : '';
  for (const match of text.matchAll(/<!-- done-check:([^>\s]+) -->/g)) {
    // 形の不正な印も拾い、chooseScope で理由を付けて退ける
    result.push({ sha: match[1]!, source: 'done-check' });
  }
  const pages = Array.isArray(comments) ? comments : [];
  for (const comment of pages.flat() as CommentLike[]) {
    if (!comment || typeof comment !== 'object') continue;
    if (comment.user?.login !== 'github-actions[bot]' || comment.user?.type !== 'Bot') continue;
    if (typeof comment.body !== 'string') continue;
    // ワークフローは印を本文の先頭に付ける。先頭でない印は Claude のまとめの中身なので拾わない
    const match = /^<!-- ai-review:([^>\s]+) -->/.exec(comment.body);
    if (match) result.push({ sha: match[1]!, source: 'ai-review' });
  }
  return result;
}

function git(args: string[], cwd = process.cwd()): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
}

// diff.patch は前のワークフローと同じく git diff の出力のバイトのまま書く（UTF-8 でないファイルを U+FFFD に変えない）
function gitBytes(args: string[], cwd = process.cwd()): Buffer {
  return execFileSync('git', args, { cwd, maxBuffer: 128 * 1024 * 1024 });
}

// 0 は真、1 は偽。それ以外（git の異常）を偽と読むと、理由のずれた退け方になるので投げて段ごと落とし、全体に倒す
function check(args: string[], cwd = process.cwd()): boolean {
  const result = spawnSync('git', args, { cwd, stdio: 'ignore' });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git ${args[0]} が失敗しました（終了コード ${result.status}）`);
}

function sourceRank(source: MarkerSource): number {
  return source === 'ai-review' ? 0 : 1;
}

export function chooseScope(markers: readonly Marker[], baseSha: string, headSha: string, cwd = process.cwd()): Scope {
  const unique = [...new Map(markers.map((m) => [`${m.source} ${m.sha}`, m])).values()].slice(0, MAX_MARKERS);
  const mb = git(['merge-base', baseSha, headSha], cwd).trim();
  const rejected: RejectedMarker[] = [];
  const candidates: (Marker & { distance: number })[] = [];
  for (const marker of unique) {
    if (!SHA.test(marker.sha)) {
      // 形の不正な値は scope.md からまとめのコメントに写るので、中身を出さない
      rejected.push({ marker: marker.source, reason: 'SHA の形が不正' });
      continue;
    }
    const label = `${marker.source} ${marker.sha}`;
    // cat-file -e は「無い」を 128 で返すので、check に通さず終了コード 0 かで見る
    if (spawnSync('git', ['cat-file', '-e', `${marker.sha}^{commit}`], { cwd, stdio: 'ignore' }).status !== 0) {
      rejected.push({ marker: label, reason: 'コミットが無い' });
    } else if (!check(['merge-base', '--is-ancestor', marker.sha, headSha], cwd)) {
      rejected.push({ marker: label, reason: 'head の祖先でない' });
    } else if (check(['merge-base', '--is-ancestor', marker.sha, mb], cwd)) {
      rejected.push({ marker: label, reason: 'main 上のコミット' });
    } else {
      const distance = Number(git(['rev-list', '--count', `${marker.sha}..${headSha}`], cwd).trim());
      candidates.push({ ...marker, distance });
    }
  }
  if (candidates.length === 0) {
    return { mode: 'full', reason: markers.length === 0 ? '印が無い' : 'すべての印が退けられた', rejected };
  }
  // 別の枝を merge した PR では距離が並びうる。並び順で決めず、CI が見終えた ai-review の印を先にする
  const [best] = [...candidates].sort((a, b) => a.distance - b.distance || sourceRank(a.source) - sourceRank(b.source));
  return {
    mode: 'since',
    start: best!.sha,
    startSource: best!.source,
    reason: '有効な印のうち head に近い起点',
    rejected,
  };
}

export type DiffResult = { patch: Buffer; files: string; conflicts: string[]; empty: boolean };

function mergeTree(base: string, start: string, cwd = process.cwd()): { tree: string; conflicts: string[] } {
  const result = spawnSync('git', ['merge-tree', '--write-tree', '-z', '--name-only', base, start], {
    cwd,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1)
    throw new Error(`git merge-tree が失敗しました（終了コード ${result.status}）`);
  // -z --name-only の出力は「木 \0 衝突したパス \0 ... \0 \0 メッセージ」。衝突が無いと木の後にパスも空の区切りも続かない。
  // メッセージの文面から拾うと、パスでない文字列（"Merge conflict in x.txt"）を除外に渡してしまう
  const fields = result.stdout.split('\0');
  const tree = fields[0]!.trim();
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error('git merge-tree の木が読めません');
  const conflicts: string[] = [];
  if (result.status === 1) {
    for (const path of fields.slice(1)) {
      if (path === '') break;
      conflicts.push(path);
    }
  }
  return { tree, conflicts: [...new Set(conflicts)] };
}

const nameStatus = (args: string[], cwd: string) =>
  git(['-c', 'core.quotePath=false', 'diff', '--name-status', ...args], cwd);

export function scopedDiff(baseSha: string, headSha: string, startSha: string, cwd = process.cwd()): DiffResult {
  const mb = git(['merge-base', baseSha, headSha], cwd).trim();
  const merged = mergeTree(mb, startSha, cwd);
  const pathArgs = merged.conflicts.length
    ? ['--', ...merged.conflicts.map((path) => ':(exclude,literal)' + path)]
    : [];
  const patch = Buffer.concat([
    gitBytes(['diff', merged.tree, headSha, ...pathArgs], cwd),
    ...merged.conflicts.map((path) => gitBytes(['diff', mb, headSha, '--', ':(literal)' + path], cwd)),
  ]);
  const files =
    nameStatus([merged.tree, headSha, ...pathArgs], cwd) +
    merged.conflicts.map((path) => nameStatus([mb, headSha, '--', ':(literal)' + path], cwd)).join('');
  return { patch, files, conflicts: merged.conflicts, empty: patch.length === 0 && files === '' };
}

export function noDiffBody(start: string): string {
  return `AI レビュー: 起点 \`${start}\` から差分が無いので見ない。`;
}

const SOURCE_LABEL: Record<MarkerSource, string> = {
  'done-check': 'done-check の印（PR の本文の自己申告）',
  'ai-review': '前の AI レビューの印',
};

function scopeMarkdown(scope: Scope, conflicts: readonly string[]): string {
  const mode = scope.mode === 'since' ? '起点から' : scope.mode === 'none' ? '差分なし' : '全体';
  const start = scope.start ? `${scope.start}（${SOURCE_LABEL[scope.startSource!]}）` : 'なし';
  const lines = [`## AI レビューの範囲`, ``, `- 方式: ${mode}`, `- 起点: ${start}`, `- 理由: ${scope.reason}`];
  if (scope.rejected.length) {
    lines.push(`- 退けた印: ${scope.rejected.map((x) => `${x.marker}（${x.reason}）`).join('、')}`);
  }
  if (conflicts.length) lines.push(`- 衝突で全体に広げたパス: ${conflicts.join('、')}`);
  return lines.join('\n') + '\n';
}

function readRaw(rawDir: string): { body: unknown; comments: unknown } {
  try {
    return {
      body: JSON.parse(readFileSync(join(rawDir, 'pr.json'), 'utf8')).body,
      comments: JSON.parse(readFileSync(join(rawDir, 'issue-comments.json'), 'utf8')),
    };
  } catch {
    // 取得の段が落ちて pr-raw が無いか壊れているときは、印が無いものとして全体を見る
    return { body: '', comments: [] };
  }
}

// 起点から差分が無いとき、人がラベルで回したなら全体を見る。それ以外は Claude を動かさない
function settle(scope: Scope, diff: DiffResult, action: string | undefined): Scope {
  if (!diff.empty) return scope;
  if (action === 'labeled')
    return { ...scope, mode: 'full', reason: '起点から差分が無く、ラベルで回したので全体を見る' };
  return { ...scope, mode: 'none', reason: '起点から差分が無い' };
}

export function runScope(env: NodeJS.ProcessEnv): Scope {
  const base = env.BASE_SHA!;
  const head = env.HEAD_SHA!;
  const context = env.CONTEXT_DIR!;
  const { body, comments } = readRaw(env.RAW_DIR ?? '');
  const chosen = chooseScope(extractMarkers(body, comments), base, head);
  const diff = chosen.mode === 'since' ? scopedDiff(base, head, chosen.start!) : undefined;
  const scope = diff ? settle(chosen, diff, env.EVENT_ACTION) : chosen;

  mkdirSync(context, { recursive: true });
  if (scope.mode === 'since') {
    writeFileSync(join(context, 'diff.patch'), diff!.patch);
    writeFileSync(join(context, 'files.txt'), diff!.files);
  } else if (scope.mode === 'full') {
    writeFileSync(join(context, 'diff.patch'), gitBytes(['diff', `${base}...${head}`]));
    writeFileSync(join(context, 'files.txt'), nameStatus([`${base}...${head}`], process.cwd()));
  } else {
    writeFileSync(join(context, 'diff.patch'), '');
    writeFileSync(join(context, 'files.txt'), '');
    writeFileSync(env.NO_DIFF_BODY_FILE!, noDiffBody(scope.start!));
  }
  writeFileSync(join(context, 'scope.md'), scopeMarkdown(scope, scope.mode === 'since' ? diff!.conflicts : []));
  if (env.GITHUB_OUTPUT) {
    writeFileSync(env.GITHUB_OUTPUT, `mode=${scope.mode}\nstart=${scope.start ?? ''}\n`, { flag: 'a' });
  }
  console.log(`方式=${scope.mode} 起点=${scope.start ?? 'なし'} 退けた印=${scope.rejected.length} 件`);
  return scope;
}

if (import.meta.main) {
  try {
    runScope(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : '起点の判定に失敗しました');
    process.exit(1);
  }
}
