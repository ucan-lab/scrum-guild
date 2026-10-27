// e2e のスクリーンショットを PR に並べる処理（docs/development.md の「CI」の evidence と evidence-main）。
// 比べる、上げる先の名前を決める、コメントの本文を組むところをここに置き、node --test にかける。
// R2 への送信とコメントの書き換えはワークフローの段が行う
import { createHash } from 'node:crypto';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// 画面の名前（test-results/ のテストごとのディレクトリと画像のファイル名）から、画像の中身の SHA-256 への対応
export type Screens = Record<string, string>;

// main/<SHA>.json と main/latest.json の中身
export type Manifest = { sha: string; images: Screens };

// 既存のコメントを探す目印。書き換えるのはこれを含む github-actions[bot] のコメントだけ
export const COMMENT_MARKER = '<!-- e2e-evidence -->';

// コメントに画像で並べる画面の上限。残りは名前だけを並べる
export const IMAGE_LIMIT = 20;

// 名前だけを並べる一覧の、1つあたりの上限
export const NAME_LIMIT = 100;

export const LATEST_MANIFEST = 'main/latest.json';

// 同じコミットで撮り直しても画像が変わる画面。そろえられない理由を添え、比べる対象から外す。
// 目印はテストごとのディレクトリの名前（Playwright が付ける。テストのファイルと名前から作られる）
// 一覧は、同じコミットで e2e を2回走らせて違った画面から作った（#337。2026-10-27）。
// e2e/fixtures.ts で時刻、版、描画の揺れはそろえたので、残るのはテストの外から来る違いだけ
export const EXCLUDED_SCREENS: readonly Exclusion[] = [
  {
    pattern: /^(workspace|workspace-close|holiday)-管理者（あおば開発の/,
    reason: '組織の管理の画面は、並べて走るほかのテストが作ったワークスペースの一覧と数を出す',
  },
  {
    pattern: /^members-.*組織のトップへ移る/,
    reason: '組織のトップは、並べて走るほかのテストが作ったワークスペースを並べる',
  },
  {
    pattern: /^history-管理者/,
    reason: '組織の履歴は、並べて走るほかのテストの操作を新しい順に出す',
  },
  {
    pattern: /^invitations-招待だけが届いた人（ヒナタ）-d2986-/,
    reason: '承諾したときに作られる人の ID（実行ごとに変わる）でアバターの色が決まる',
  },
  {
    pattern: /^epic-スクラムの言葉-配下の無いストーリーは完了にでき/,
    reason: 'テストの終わりが、前の操作のトーストが消える時刻と近く、残るトーストの数が変わる',
  },
  {
    pattern:
      /^(task-drawer-矢印キーで難易度を続けて動かしても|task-drawer-期日の保存中に次の値を選んでも|me-自分の設定（ミナト）-390px-の幅では表の|comments-一般のメンバーには、人のコメントの「編集」と「削除」を出さない|organization-look-管理者（くもラボ-301d1-)/,
    reason: 'テストの中の操作が、上の節の読み込みの前か後かで、スクロールの位置が変わる',
  },
];

// 上げる先とコメントに要る、シークレットと変数の名前。値はワークフローが持ち、ここでは有無だけを見る
export const REQUIRED_SETTINGS = [
  'EVIDENCE_R2_ACCESS_KEY_ID',
  'EVIDENCE_R2_SECRET_ACCESS_KEY',
  'EVIDENCE_R2_ENDPOINT',
  'EVIDENCE_R2_BUCKET',
  'EVIDENCE_PUBLIC_URL',
] as const;

// ワークフローは、シークレットを値でなく有無（'true' か 'false'）で、変数を値で <名前> の環境変数に渡す。
// どれかが無ければ、上げずに成功で終えるための理由を返す（人がバケットを用意する前にマージしても CI を赤くしない）
export function missingSettings(env: Record<string, string | undefined>): string[] {
  return REQUIRED_SETTINGS.filter((name) => {
    const value = env[name]?.trim() ?? '';
    return value === '' || value === 'false';
  });
}

// test-results/ からの相対の名前（<テストのディレクトリ>/<画像>）を画面の名前と試行の回数にする。
// 比べるのは e2e/fixtures.ts がテストの終わりに撮る evidence-<n>.png（開いている画面ごとに n が増える）。
// 落ちたテストの test-failed-<n>.png は数えない。再試行のディレクトリは -retry<n> が付くので外す
export function screenKey(relative: string): { key: string; attempt: number } | undefined {
  const parts = relative.split('/');
  if (parts.length !== 2) return undefined;
  const [dir, file] = parts;
  if (!/^evidence-\d+\.png$/.test(file)) return undefined;
  const retry = /^(.+)-retry(\d+)$/.exec(dir);
  return retry ? { key: `${retry[1]}/${file}`, attempt: Number(retry[2]) } : { key: `${dir}/${file}`, attempt: 0 };
}

// 撮った画像の一覧から画面ごとのハッシュを決める。再試行があれば最後の試行の画像を使う
export function collectScreens(files: readonly { path: string; hash: string }[]): Screens {
  const picked = new Map<string, { attempt: number; hash: string }>();
  for (const file of files) {
    const screen = screenKey(file.path);
    if (!screen) continue;
    const current = picked.get(screen.key);
    if (!current || screen.attempt > current.attempt)
      picked.set(screen.key, { attempt: screen.attempt, hash: file.hash });
  }
  return Object.fromEntries([...picked].sort(([a], [b]) => byName(a, b)).map(([key, { hash }]) => [key, hash]));
}

export type Exclusion = { pattern: RegExp; reason: string };

export type Comparison = {
  changed: { key: string; before: string; after: string }[];
  added: { key: string; after: string }[];
  removed: string[];
  excluded: { key: string; reason: string }[];
};

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ベースと head の画面を比べる。外す一覧に当たる画面は、どちらにあっても比べない
export function compareScreens(
  base: Screens,
  head: Screens,
  exclusions: readonly Exclusion[] = EXCLUDED_SCREENS,
): Comparison {
  const result: Comparison = { changed: [], added: [], removed: [], excluded: [] };
  const keys = [...new Set([...Object.keys(base), ...Object.keys(head)])].sort(byName);
  for (const key of keys) {
    const before = base[key];
    const after = head[key];
    const reason = exclusions.find(({ pattern }) => pattern.test(key.split('/')[0]))?.reason;
    if (reason !== undefined) result.excluded.push({ key, reason });
    else if (after === undefined) result.removed.push(key);
    else if (before === undefined) result.added.push({ key, after });
    else if (before !== after) result.changed.push({ key, before, after });
  }
  return result;
}

export function imageObjectKey(prefix: 'main' | 'pr', hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`画像のハッシュの形が違う: ${hash}`);
  return `${prefix}/img/${hash}.png`;
}

export function manifestObjectKey(sha: string): string {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`コミットの SHA の形が違う: ${sha}`);
  return `main/${sha}.json`;
}

// 公開の URL から読んだ一覧を確かめる。形が違えば無いものとして扱う（比べずに、そのことをコメントに書く）
export function parseManifest(value: unknown): Manifest | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { sha, images } = value as Record<string, unknown>;
  if (typeof sha !== 'string' || typeof images !== 'object' || images === null) return undefined;
  const entries = Object.entries(images);
  if (!entries.every(([, hash]) => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash))) return undefined;
  return { sha, images: Object.fromEntries(entries) as Screens };
}

// コメントに画像で出す画面。変わった画面を先に、新しい画面を後に並べ、上限で切る
export function shownScreens(
  comparison: Comparison,
  limit = IMAGE_LIMIT,
): {
  shown: { key: string; before?: string; after: string }[];
  rest: string[];
} {
  const all: { key: string; before?: string; after: string }[] = [...comparison.changed, ...comparison.added];
  return { shown: all.slice(0, limit), rest: all.slice(limit).map(({ key }) => key) };
}

// PR の画像のうち上げるもの。コメントに出す変更後の画像で、ベースの一覧（main/img にある）に無いものだけを、
// ハッシュの重なりを除いて pr/img に上げる
export function prUploads(shown: readonly { after: string }[], base: Screens): string[] {
  const inMain = new Set(Object.values(base));
  return [...new Set(shown.map(({ after }) => after).filter((hash) => !inMain.has(hash)))];
}

// main の画像のうち上げるもの。前の main の一覧に無いハッシュだけ（同じ画像は一度しか上げない）
export function mainUploads(head: Screens, previous: Screens | undefined): string[] {
  const known = new Set(Object.values(previous ?? {}));
  return [...new Set(Object.values(head))].filter((hash) => !known.has(hash)).sort();
}

// 見出し。テストのディレクトリの名前（テストのファイルと名前）に、2枚目からは何枚目かを添える
export function screenTitle(key: string): string {
  const [dir, file] = key.split('/');
  const index = Number(/^evidence-(\d+)\.png$/.exec(file ?? '')?.[1] ?? '1');
  const name = `\`${dir.replaceAll('`', '')}\``;
  return index > 1 ? `${name}（${index}枚目）` : name;
}

export type CommentInput = {
  comparison: Comparison;
  base: Screens;
  publicUrl: string;
  headSha: string;
  baseSha: string;
  // 比べた main の一覧のコミット。ベースの一覧が無く main の最新と比べたときは baseSha と違う
  comparedSha: string | undefined;
  limit?: number;
};

const short = (sha: string) => sha.slice(0, 7);

// PR に付けるコメントの本文
export function commentBody(input: CommentInput): string {
  const { comparison, base, headSha, baseSha, comparedSha } = input;
  const url = input.publicUrl.replace(/\/+$/, '');
  const lines = [COMMENT_MARKER, '## e2e の画面の差分', ''];

  if (comparedSha === undefined) {
    lines.push(
      `ベース（${short(baseSha)}）と main の最新のどちらの画像の一覧も無いので、${short(headSha)} の画面を比べていない。`,
      '`main` に push すると、`evidence-main` が変更前の画像を上げる。',
    );
    return lines.join('\n') + '\n';
  }

  const fellBack = comparedSha !== baseSha;
  const counts = `変わった画面 ${comparison.changed.length}、新しい画面 ${comparison.added.length}、無くなった画面 ${comparison.removed.length}`;
  lines.push(`${short(headSha)} の e2e のスクリーンショットを、${short(comparedSha)} の画像と比べた。${counts}。`);
  if (fellBack) {
    lines.push(
      '',
      `ベース（${short(baseSha)}）の画像がまだ無いので、main の最新（${short(comparedSha)}）と比べた。ベースより後に main に入った変更も差分に出る。`,
    );
  }

  const { shown, rest } = shownScreens(comparison, input.limit);
  if (shown.length === 0) lines.push('', '変わった画面は無い。');
  const inMain = new Set(Object.values(base));
  const image = (hash: string) =>
    `<img src="${url}/${imageObjectKey(inMain.has(hash) ? 'main' : 'pr', hash)}" width="400">`;
  for (const screen of shown) {
    if (screen.before === undefined) {
      lines.push(
        '',
        `### ${screenTitle(screen.key)}（新しい画面）`,
        '',
        '| 変更後 |',
        '| --- |',
        `| ${image(screen.after)} |`,
      );
    } else {
      lines.push(
        '',
        `### ${screenTitle(screen.key)}`,
        '',
        '| 変更前 | 変更後 |',
        '| --- | --- |',
        `| ${image(screen.before)} | ${image(screen.after)} |`,
      );
    }
  }

  // GitHub のコメントは 65536 字までなので、名前の一覧も上限で切る
  const list = (title: string, keys: readonly string[]) => {
    if (keys.length === 0) return;
    lines.push('', '<details>', `<summary>${title}（${keys.length}）</summary>`, '');
    for (const key of keys.slice(0, NAME_LIMIT)) lines.push(`- ${screenTitle(key)}`);
    if (keys.length > NAME_LIMIT) lines.push(`- ほか ${keys.length - NAME_LIMIT} 画面`);
    lines.push('', '</details>');
  };
  list(`${input.limit ?? IMAGE_LIMIT} 画面を超えて画像を出さなかった画面`, rest);
  list('無くなった画面', comparison.removed);
  if (comparison.excluded.length > 0) {
    lines.push('', '<details>', `<summary>比べる対象から外した画面（${comparison.excluded.length}）</summary>`, '');
    for (const { key, reason } of comparison.excluded) lines.push(`- ${screenTitle(key)}: ${reason}`);
    lines.push('', '</details>');
  }
  return lines.join('\n') + '\n';
}

// ダウンロードした成果物の下の test-results/ を探し、PNG のハッシュを読む。
// 成果物はシャードごとに <root>/e2e-<n>/test-results/ に入る。
// path は test-results/ からの相対、local は手元のパス（上げるときに読む）
export function readScreenFiles(root: string): { path: string; local: string; hash: string }[] {
  const files: { path: string; local: string; hash: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (entry.name !== 'test-results') {
        walk(path);
        continue;
      }
      for (const test of readdirSync(path, { withFileTypes: true })) {
        if (!test.isDirectory()) continue;
        for (const file of readdirSync(join(path, test.name))) {
          if (!file.endsWith('.png')) continue;
          const local = join(path, test.name, file);
          const hash = createHash('sha256').update(readFileSync(local)).digest('hex');
          files.push({ path: `${test.name}/${file}`, local, hash });
        }
      }
    }
  };
  walk(root);
  return files;
}

// 上げる画像の、ハッシュから手元のパスへの対応
export function localFiles(files: readonly { local: string; hash: string }[]): Map<string, string> {
  const byHash = new Map<string, string>();
  for (const { local, hash } of files) if (!byHash.has(hash)) byHash.set(hash, local);
  return byHash;
}

// 上げる一覧を、ワークフローの段が読む「手元のパス<TAB>上げる先の名前」の行にする
export function uploadLines(hashes: readonly string[], prefix: 'main' | 'pr', locals: Map<string, string>): string {
  return hashes
    .map((hash) => {
      const local = locals.get(hash);
      if (local === undefined) throw new Error(`上げる画像が手元に無い: ${hash}`);
      return `${local}\t${imageObjectKey(prefix, hash)}\n`;
    })
    .join('');
}

// 公開の URL から一覧を読む。無い（404）か形が違えば undefined。ほかの失敗は投げる（比べずに進めると、全部を新しい画面として出すため）
export async function fetchManifest(
  publicUrl: string,
  objectKey: string,
  fetcher: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> = fetch,
): Promise<Manifest | undefined> {
  const res = await fetcher(`${publicUrl.replace(/\/+$/, '')}/${objectKey}`);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`${objectKey} を読めない（${res.status}）`);
  return parseManifest(await res.json().catch(() => undefined));
}

// 以下はワークフローから動かす scripts/evidence-*.ts が使う

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`環境変数 ${name} が無い`);
  return value;
}

// ジョブの出力（name=value）を書く。標準出力は注記（ワークフローのコマンド）と記録に使うので、GITHUB_OUTPUT のファイルに直に書く
export function writeOutput(name: string, value: string | boolean): void {
  const line = `${name}=${value}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  else process.stdout.write(line);
}
