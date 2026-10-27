// CI の evidence と evidence-main: 上げる先のシークレットと変数がそろっているかを、ジョブの出力 ready= に書く。
// 足りなければ、ジョブの注記に名前を出して ready=false にする（ワークフローは後の段を飛ばし、成功で終える）
import { missingSettings, writeOutput } from './evidence.ts';

const missing = missingSettings(process.env);
if (missing.length > 0) {
  console.log(
    `::notice title=e2e の画像を上げない::シークレットか変数が無い（${missing.join('、')}）。docs/development.md の「e2e の画像のコメント」の用意を済ませる`,
  );
}
writeOutput('ready', missing.length === 0);
