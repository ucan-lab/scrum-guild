// e2e のスクリーンショットを PR に並べる処理（docs/development.md の「e2e の画像のコメント」の evidence と evidence-main）。
// 比べる、上げる先の名前を決める、コメントの本文を組むところをここに置き、node --test にかける。
// R2 への送信とコメントの書き換えはワークフローの段が行う
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

// 画面の名前（test-results/ のテストごとのディレクトリと画像のファイル名）から、画像の中身の SHA-256 への対応
export type Screens = Record<string, string>;

// main 用のバケットの main/<SHA>.json と main/latest.json の中身
export type Manifest = { sha: string; images: Screens };

// 画像を置くバケット。main 用（一覧と main の画像。鍵は Environment の evidence-main にだけある）と、
// PR 用（PR にしか無い画像。鍵はリポジトリのシークレットで、PR の head のコードから取れる）を分ける
export type Bucket = 'main' | 'pr';

// 既存のコメントを探す目印。書き換えるのはこれを含む github-actions[bot] のコメントだけ。
// .github/workflows/ci.yml と .claude/skills/pr-create/evidence.md にも同じ文字列を書く（scripts/evidence.test.ts が確かめる）
export const COMMENT_MARKER = '<!-- e2e-evidence -->';

// 目印の次の行に置く、セッションが読む JSON の前置き。PR の本文のエビデンス節に画像を埋め込むときに読む
// （.claude/skills/pr-create/evidence.md にも同じ文字列を書く。scripts/evidence.test.ts が確かめる）
export const DATA_MARKER = '<!-- e2e-evidence-data ';

// コメントに画像で並べる画面の上限。残りは名前だけを並べる
export const IMAGE_LIMIT = 20;

// 名前だけを並べる一覧の、1つあたりの上限（GitHub のコメントは 65536 字まで）
export const NAME_LIMIT = 100;

export const LATEST_MANIFEST = 'main/latest.json';

// 公開の URL から一覧を読むときの上限
export const FETCH_TIMEOUT_MS = 10_000;

// R2 に送る先の名前の形。stageUploads はこの名前どおりにディレクトリへ写し、
// ワークフローの送る段はディレクトリの中の名前を同じ形で確かめ、外れたら送らずに止める
export const UPLOAD_KEY = /^(main\/)?img\/[0-9a-f]{64}\.png$/;

const HASH = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
// テストのディレクトリの名前。Playwright がテストのファイルと名前から作る。制御文字（改行、タブを含む）と / を含むものは扱わない
const TEST_DIR = /^[^/\p{Cc}]+$/u;
const IMAGE_FILE = /^evidence-(\d+)\.png$/;

export type Exclusion = { pattern: RegExp; reason: string };

const CROWDED_ADMIN = '組織の管理の画面は、並べて走るほかのテストが作ったワークスペースの一覧と数を出す';
const SCROLL = 'テストの中の操作が、上の節の読み込みの前か後かで、スクロールの位置が変わる';

// 同じコミットで撮り直しても画像が変わる画面。そろえられない理由を添え、比べる対象から外す。
// 目印はテストごとのディレクトリの名前で、1つのテストだけに当てる（describe の単位で外さない）。
// 一覧は、同じコミットで e2e を2回ずつ4回走らせて違った画面から作り（#337。2026-10-27）、
// その後は画面を変えない PR に出た画面のうち、そろえられないものを足している（#354）。
// e2e/fixtures.ts で時刻、版、描画の揺れはそろえたので、残るのはテストの外から来る違いだけ。
// どのテストにも当たらなくなった項目は、evidence のコメントと注記に「当たらない除外」として出る
export const EXCLUDED_SCREENS: readonly Exclusion[] = [
  ...[
    '-056aa-知らせ、「もう一度試す」で読み直せる。ほかの部分は出る-',
    '-26b45-る。別の画面で先に終了されていたら、読み直して知らせる-',
    '-325f9--になったら、状態が変わっていたことを知らせて読み直す-',
    '-41529-受けたら、理由を出してダイアログを閉じ、一覧を読み直す-',
    '-46fae-、一覧を残したまま知らせ、「もう一度試す」で読み直せる-',
    '-66847-前でも、確認の見出しとトーストは折り返してはみ出さない-',
    '-69546-込みの結果では、「まだ読み込めませんでした」を出さない-',
    '-ba220-中は、空の読み上げの領域を先に描き、後から文字を入れる-',
    '-c1b83-直しが後で返っても、新しい一覧を古い一覧で上書きしない-',
    '-cac75-しても無視し、ダイアログも閉じられず、1回しか送らない-',
    'ミナト）-390px-の幅でも、操作の列は右端に固定されて見える-',
  ].map((part) => ({ pattern: exactTest('workspace-close-管理者（あおば開発の', part), reason: CROWDED_ADMIN })),
  ...[
    '-サ-02a1b-、送り終えて欄が戻った後に、名前の欄へフォーカスを戻す-',
    '-ブラウザのタイムゾーンが断られたら、直せない理由を伝える-',
    '-候-48501-もう一度試す」は読み直している間も残り、直ったら作れる-',
    '-候補を読み込めないときの欄は、理由の文を二重に出さない-',
    '-別-89686-中の言葉づかいがスクラムになり、所属していない印が出る-',
    '-名前が空か51字以上だと、送らずに知らせる-',
    '-選-cdecc-て-404-になったら、選び直しを促し、候補を取り直す-',
    '-組-364e6-ワークスペースの一覧を出し、メニューに組織の管理が入る-',
    '-自分をリーダーに、ゲームの言葉で作ると、そのワークスペースの画面へ移る-',
  ].map((part) => ({ pattern: exactTest('workspace-管理者（あおば開発のミナト）', part), reason: CROWDED_ADMIN })),
  ...[
    '-登録できる行が上限の-100-を超えたら送らず、分けて登録するよう出す-',
    '-登録できる行が無ければ送らず、理由を出す-',
    '-送って-c36c4-ly-にし、送れた後に残す行は押した時点の内容から作る-',
  ].map((part) => ({ pattern: exactTest('holiday-管理者（あおば開発のミナト）', part), reason: CROWDED_ADMIN })),
  { pattern: exactTest('a11y-screens', '-admin（-aoba-admin）に-axe-の違反が無い-'), reason: CROWDED_ADMIN },
  {
    pattern: exactTest(
      'history-管理者（あおば開発のミナト）',
      '-「古い-6b3a2-ろに足し、最後まで読んだら終わりの文へフォーカスを移す-',
    ),
    reason:
      '組織の管理の画面の上の節に、並べて走るほかのテストが作ったワークスペースが並び、終わりの文へフォーカスを移したときのスクロールの位置が変わる',
  },
  {
    // 押したときのスクロールの後に上の節が伸び、変更の履歴の節が 65px ほど下にずれた画像が、PR のコメントに5通り出た（#413）
    pattern: exactTest(
      'history-管理者（あおば開発のミナト）',
      '-続きを読めなかったら、読めた行を残したまま理由を出し、もう一度押すと読める-',
    ),
    reason:
      '組織の管理の画面の上の節に、並べて走るほかのテストが作ったワークスペースが並び、「古い履歴を読む」を押した後のスクロールの位置が変わる',
  },
  {
    // 押す前に読み込みを待っても、CI では後ろのバックログの行とスクロールの位置が main と違った（#354）
    pattern: exactTest(
      'story',
      '-親のストーリーが消えていたら、理由を出し、その場で候補を読み直して親なしに戻し、親の選択欄にフォーカスを移す-',
    ),
    reason:
      'ダイアログの後ろの seed のバックログに、並べて走るほかのテストが足した行が並び、押すボタンの位置とスクロールの位置が変わる',
  },
  {
    // seed を入れ直して単独で12回撮ると同じ画像になった（#354）
    pattern: exactTest(
      'comments',
      '-リーダーは人のコメントを消せるが直せず、直している途中に消されたら書きかけを残して知らせる-',
    ),
    reason:
      '並べて走るほかのテストと同じシャードのときだけ、引き出しの「系統なし」の選択欄の文字が 1px 上下する。単独では揺れず、テストの側でそろえる手がかりが無い',
  },
  {
    pattern: exactTest(
      'members-リーダー（あおば開発のミナト）',
      '-自分-fff02-一般に戻してリーダーに戻し、抜けると組織のトップへ移る-',
    ),
    reason: '組織のトップは、並べて走るほかのテストが作ったワークスペースを並べる',
  },
  ...[
    '-320px-の幅でも、節は横にはみ出さず、行を縦に積む-',
    '-see-190fe-で出る。運用者は「運用者」とだけ出て、所属の行は出ない-',
  ].map((part) => ({
    pattern: exactTest('history-管理者（あおば開発のミナト）', part),
    reason: '組織の履歴は、並べて走るほかのテストの操作を新しい順に出す',
  })),
  {
    pattern: exactTest(
      'invitations-招待だけが届いた人（ヒナタ）',
      '-d2986-が出て、招待の画面で承諾するとそのワークスペースに入る-',
    ),
    reason: '承諾したときに作られる人の ID（実行ごとに変わる）でアバターの色が決まる',
  },
  ...[
    exactTest(
      'epic-スクラムの言葉',
      '-配下の無いストーリーは完了にでき、断られたら理由を知らせて読み直す。狭い幅でもはみ出さない-',
    ),
    exactTest('task', '-完了の操作を送っている間は、押せない印と読み上げを出し、応答が来たら完了の印に替わる-'),
  ].map((pattern) => ({
    pattern,
    reason: 'テストの終わりが、前の操作のトーストが消える時刻と近く、残るトーストの数か位置が変わる',
  })),
  ...[
    exactTest('task-drawer', '-矢印キーで難易度を続けて動かしても、保存は1本ずつで、最後の選択が残る-'),
    // 後始末でコメントを消しても揺れが残った（#337）
    exactTest('comments', '-一般のメンバーには、人のコメントの「編集」と「削除」を出さない-'),
  ].map((pattern) => ({
    pattern,
    reason:
      'テストの終わりが、引き出しの担い手とリポジトリの候補を読み終える時刻と近く、「読み込んでいます」が残るかが変わる',
  })),
  {
    pattern: exactTest(
      'task-drawer',
      '-期日の保存中に次の値を選んでも、先の応答で入力欄が上書きされず、次の値が送られる-',
    ),
    reason: SCROLL,
  },
  {
    pattern: exactTest(
      'me-自分の設定（ミナト）',
      '-390px-の幅では表の-d511f-の値が見え、明細の表とレベルの面が画面からはみ出さない-',
    ),
    reason: SCROLL,
  },
  {
    pattern: exactTest('organization-look-管理者（くもラボ', '-301d1-押し直せ、409-と-403-は読み直して今の値に戻す-'),
    reason: SCROLL,
  },
];

// テストのディレクトリの名前（<前置き><テストの名前の部分>chromium）の1つだけに当たる正規表現にする
function exactTest(prefix: string, part: string): RegExp {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escape(prefix)}${escape(part)}chromium$`);
}

// ワークフローが渡す、シークレットの有無（'true' か 'false'）と変数の値の名前。PR のジョブは PR 用、main のジョブは main 用を見る。
// PR のジョブは、変更前の画像と一覧を main 用の公開の URL から読むので、その変数も要る
export const REQUIRED_SETTINGS: Record<Bucket, readonly string[]> = {
  pr: [
    'EVIDENCE_PR_R2_ACCESS_KEY_ID',
    'EVIDENCE_PR_R2_SECRET_ACCESS_KEY',
    'EVIDENCE_R2_ENDPOINT',
    'EVIDENCE_PR_BUCKET',
    'EVIDENCE_PR_PUBLIC_URL',
    'EVIDENCE_MAIN_PUBLIC_URL',
  ],
  main: [
    'EVIDENCE_MAIN_R2_ACCESS_KEY_ID',
    'EVIDENCE_MAIN_R2_SECRET_ACCESS_KEY',
    'EVIDENCE_R2_ENDPOINT',
    'EVIDENCE_MAIN_BUCKET',
    'EVIDENCE_MAIN_PUBLIC_URL',
  ],
};

// どれかが無ければ、上げずに成功で終えるための名前を返す（人がバケットを用意する前にマージしても CI を赤くしない）
export function missingSettings(env: Record<string, string | undefined>, bucket: Bucket): string[] {
  return REQUIRED_SETTINGS[bucket].filter((name) => {
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
  if (!TEST_DIR.test(dir) || !IMAGE_FILE.test(file)) return undefined;
  const retry = /^(.+)-retry(\d+)$/.exec(dir);
  return retry ? { key: `${retry[1]}/${file}`, attempt: Number(retry[2]) } : { key: `${dir}/${file}`, attempt: 0 };
}

// 一覧のキーとして受け付ける形（screenKey が作る形）
export function isScreenKey(key: string): boolean {
  return screenKey(key)?.key === key;
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

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

export function excludedReason(key: string, exclusions: readonly Exclusion[] = EXCLUDED_SCREENS): string | undefined {
  return exclusions.find(({ pattern }) => pattern.test(key.split('/')[0]))?.reason;
}

// 外す一覧に当たる画面を除く。main の一覧と上げる画像には、外した画面を入れない
export function withoutExcluded(screens: Screens, exclusions: readonly Exclusion[] = EXCLUDED_SCREENS): Screens {
  return Object.fromEntries(Object.entries(screens).filter(([key]) => excludedReason(key, exclusions) === undefined));
}

// どの画面にも当たらない除外（テストの名前を変えたか消した後に残ったもの）
export function unusedExclusions(
  keys: Iterable<string>,
  exclusions: readonly Exclusion[] = EXCLUDED_SCREENS,
): Exclusion[] {
  const dirs = [...keys].map((key) => key.split('/')[0]);
  return exclusions.filter(({ pattern }) => !dirs.some((dir) => pattern.test(dir)));
}

export type Comparison = {
  changed: { key: string; before: string; after: string }[];
  added: { key: string; after: string }[];
  removed: string[];
  excluded: { key: string; reason: string }[];
};

// ベースと head の画面を比べる。外す一覧に当たる画面は、どちらにあっても比べない
export function compareScreens(
  base: Screens,
  head: Screens,
  exclusions: readonly Exclusion[] = EXCLUDED_SCREENS,
): Comparison {
  const result: Comparison = { changed: [], added: [], removed: [], excluded: [] };
  const keys = [...new Set([...Object.keys(base), ...Object.keys(head)])].sort(byName);
  for (const key of keys) {
    const before = Object.hasOwn(base, key) ? base[key] : undefined;
    const after = Object.hasOwn(head, key) ? head[key] : undefined;
    const reason = excludedReason(key, exclusions);
    if (reason !== undefined) result.excluded.push({ key, reason });
    else if (after === undefined) result.removed.push(key);
    else if (before === undefined) result.added.push({ key, after });
    else if (before !== after) result.changed.push({ key, before, after });
  }
  return result;
}

// バケットの中の画像の名前。main 用は main/img/<ハッシュ>.png、PR 用は img/<ハッシュ>.png
export function imageObjectKey(bucket: Bucket, hash: string): string {
  if (!HASH.test(hash)) throw new Error(`画像のハッシュの形が違う: ${hash}`);
  return bucket === 'main' ? `main/img/${hash}.png` : `img/${hash}.png`;
}

export function manifestObjectKey(sha: string): string {
  if (!SHA.test(sha)) throw new Error(`コミットの SHA の形が違う: ${sha}`);
  return `main/${sha}.json`;
}

// 公開の URL から読んだ一覧を確かめる。SHA、画面の名前、ハッシュのどれかの形が違えば、一覧ごと無いものとして扱う
export function parseManifest(value: unknown): Manifest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { sha, images } = value as Record<string, unknown>;
  if (typeof sha !== 'string' || !SHA.test(sha)) return undefined;
  if (typeof images !== 'object' || images === null || Array.isArray(images)) return undefined;
  const entries = Object.entries(images);
  if (!entries.every(([key, hash]) => isScreenKey(key) && typeof hash === 'string' && HASH.test(hash)))
    return undefined;
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

// コメントが無いときに新しく付けるか。変わった画面、新しい画面、無くなった画面のどれかがあるか、比べられなかったときに付ける。
// 既にあるコメントは、付けないときも書き換える（前の push の画像を残さない）
export function shouldPost(comparison: Comparison, compared: boolean): boolean {
  return !compared || comparison.changed.length + comparison.added.length + comparison.removed.length > 0;
}

// PR の画像のうち上げるもの。コメントに出す変更後の画像で、ベースの一覧（main 用のバケットにある）に無いものだけを、
// ハッシュの重なりを除いて PR 用のバケットに上げる
export function prUploads(shown: readonly { after: string }[], base: Screens): string[] {
  const inMain = new Set(Object.values(base));
  return [...new Set(shown.map(({ after }) => after).filter((hash) => !inMain.has(hash)))];
}

// main の画像のうち上げるもの。前の main の一覧に無いハッシュだけ（同じ画像は一度しか上げない）
export function mainUploads(head: Screens, previous: Screens | undefined): string[] {
  const known = new Set(Object.values(previous ?? {}));
  return [...new Set(Object.values(head))].filter((hash) => !known.has(hash)).sort();
}

// 見出し。テストのディレクトリの名前（テストのファイルと名前）に、2枚目からは何枚目かを添える。
// Markdown を崩さないよう、バッククォートと制御文字（改行を含む）は落とす
export function screenTitle(key: string): string {
  const [dir, file] = key.split('/');
  const index = Number(IMAGE_FILE.exec(file ?? '')?.[1] ?? '1');
  const name = `\`${dir.replace(/[`\p{Cc}]/gu, '')}\``;
  return index > 1 ? `${name}（${index}枚目）` : name;
}

export type CommentInput = {
  comparison: Comparison;
  base: Screens;
  // 変更前の画像（main 用のバケット）と、PR にしか無い画像（PR 用のバケット）の公開の URL
  mainUrl: string;
  prUrl: string;
  headSha: string;
  baseSha: string;
  // 比べた main の一覧のコミット。ベースの一覧が無く main の最新と比べたときは baseSha と違う。比べられなければ undefined
  comparedSha: string | undefined;
  // 一覧を読めなかった理由（404 のほかの失敗）
  problem?: string;
  // どの画面にも当たらない除外
  unused?: readonly Exclusion[];
  limit?: number;
};

const short = (sha: string) => sha.slice(0, 7);
const trimUrl = (url: string) => url.replace(/\/+$/, '');

// セッションが読む JSON。画面は画像で並べる画面（shownScreens の shown）と同じで、URL も表の画像と同じ。
// 比べられなかったときは screens を空にする
export type EvidenceData = {
  headSha: string;
  comparedSha: string | null;
  screens: { key: string; before?: string; after: string }[];
};

export function evidenceData(input: CommentInput): EvidenceData {
  const { headSha, comparedSha } = input;
  if (comparedSha === undefined) return { headSha, comparedSha: null, screens: [] };
  const url = imageUrl(input);
  const { shown } = shownScreens(input.comparison, input.limit);
  return {
    headSha,
    comparedSha,
    screens: shown.map(({ key, before, after }) => ({
      key,
      ...(before !== undefined && { before: url(before) }),
      after: url(after),
    })),
  };
}

// 1行の HTML コメントにする。JSON.stringify が改行と制御文字を逃がし、> を逃がして --> を作らない
function dataLine(data: EvidenceData): string {
  return `${DATA_MARKER}${JSON.stringify(data).replace(/>/g, '\\u003e')} -->`;
}

// 画像の公開の URL。ベースの一覧にある画像は main 用のバケット、無い画像は PR 用のバケットを指す
function imageUrl(input: CommentInput): (hash: string) => string {
  const inMain = new Set(Object.values(input.base));
  return (hash) => {
    const bucket: Bucket = inMain.has(hash) ? 'main' : 'pr';
    return `${trimUrl(bucket === 'main' ? input.mainUrl : input.prUrl)}/${imageObjectKey(bucket, hash)}`;
  };
}

// PR に付けるコメントの本文
export function commentBody(input: CommentInput): string {
  const { comparison, headSha, baseSha, comparedSha } = input;
  const lines = [COMMENT_MARKER, dataLine(evidenceData(input)), '## e2e の画面の差分', ''];
  // CI の e2e は、PR の head をベースにマージした状態（refs/pull/<番号>/merge）を撮る
  const subject = `${short(headSha)} をベース（${short(baseSha)}）にマージした状態の e2e のスクリーンショット`;

  if (comparedSha === undefined) {
    if (input.problem !== undefined) {
      lines.push(`変更前の画像の一覧を読めなかった（${input.problem}）ので、${subject}を比べていない。`);
    } else {
      lines.push(
        `ベース（${short(baseSha)}）と main の最新のどちらの画像の一覧も無いので、${subject}を比べていない。`,
        '`main` に push すると、`evidence-main` が変更前の画像を上げる。',
      );
    }
    pushUnused(lines, input.unused);
    return lines.join('\n') + '\n';
  }

  const counts = `変わった画面 ${comparison.changed.length}、新しい画面 ${comparison.added.length}、無くなった画面 ${comparison.removed.length}`;
  lines.push(`${subject}を、main の ${short(comparedSha)} の画像と比べた。${counts}。`);
  if (comparedSha !== baseSha) {
    lines.push(
      '',
      `ベース（${short(baseSha)}）の画像がまだ無いので、main の最新（${short(comparedSha)}）と比べた。ベースより後に main に入った変更も差分に出る。`,
    );
  }

  const { shown, rest } = shownScreens(comparison, input.limit);
  if (shown.length === 0) lines.push('', '変わった画面と新しい画面は無い。');
  const url = imageUrl(input);
  const image = (hash: string) => `<img src="${url(hash)}" width="400">`;
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

  pushList(
    lines,
    `${input.limit ?? IMAGE_LIMIT} 画面を超えて画像を出さなかった画面`,
    rest.map((key) => `- ${screenTitle(key)}`),
  );
  pushList(
    lines,
    '無くなった画面',
    comparison.removed.map((key) => `- ${screenTitle(key)}`),
  );
  pushList(
    lines,
    '比べる対象から外した画面',
    comparison.excluded.map(({ key, reason }) => `- ${screenTitle(key)}: ${reason}`),
  );
  pushUnused(lines, input.unused);
  return lines.join('\n') + '\n';
}

// 名前の一覧を畳んで出す。上限を超えた分は数だけを書く
function pushList(lines: string[], title: string, items: readonly string[]): void {
  if (items.length === 0) return;
  lines.push('', '<details>', `<summary>${title}（${items.length}）</summary>`, '', ...items.slice(0, NAME_LIMIT));
  if (items.length > NAME_LIMIT) lines.push(`- ほか ${items.length - NAME_LIMIT} 画面`);
  lines.push('', '</details>');
}

function pushUnused(lines: string[], unused: readonly Exclusion[] | undefined): void {
  if (!unused?.length) return;
  lines.push(
    '',
    `どの画面にも当たらない除外が ${unused.length} 件ある。テストの名前を変えたか消したなら、\`scripts/evidence.ts\` の \`EXCLUDED_SCREENS\` から外す。`,
  );
  pushList(
    lines,
    '当たらない除外',
    unused.map(({ pattern }) => `- \`${pattern.source.replace(/[`\p{Cc}]/gu, '')}\``),
  );
}

// ダウンロードした成果物の下の test-results/ を探し、PNG のハッシュを読む。
// 成果物はシャードごとに <root>/e2e-<n>/test-results/ に入る。
// path は test-results/ からの相対、local は手元のパス（上げるときに読む）。
// 名前に制御文字を含むテストのディレクトリは読まない（上げる一覧の行が崩れないように）。
// PNG のシグネチャで始まらないファイルと MAX_IMAGE_BYTES より大きいファイルも読まない。
// e2e/ は needs-human に当たらないので、テストが置いた任意のファイルを公開のバケットに上げさせないため
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
        if (!test.isDirectory() || !TEST_DIR.test(test.name)) continue;
        for (const file of readdirSync(join(path, test.name))) {
          if (!IMAGE_FILE.test(file)) continue;
          const local = join(path, test.name, file);
          if (statSync(local).size > MAX_IMAGE_BYTES) continue;
          const content = readFileSync(local);
          if (!content.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) continue;
          const hash = createHash('sha256').update(content).digest('hex');
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

// 上げる画像を、dir の下に上げる先の名前どおりに写す。ワークフローの段は dir を aws s3 cp --recursive の1回で送る。
// dir に前からあったものは消してから写す（--recursive は dir の中をすべて送るため）。
// 画像が無くても dir は作る。写した枚数を返す
export function stageUploads(
  hashes: readonly string[],
  bucket: Bucket,
  locals: Map<string, string>,
  dir: string,
): number {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let count = 0;
  for (const hash of new Set(hashes)) {
    const local = locals.get(hash);
    if (local === undefined) throw new Error(`上げる画像が手元に無い: ${hash}`);
    // readScreenFiles が制御文字のあるテストのディレクトリを読まないので、ここに来るのはその守りが崩れたときだけ。
    // 公開のバケットに送るものの出どころなので、深い守りとして止める
    if (/\p{Cc}/u.test(local)) throw new Error(`上げる画像のパスに制御文字がある: ${JSON.stringify(local)}`);
    const dest = join(dir, imageObjectKey(bucket, hash));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(local, dest);
    count += 1;
  }
  return count;
}

export type Fetcher = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// 公開の URL から一覧を読む。無い（404）か形が違えば undefined。ほかの失敗（時間切れを含む）は投げる
export async function fetchManifest(
  publicUrl: string,
  objectKey: string,
  fetcher: Fetcher = fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Manifest | undefined> {
  const res = await fetcher(`${trimUrl(publicUrl)}/${objectKey}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`${objectKey} を読めない（${res.status}）`);
  return parseManifest(await res.json().catch(() => undefined));
}

// PR が比べる一覧を読む。ベースのコミットの一覧が無ければ main の最新を読む。
// 404 のほかの失敗は、ジョブを落とさずに理由を返す（evidence は助言なので赤くしない。比べられなかったとコメントに書く）
export async function loadBaseManifest(
  mainUrl: string,
  baseSha: string,
  fetcher: Fetcher = fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<{ manifest?: Manifest; problem?: string }> {
  try {
    const manifest =
      (await fetchManifest(mainUrl, manifestObjectKey(baseSha), fetcher, timeoutMs)) ??
      (await fetchManifest(mainUrl, LATEST_MANIFEST, fetcher, timeoutMs));
    return manifest ? { manifest } : {};
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
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

// ジョブの注記。改行と制御文字はワークフローのコマンドを崩すので空白にする
export function notice(title: string, message: string): void {
  const clean = (text: string) => text.replace(/\p{Cc}+/gu, ' ');
  console.log(`::notice title=${clean(title)}::${clean(message)}`);
}
