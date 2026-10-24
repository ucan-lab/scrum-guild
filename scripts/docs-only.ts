// CI の changes のジョブ: 標準入力で受けた変わったファイルの一覧（1行に1つ）から、文書だけかを GITHUB_OUTPUT の形で出す。
import { readFileSync } from 'node:fs';
import { isDocsOnly } from './ci.ts';

const paths = readFileSync(0, 'utf8').split('\n');
console.log(`docs_only=${isDocsOnly(paths)}`);
