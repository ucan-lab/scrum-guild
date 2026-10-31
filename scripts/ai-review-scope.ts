// CI の AI レビュー（.github/workflows/ai-review.yml）が見る差分の起点と範囲を決める。
// 印の抽出、候補の選択、差分の生成は export した関数にして node --test にかける。git はシェルを通さない。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SHA = /^[0-9a-f]{40}$/;

export type Marker = { sha: string; source: 'done-check' | 'ai-review'; raw: string };
export type RejectedMarker = { marker: string; reason: string };
export type Candidate = Marker & { distance?: number };
export type GitRunner = (args: string[]) => string;

export type Scope = {
  mode: 'full' | 'since' | 'none';
  start?: string;
  reason: string;
  rejected: RejectedMarker[];
};

export function extractMarkers(body: unknown, comments: unknown): Marker[] {
  const result: Marker[] = [];
  const text = typeof body === 'string' ? body : '';
  for (const match of text.matchAll(/<!-- done-check:([^>\s]+) -->/g)) {
    // 形の不正な印も拾い、chooseScope で理由を付けて退ける（scope.md に載せるため）
    result.push({ sha: match[1]!, source: 'done-check', raw: match[0]! });
  }
  const pages = Array.isArray(comments) ? comments : [];
  for (const comment of pages.flat()) {
    if (
      comment &&
      typeof comment === 'object' &&
      (comment as { user?: { login?: string; type?: string } }).user?.login === 'github-actions[bot]' &&
      (comment as { user?: { login?: string; type?: string } }).user?.type === 'Bot'
    ) {
      const commentBody = (comment as { body?: unknown }).body;
      if (typeof commentBody !== 'string') continue;
      const match = /^<!-- ai-review:([^>\s]+) -->/.exec(commentBody);
      if (match) result.push({ sha: match[1]!, source: 'ai-review', raw: match[0]! });
    }
  }
  return result;
}

function git(args: string[], cwd = process.cwd()): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
}

function ok(args: string[], cwd = process.cwd()): boolean {
  return spawnSync('git', args, { cwd, stdio: 'ignore' }).status === 0;
}

export function chooseScope(markers: readonly Marker[], baseSha: string, headSha: string, cwd = process.cwd()): Scope {
  const rejected: RejectedMarker[] = [];
  const mb = git(['merge-base', baseSha, headSha], cwd).trim();
  const candidates: Candidate[] = [];
  for (const marker of markers) {
    const label = `${marker.source} ${marker.sha}`;
    if (!SHA.test(marker.sha)) {
      rejected.push({ marker: label, reason: 'SHA の形が不正' });
    } else if (!ok(['cat-file', '-e', `${marker.sha}^{commit}`], cwd)) {
      rejected.push({ marker: label, reason: 'コミットが無い' });
    } else if (!ok(['merge-base', '--is-ancestor', marker.sha, headSha], cwd)) {
      rejected.push({ marker: label, reason: 'head の祖先でない' });
    } else if (ok(['merge-base', '--is-ancestor', marker.sha, mb], cwd)) {
      rejected.push({ marker: label, reason: 'main 上のコミット' });
    } else {
      candidates.push({
        ...marker,
        distance: Number(git(['rev-list', '--count', `${marker.sha}..${headSha}`], cwd).trim()),
      });
    }
  }
  if (candidates.length === 0) {
    return { mode: 'full', reason: markers.length === 0 ? '印が無い' : 'すべての印が退けられた', rejected };
  }
  candidates.sort((a, b) => a.distance! - b.distance!);
  return { mode: 'since', start: candidates[0]!.sha, reason: '有効な印のうち head に近い起点', rejected };
}

export type DiffResult = { patch: string; files: string; conflicts: string[]; empty: boolean };

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
  const fields = (result.stdout as string).split('\0');
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

function diff(args: string[], cwd = process.cwd()): string {
  return git(['diff', ...args], cwd);
}

export function scopedDiff(baseSha: string, headSha: string, startSha: string, cwd = process.cwd()): DiffResult {
  const mb = git(['merge-base', baseSha, headSha], cwd).trim();
  const merged = mergeTree(mb, startSha, cwd);
  const excludes = merged.conflicts.flatMap((path) => [':(exclude,literal)' + path]);
  const pathArgs = excludes.length ? ['--', ...excludes] : [];
  const patch =
    diff([merged.tree, headSha, ...pathArgs], cwd) +
    merged.conflicts.map((path) => diff([mb, headSha, '--', ':(literal)' + path], cwd)).join('');
  const files =
    git(['-c', 'core.quotePath=false', 'diff', '--name-status', merged.tree, headSha, ...pathArgs], cwd) +
    merged.conflicts
      .map((path) =>
        git(['-c', 'core.quotePath=false', 'diff', '--name-status', mb, headSha, '--', ':(literal)' + path], cwd),
      )
      .join('');
  return { patch, files, conflicts: merged.conflicts, empty: patch === '' && files === '' };
}

export function noDiffBody(start: string): string {
  return `AI レビュー: 起点 \`${start}\` から差分が無いので見ない。`;
}

function scopeMarkdown(scope: Scope, conflicts: string[] = []): string {
  const mode = scope.mode === 'since' ? '起点から' : scope.mode === 'none' ? '差分なし' : '全体';
  return (
    [
      `## AI レビューの範囲`,
      ``,
      `- 方式: ${mode}`,
      `- 起点: ${scope.start ?? 'なし'}`,
      `- 理由: ${scope.reason}`,
      ...(scope.rejected.length
        ? [`- 退けた印: ${scope.rejected.map((x) => `${x.marker}（${x.reason}）`).join('、')}`]
        : []),
      ...(conflicts.length ? [`- 衝突で全体に広げたパス: ${conflicts.join('、')}`] : []),
    ].join('\n') + '\n'
  );
}

export function runScope(env: NodeJS.ProcessEnv): Scope {
  const rawDir = env.RAW_DIR ?? '';
  let body = '';
  let comments: unknown = [];
  try {
    body = JSON.parse(readFileSync(join(rawDir, 'pr.json'), 'utf8')).body ?? '';
    comments = JSON.parse(readFileSync(join(rawDir, 'issue-comments.json'), 'utf8'));
  } catch {
    // pr-raw が無いときは印が無いものとして全体にする。
  }
  const scope = chooseScope(extractMarkers(body, comments), env.BASE_SHA!, env.HEAD_SHA!);
  const context = env.CONTEXT_DIR!;
  mkdirSync(context, { recursive: true });
  let conflicts: string[] = [];
  if (scope.mode === 'since') {
    const result = scopedDiff(env.BASE_SHA!, env.HEAD_SHA!, scope.start!);
    conflicts = result.conflicts;
    if (result.empty) {
      if (env.EVENT_ACTION === 'labeled') {
        scope.mode = 'full';
        scope.reason = '起点から差分が無く、ラベルで回したので全体を見る';
      } else {
        scope.mode = 'none';
        scope.reason = '起点から差分が無い';
      }
    } else {
      writeFileSync(join(context, 'diff.patch'), result.patch);
      writeFileSync(join(context, 'files.txt'), result.files);
    }
    if (scope.mode === 'full') {
      writeFileSync(join(context, 'diff.patch'), diff([`${env.BASE_SHA}...${env.HEAD_SHA}`]));
      writeFileSync(
        join(context, 'files.txt'),
        git(['-c', 'core.quotePath=false', 'diff', '--name-status', `${env.BASE_SHA}...${env.HEAD_SHA}`]),
      );
    }
  } else if (scope.mode === 'full') {
    writeFileSync(join(context, 'diff.patch'), diff([`${env.BASE_SHA}...${env.HEAD_SHA}`]));
    writeFileSync(
      join(context, 'files.txt'),
      git(['-c', 'core.quotePath=false', 'diff', '--name-status', `${env.BASE_SHA}...${env.HEAD_SHA}`]),
    );
  }
  if (scope.mode === 'none') {
    writeFileSync(join(context, 'diff.patch'), '');
    writeFileSync(join(context, 'files.txt'), '');
    writeFileSync(env.NO_DIFF_BODY_FILE!, noDiffBody(scope.start!));
  }
  writeFileSync(join(context, 'scope.md'), scopeMarkdown(scope, conflicts));
  if (env.GITHUB_OUTPUT)
    writeFileSync(env.GITHUB_OUTPUT, `mode=${scope.mode}\nstart=${scope.start ?? ''}\n`, { flag: 'a' });
  console.log(`方式=${scope.mode} 起点=${scope.start ?? 'なし'} 件数=${scope.rejected.length + (scope.start ? 1 : 0)}`);
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
