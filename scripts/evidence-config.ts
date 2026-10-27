// CI の evidence（node scripts/evidence-config.ts pr）と evidence-main（main）: 上げる先のシークレットと変数がそろっているかを、
// ジョブの出力 ready= に書く。PR のジョブは PR 用、main のジョブは main 用の鍵と変数を見る。
// 足りなければ、ジョブの注記に名前を出して ready=false にする（ワークフローは後の段を飛ばし、成功で終える）
import { missingSettings, notice, writeOutput, type Bucket } from './evidence.ts';

const bucket = process.argv[2];
if (bucket !== 'pr' && bucket !== 'main') throw new Error(`引数は pr か main: ${bucket}`);

const missing = missingSettings(process.env, bucket as Bucket);
if (missing.length > 0) {
  notice(
    'e2e の画像を上げない',
    `シークレットか変数が無い（${missing.join('、')}）。docs/development.md の「e2e の画像のコメント」の用意を済ませる`,
  );
}
writeOutput('ready', missing.length === 0);
