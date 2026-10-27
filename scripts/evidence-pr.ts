// CI の evidence のジョブ: 成果物 e2e-* の画像をベースの main の画像と比べ、上げる画像の一覧とコメントの本文を書く。
// 環境変数: RESULTS_DIR（成果物を落とした所）、OUT_DIR（書き出す所）、EVIDENCE_PUBLIC_URL、BASE_SHA、HEAD_SHA。
// 書き出すもの: OUT_DIR/uploads.tsv（手元のパス<TAB>上げる先の名前）、OUT_DIR/comment.md。
// ジョブの出力 post=（コメントが無ければ新しく付けるか）を書く。変わった画面が無いときは付けず、既にあれば書き換える。
// 変更前の一覧が無くて比べられないときは、そのことを知らせるために付ける
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  collectScreens,
  commentBody,
  compareScreens,
  fetchManifest,
  LATEST_MANIFEST,
  localFiles,
  manifestObjectKey,
  prUploads,
  readScreenFiles,
  requiredEnv,
  shownScreens,
  uploadLines,
  writeOutput,
} from './evidence.ts';

const resultsDir = requiredEnv('RESULTS_DIR');
const outDir = requiredEnv('OUT_DIR');
const publicUrl = requiredEnv('EVIDENCE_PUBLIC_URL');
const baseSha = requiredEnv('BASE_SHA');
const headSha = requiredEnv('HEAD_SHA');

const files = readScreenFiles(resultsDir);
const head = collectScreens(files);
if (Object.keys(head).length === 0) throw new Error(`${resultsDir} にスクリーンショットが無い`);

const base =
  (await fetchManifest(publicUrl, manifestObjectKey(baseSha))) ?? (await fetchManifest(publicUrl, LATEST_MANIFEST));
const baseScreens = base?.images ?? {};
const comparison = compareScreens(baseScreens, head);
const { shown } = shownScreens(comparison);
const uploads = base ? prUploads(shown, baseScreens) : [];

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'uploads.tsv'), uploadLines(uploads, 'pr', localFiles(files)));
writeFileSync(
  join(outDir, 'comment.md'),
  commentBody({ comparison, base: baseScreens, publicUrl, headSha, baseSha, comparedSha: base?.sha }),
);

console.log(
  `比べた一覧: ${base ? base.sha : '無し'}。画面 ${Object.keys(head).length}、変わった ${comparison.changed.length}、新しい ${comparison.added.length}、無くなった ${comparison.removed.length}、外した ${comparison.excluded.length}、上げる画像 ${uploads.length}`,
);
writeOutput('post', base === undefined || shown.length > 0 || comparison.removed.length > 0);
