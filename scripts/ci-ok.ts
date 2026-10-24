// CI の ci-ok のジョブ: 環境変数 NEEDS（toJSON(needs)）を判定し、通さなければ失敗で終える。
import { ciOkVerdict, type Needs } from './ci.ts';

const needs = JSON.parse(process.env.NEEDS ?? '{}') as Needs;
for (const [name, job] of Object.entries(needs)) {
  console.log(`${name}: ${job.result}${name === 'changes' ? ` docs_only=${job.outputs?.docs_only ?? ''}` : ''}`);
}

const verdict = ciOkVerdict(needs);
if (!verdict.ok) {
  console.error(verdict.reason);
  process.exit(1);
}
