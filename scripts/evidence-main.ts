// evidence-main のワークフロー: main の e2e の画像の一覧を作り、前の main（main/latest.json）に無い画像だけを上げる一覧を書く。
// 環境変数: RESULTS_DIR（成果物を落とした所）、OUT_DIR（書き出す所）、EVIDENCE_PUBLIC_URL、SHA（main のコミット）。
// 書き出すもの: OUT_DIR/uploads.tsv（手元のパス<TAB>上げる先の名前）、OUT_DIR/manifest.json（main/<SHA>.json と main/latest.json の中身）
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  collectScreens,
  fetchManifest,
  LATEST_MANIFEST,
  localFiles,
  mainUploads,
  manifestObjectKey,
  readScreenFiles,
  requiredEnv,
  uploadLines,
  type Manifest,
} from './evidence.ts';

const resultsDir = requiredEnv('RESULTS_DIR');
const outDir = requiredEnv('OUT_DIR');
const publicUrl = requiredEnv('EVIDENCE_PUBLIC_URL');
const sha = requiredEnv('SHA');
// 名前の形を先に確かめる（上げる段は main/<SHA>.json に置く）
manifestObjectKey(sha);

const files = readScreenFiles(resultsDir);
const images = collectScreens(files);
if (Object.keys(images).length === 0) throw new Error(`${resultsDir} にスクリーンショットが無い`);

const previous = await fetchManifest(publicUrl, LATEST_MANIFEST);
const uploads = mainUploads(images, previous?.images);
const manifest: Manifest = { sha, images };

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'uploads.tsv'), uploadLines(uploads, 'main', localFiles(files)));
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(
  `前の main: ${previous ? previous.sha : '無し'}。画面 ${Object.keys(images).length}、上げる画像 ${uploads.length}`,
);
