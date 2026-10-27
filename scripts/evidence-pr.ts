// CI の evidence のジョブ: 成果物 e2e-<n>（e2e-dev-<n> は含めない）の画像をベースの main の画像と比べ、上げる画像の一覧とコメントの本文を書く。
// 環境変数: RESULTS_DIR（成果物を落とした所）、OUT_DIR（書き出す所）、EVIDENCE_MAIN_PUBLIC_URL（変更前の画像と一覧）、
// EVIDENCE_PR_PUBLIC_URL（PR にしか無い画像）、BASE_SHA、HEAD_SHA。
// 書き出すもの: OUT_DIR/upload/（上げる画像を PR 用のバケットの中の名前どおりに並べたもの）、OUT_DIR/comment.md。
// ジョブの出力 post=（コメントが無ければ新しく付けるか。scripts/evidence.ts の shouldPost）を書く
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  collectScreens,
  commentBody,
  compareScreens,
  loadBaseManifest,
  localFiles,
  notice,
  prUploads,
  readScreenFiles,
  requiredEnv,
  shouldPost,
  shownScreens,
  stageUploads,
  unusedExclusions,
  writeOutput,
} from './evidence.ts';

const resultsDir = requiredEnv('RESULTS_DIR');
const outDir = requiredEnv('OUT_DIR');
const mainUrl = requiredEnv('EVIDENCE_MAIN_PUBLIC_URL');
const prUrl = requiredEnv('EVIDENCE_PR_PUBLIC_URL');
const baseSha = requiredEnv('BASE_SHA');
const headSha = requiredEnv('HEAD_SHA');

const files = readScreenFiles(resultsDir);
const head = collectScreens(files);
if (Object.keys(head).length === 0) throw new Error(`${resultsDir} にスクリーンショットが無い`);

const { manifest: base, problem } = await loadBaseManifest(mainUrl, baseSha);
if (problem !== undefined) notice('変更前の画像の一覧を読めない', `${problem}。比べずに、そのことをコメントに書く`);
const baseScreens = base?.images ?? {};
const comparison = compareScreens(baseScreens, head);
const { shown } = shownScreens(comparison);
const uploads = base ? prUploads(shown, baseScreens) : [];
const unused = unusedExclusions(Object.keys(head));
if (unused.length > 0) {
  notice('当たらない除外', unused.map(({ pattern }) => pattern.source).join(' / '));
}

mkdirSync(outDir, { recursive: true });
stageUploads(uploads, 'pr', localFiles(files), join(outDir, 'upload'));
writeFileSync(
  join(outDir, 'comment.md'),
  commentBody({
    comparison,
    base: baseScreens,
    mainUrl,
    prUrl,
    headSha,
    baseSha,
    comparedSha: base?.sha,
    problem,
    unused,
  }),
);

console.log(
  `比べた一覧: ${base ? base.sha : '無し'}。画面 ${Object.keys(head).length}、変わった ${comparison.changed.length}、新しい ${comparison.added.length}、無くなった ${comparison.removed.length}、外した ${comparison.excluded.length}、上げる画像 ${uploads.length}`,
);
writeOutput('post', shouldPost(comparison, base !== undefined));
