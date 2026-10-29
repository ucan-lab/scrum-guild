// CI の changes のジョブ: 標準入力で受けた変わったファイルの一覧（git diff --name-only -z の NUL 区切り）から、
// 文書だけかと、開発モードの e2e（e2e-dev）を走らせるかを GITHUB_OUTPUT の形で出す。
// 引数に --repeat を付けたときは、標準入力を足したか変えたファイルの一覧（--diff-filter=AM）とみて、
// e2e-repeat を走らせるかと、繰り返すテストのファイル（空白区切り）を出す。件数の上限は e2e-repeat が見る。
// 繰り返しに耐えないファイル（REPEAT_EXCLUDED）は外し、外したことを標準エラーの注記に出す（標準出力は GITHUB_OUTPUT に足す）
import { readFileSync } from 'node:fs';
import { isDocsOnly, needsDevBuild, parseNulSeparated, repeatFiles, splitRepeatExcluded } from './ci.ts';

const paths = parseNulSeparated(readFileSync(0, 'utf8'));
if (process.argv.includes('--repeat')) {
  const { files, excluded } = splitRepeatExcluded(repeatFiles(paths));
  for (const [path, issue] of excluded) {
    console.error(`::notice title=e2e-repeat::${path} は繰り返しに耐えないので繰り返さない（直すまで。#${issue}）`);
  }
  console.log(`repeat=${files.length > 0}`);
  console.log(`repeat_files=${files.join(' ')}`);
} else {
  console.log(`docs_only=${isDocsOnly(paths)}`);
  console.log(`dev_build=${needsDevBuild(paths)}`);
}
