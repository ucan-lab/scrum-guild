// CI の changes のジョブ: 標準入力で受けた変わったファイルの一覧（git diff --name-only -z の NUL 区切り）から、
// 文書だけかと、開発モードの e2e（e2e-dev）を走らせるかを GITHUB_OUTPUT の形で出す。
import { readFileSync } from 'node:fs';
import { isDocsOnly, needsDevBuild, parseNulSeparated } from './ci.ts';

const paths = parseNulSeparated(readFileSync(0, 'utf8'));
console.log(`docs_only=${isDocsOnly(paths)}`);
console.log(`dev_build=${needsDevBuild(paths)}`);
