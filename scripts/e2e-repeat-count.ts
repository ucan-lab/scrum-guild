// CI の e2e-repeat のジョブ: 標準入力で受けた playwright test --list --reporter=json の出力から、繰り返すテストの件数を数え、
// 上限（REPEAT_TEST_LIMIT）までなら run=true を GITHUB_OUTPUT の形で出す。超えたら run=false にし、回さなかったことを注記に出す。
// 件数は --shard も --repeat-each も付けずに数えるので、どのシャードでも同じ答えになる
import { readFileSync } from 'node:fs';
import { REPEAT_TEST_LIMIT, repeatVerdict, type ListReport } from './ci.ts';

const { run, count } = repeatVerdict(JSON.parse(readFileSync(0, 'utf8')) as ListReport);
console.log(`run=${run}`);
// 標準出力は GITHUB_OUTPUT に足すので、注記は標準エラーに出す
if (!run) {
  console.error(
    `::notice title=e2e-repeat::足したか変えた e2e のテストが ${count} 件で、上限の ${REPEAT_TEST_LIMIT} 件を超えたので繰り返さない`,
  );
}
