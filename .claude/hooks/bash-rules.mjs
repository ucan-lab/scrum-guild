// Bash の判定。本番に触る操作、WORKERS_CI の設定、main の上のコミットと main への push、force push、
// シークレット（.dev.vars と .env）の読み取りと書き込み、gh pr merge を通さないマージを止め、
// gh pr merge、依存の変更、マイグレーションの作成、判定しきれない push と場所を判定できないデプロイのスクリプト、git のフックを外す --no-verify、
// 道具の名前が展開で決まるコマンド、env -S、読むだけの道具以外の xargs、wrangler の設定の書き換えと wrangler dev の -c、
// インタープリタの本文の中の wrangler と守る先の名前、展開を含む package.json のスクリプトの引数、
// 場所か package.json を判定できないパッケージマネージャーのスクリプトの実行、npm が知らないコマンド、展開で決まるスクリプトの名前、
// 表に無いフラグの読み方が多すぎるコマンド、読めない短いフラグのまとめ、
// 守る先とリポジトリの根とその祖先の削除と移動（rm、rmdir、mv、find -delete）、git clean の -x と -X では人の確認を挟む。
// e2e を走らせるコマンド（playwright test。pnpm e2e もスクリプトの中身として）は deny にする。
// find の -exec 系は {} を起点に置き換えて同じ規則に掛け直す（docs/development.md の「Claude の設定とフック」）。
// permissions.deny の前方一致では npx wrangler や pnpm exec wrangler の言い換えを取りこぼすので、語に分けて判定する。
// 踏み線であって守りの本体ではない。変数の中身と、パイプで sh に流す中身は見えない。
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DYNAMIC,
  GLOB_GROUP,
  abbreviates,
  baseName,
  commandIndex,
  concatWords,
  expandsAt,
  followsGlobGroup,
  isAssignment,
  positionalIndexes,
  positionals,
  prefixCommands,
  prefixIndexes,
  prefixName,
  redirectsOf,
  shapeAt,
  sliceWords,
  splitSegments,
} from './shell-words.mjs';

const DENY = 'deny';
const ASK = 'ask';
const MAX_DEPTH = 5;

// 引数を実行しない道具。これ以外の道具の後ろに wrangler の語があれば、wrangler の実行とみなす
// （npx dotenv -- wrangler、find -exec wrangler、docker run ... wrangler のような前置きを列挙しきれないため）。
// シークレットの名前も同じ考え方で、これ以外の道具の引数にあれば止める（judgeSecretAccess）
const NON_EXECUTING = new Set([
  'echo', 'printf', 'cat', 'less', 'more', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'awk', 'sort',
  'wc', 'diff', 'ls', 'tree', 'stat', 'file', 'which', 'type', 'man', 'git', 'gh', 'jq', 'yq', 'code', 'open',
  'mkdir', 'touch', 'rm', 'cp', 'mv', 'ln', 'chmod', 'tee', 'test', '[', '[[',
  // パスを扱うだけの道具（ワークツリーの .dev.vars のリンクを readlink .dev.vars で確かめる）
  'readlink', 'realpath', 'basename', 'dirname',
]);
// 引数を実行しない道具か。Homebrew の g 付きの名前（gls、gecho）は、GNU_PREFIXED にあるものだけ g を外して引く
const isNonExecuting = (tool) => NON_EXECUTING.has(GNU_PREFIXED.has(tool) ? tool.slice(1) : tool);
// 依存の情報を見るだけのサブコマンド（npm view wrangler versions など）
const PACKAGE_INFO = new Set([
  'view', 'info', 'show', 'why', 'list', 'ls', 'outdated', 'search', 'home', 'repo', 'docs', 'bugs', 'audit',
  'add', 'install', 'i', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'upgrade',
]);

// wrangler のパッケージの bin は wrangler、wrangler2（bin/wrangler.js と同じもの）、cf-wrangler の3つで、node_modules/.bin に全部入る。
// wrangler 4.152.0 の package.json の bin で確かめた（2026-10-26）
function isWrangler(word) {
  const name = baseName(word);
  return /^wrangler2?$/.test(name) || /^wrangler2?\.[cm]?js$/.test(name) || /(^|\/)wrangler\/(bin|wrangler-dist)\//.test(word);
}

// cf-wrangler は dev と build だけを持つ別の道具で、引数を yargs ではなく util.parseArgs で読む。wrangler の規則では判定できない。
// wrangler 4.152.0 の bin/cf-wrangler.js の verbHandlers と wrangler-dist/cli.js の parseDevArgs で確かめた（2026-10-26）
function isCfWrangler(word) {
  return /^cf-wrangler(\.[cm]?js)?$/.test(baseName(word));
}

// wrangler か cf-wrangler の語の位置。道具そのもの、または引数を実行しない道具以外の後ろ
function findWrangler(words, ci) {
  const isTool = (word) => isWrangler(word) || isCfWrangler(word);
  if (isTool(words[ci])) return ci;
  const tool = baseName(words[ci]);
  if (isNonExecuting(tool)) return -1;
  // 依存の情報を見るだけのサブコマンドの後ろの wrangler は実行ではない。corepack の後ろの道具も同じに見る（corepack npm view wrangler）
  const corepack = tool === 'corepack' ? 1 : 0;
  const manager = managerOf(corepack ? (words[ci + 1] ?? '') : words[ci]);
  if (manager && PACKAGE_INFO.has(positionals(words.slice(ci + 1 + corepack), PACKAGE_FLAGS_WITH_VALUE)[0])) return -1;
  for (let i = ci + 1; i < words.length; i++) {
    if (words[i - 1] === '-p' || words[i - 1] === '--package') continue;
    if (isTool(words[i])) return i;
  }
  return -1;
}

// Playwright のテストの実行（e2e）。playwright の bin（playwright、node_modules/.bin/playwright）と、
// パッケージの cli.js（node_modules/@playwright/test/cli.js、node_modules/playwright/cli.js）が道具の語になる。
// pnpm e2e のようなスクリプトの名前は、package.json の中身（playwright test）を judgeScripts が掛け直して見る
function isPlaywright(word) {
  const name = baseName(word);
  // @playwright/test は bin が playwright のパッケージ。npx や dlx には、版を付けた名前（@playwright/test@latest）でも渡る
  return (
    /^playwright(\.[cm]?js)?$/.test(name) ||
    /^@playwright\/test(@.+)?$/.test(word) ||
    /(^|\/)(@playwright\/test|playwright(-core)?)\/cli\.[cm]?js$/.test(word)
  );
}

// playwright の語の位置。findWrangler と同じく、道具そのもの、または引数を実行しない道具以外の後ろ
function findPlaywright(words, ci) {
  if (isPlaywright(words[ci])) return ci;
  if (isNonExecuting(baseName(words[ci]))) return -1;
  const corepack = baseName(words[ci]) === 'corepack' ? 1 : 0;
  const manager = managerOf(corepack ? (words[ci + 1] ?? '') : words[ci]);
  if (manager && PACKAGE_INFO.has(positionals(words.slice(ci + 1 + corepack), PACKAGE_FLAGS_WITH_VALUE)[0])) return -1;
  return words.findIndex((w, i) => i > ci && isPlaywright(w));
}

const E2E_REASON = 'e2e は手元で走らせず、CI（ci-ok）で確かめる。docs/development.md の「開発の流れ」';
// playwright の最初の位置引数が test なら e2e の実行。show-trace、install、--version などは通す。
// その語が展開で決まる（playwright $X、"$X"、$(echo test)）と test になりうるので、wrangler の引用符の外の展開と同じく止める
function judgePlaywright(args) {
  const at = args.findIndex((a) => !a.startsWith('-'));
  if (at === -1) return null;
  return args[at] === 'test' || expandsAt(args, at) || shapeAt(args, at).includes(DYNAMIC) ? [DENY, E2E_REASON] : null;
}

const WRANGLER_FLAGS_WITH_VALUE = new Set([
  '-c', '--config', '-e', '--env', '--cwd', '--env-file', '--name', '--port', '--ip', '--command', '--file', '--binding',
  '--persist-to', '--var', '--metadata', '--content-type',
]);
const WRANGLER_PRODUCTION = new Set(['deploy', 'publish', 'rollback', 'versions', 'deployments', 'delete', 'triggers', 'tail']);
const SECRET_REASON = 'シークレットとログインは人が扱う（セッションに Cloudflare の資格情報を置かない）';
const PRODUCTION_REASON = 'デプロイ、版、本番のログ、D1 と R2 の作成と削除は Workers Builds と人が行う';

// wrangler の yargs は、真偽のフラグが重なると後の値を採り、--local の次の語が true か false ならそれを値として読み、
// --local= の値は "true" のときだけ true にする。r2 と kv は local が false だと本番に向く。
// ここと下の yargs の読み方は、wrangler 4.152.0 に同梱の yargs 17.7.2 と yargs-parser 21.1.1 で確かめた（2026-10-25）。
// 後の値を採る規則は真似ず、打ち消しが1つでもあれば順番に関わらず止める。
// --local の次の語は、展開した結果が false になりうるとき（"fal$X"）も打ち消しとみなす
function negatesLocal(words) {
  return words.some(
    (a, i) =>
      a.startsWith('--no-local') ||
      (a.startsWith('--local=') && a !== '--local=true') ||
      (a === '--local' && mayBe(shapeAt(words, i + 1), 'false')),
  );
}

// 実行時に決まる位置（DYNAMIC）を任意の文字列として、shape が text になりうるか
function mayBe(shape, text) {
  const pattern = shape.split(DYNAMIC).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${pattern.join('.*')}$`, 's').test(text);
}

// yargs が読む語。-- の後ろはフラグにならない（リダイレクトは args に入らないので、--local >/dev/null false は --local false）。
// 値を取るフラグの値も除く。ただし - で始まる語は yargs が値にせずフラグとして読むので残す。展開の印は語と一緒に残す
function flagWords(args) {
  const end = args.indexOf('--');
  const head = end === -1 ? args : sliceWords(args, 0, end);
  const kept = [];
  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    if (a.includes('=') && WRANGLER_FLAGS_WITH_VALUE.has(a.split('=')[0])) continue;
    kept.push(i);
    if (WRANGLER_FLAGS_WITH_VALUE.has(a) && head[i + 1] !== undefined && !head[i + 1].startsWith('-')) i++;
  }
  return concatWords(...kept.map((i) => sliceWords(head, i, i + 1)));
}

// 引用符の外の変数、$(...)、brace 展開、glob は、シェルが展開した後に --no-local や --remote になるか、別の語に分かれうる
// （--local{,=false}、--binding {KV,--no-local}、--binding $(echo KV --no-local)）。値を取るフラグの値も同じ
const UNQUOTED_REASON = [
  DENY,
  'wrangler の引数を引用符の外の変数、$(...)、{a,b}、glob、zsh の (a|b) で組み立てると、展開した後に本番に向くかを判定できない',
];
// 引用符の中の展開でも、展開した結果が - で始まると yargs はフラグとして読む。値を取るフラグの次の語でも値にしない（--file "$X" で X=--remote）。
// --flag="$X" の形なら、yargs は = の右を - で始まっても値として読む
const LEADING_REASON = [
  DENY,
  'wrangler の引数を変数や $(...) で始めるか、フラグの名前に展開を入れると、展開した結果をフラグとして読みうる。値を取るフラグの値は --flag="$X" の形で、位置引数は固定の文字で始めて（"./$X"、"attachments/$K"）渡す',
];

// 引用符の中の展開を含む語が、展開した後にフラグになりうるか。shape は shapeAt の形（実行時に決まる位置が DYNAMIC）。
// 先頭が展開の語と、- で始まり展開を含む語（--re$X）が当たる。値を取るフラグの = の形で、= の右だけに展開があるもの（--file=$(…)）は除く
function mayBecomeFlag(shape) {
  if (!shape.includes(DYNAMIC)) return false;
  if (shape.startsWith(DYNAMIC)) return true;
  if (!shape.startsWith('-')) return false;
  const eq = shape.indexOf('=');
  return eq === -1 || shape.slice(0, eq).includes(DYNAMIC) || !WRANGLER_FLAGS_WITH_VALUE.has(shape.slice(0, eq));
}

// yargs はフラグの名前を改行の手前で切り（'--local<改行>' は --local）、. の後ろをドット記法で読む（--local.x=1 で local が配列になり、
// r2 と kv は本番に向く）。名前の完全一致で見る判定が外れるので、名前に空白、改行、. を含むフラグは止める。
// -1.5 のような負の数は、yargs が値として読むので除く
const UNREADABLE_FLAG = /^-(?!\d)[^=]*[\s.]/;

// wrangler dev の -r は --remote の別名で、yargs は -lr のようにまとめた短いフラグも1文字ずつ読み、別名の長い形 --r も読む。
// d1、r2、kv には -r が無いので、サブコマンドを問わず = より前に r を含む短いフラグを止める。負の数（-1.5）は除く。
// 別名は wrangler 4.152.0 の dev の remote（alias: "r"）と local（alias: "l"）で確かめた（2026-10-25）
const SHORT_REMOTE = /^-(?![-\d])[^=]*r/;

// wrangler dev に渡す -c と --config（-c=…、--config=… も）は、remote の binding を持つ別の設定を渡して本番の D1 と R2 に届きうる。
// 値を問わず確認を挟む。作業場所の中に Write で置いた設定も渡せるため。
// yargs は -lc のようにまとめた短いフラグの c も -c と読み、別名の長い形 --c も読む（--r と同じ）ので、
// SHORT_REMOTE と同じく = より前に c を含む短いフラグと --c を拾う。-- の後ろはフラグにならない
const DEV_CONFIG_REASON = 'wrangler dev の -c と --config は、remote の binding を持つ設定を渡して本番の D1 と R2 に届きうる。人が確かめる';
function mentionsConfig(args) {
  const end = args.indexOf('--');
  const head = end === -1 ? args : args.slice(0, end);
  return head.some((a) => /^--(config|c)(=|$)/.test(a) || /^-(?![-\d])[^=]*c/.test(a));
}

function judgeWrangler(args) {
  const isRemote = args.some(
    (a) =>
      SHORT_REMOTE.test(a) ||
      ['--remote', '--r'].includes(a) ||
      (/^--(remote|r)=/.test(a) && !/^--(remote|r)=false$/.test(a)) ||
      /^--(x|experimental)-remote-bindings/.test(a),
  );
  if (isRemote) return [DENY, '--remote を付けた wrangler は本番に触るので、Workers Builds だけが実行する'];

  const pos = positionals(args, WRANGLER_FLAGS_WITH_VALUE);
  const decidesOperation = pos.slice(0, pos[1] === 'migrations' ? 3 : 2);
  if (decidesOperation.some((p) => p.includes('$'))) {
    return [DENY, 'wrangler のサブコマンドを変数や $(...) で渡すと、本番に触るかを判定できない'];
  }
  if (pos.includes('secret') || pos.includes('login')) return [DENY, SECRET_REASON];
  if (pos.some((p) => WRANGLER_PRODUCTION.has(p))) return [DENY, `wrangler ${pos[0]} は本番に触る。${PRODUCTION_REASON}`];

  const words = flagWords(args);
  if (words.some((a) => UNREADABLE_FLAG.test(a))) {
    return [DENY, 'wrangler のフラグの名前に空白、改行、. を含むと、wrangler がどのフラグと読むかを判定できない'];
  }
  // 展開は、値を取るフラグの値も含めた -- より前の全部の語で見る。-- の後ろは yargs がフラグとして読まない
  const end = args.indexOf('--');
  const argv = [...args.keys()].filter((i) => end === -1 || i < end);
  if (argv.some((i) => expandsAt(args, i))) return UNQUOTED_REASON;
  if (argv.some((i) => mayBecomeFlag(shapeAt(args, i)))) return LEADING_REASON;

  const [sub, sub1, sub2] = pos;
  const hasLocal = words.includes('--local') || words.includes('--local=true');
  const needLocal = (what) => {
    if (negatesLocal(words)) {
      return [DENY, `${what} の --no-local、--local=<true 以外>、--local false は local を打ち消して本番に向く。--local だけを付ける`];
    }
    return hasLocal ? null : [DENY, `${what} は --local を付けて手元の D1、R2、KV に向けて実行する`];
  };

  if (sub === undefined) return null; // wrangler --version、wrangler --help
  if (sub === 'dev' && mentionsConfig(args)) return [ASK, DEV_CONFIG_REASON];
  if (['dev', 'types', 'help', 'version', 'whoami'].includes(sub)) return null;
  if (sub === 'd1') {
    if (sub1 === 'migrations' && sub2 === 'create') {
      return [ASK, 'マイグレーションを含む PR は同時に1本まで（docs/development.md の「並行して作業するときの決まり」）'];
    }
    if (sub1 === 'migrations' && (sub2 === 'apply' || sub2 === 'list')) return needLocal(`wrangler d1 migrations ${sub2}`);
    if (sub1 === 'execute' || sub1 === 'export') return needLocal(`wrangler d1 ${sub1}`);
  }
  if (sub === 'r2' && sub1 === 'object') return needLocal('wrangler r2 object');
  if (sub === 'kv' && (sub1 === 'key' || sub1 === 'bulk')) return needLocal(`wrangler kv ${sub1}`);
  return [DENY, `wrangler ${pos.slice(0, 2).join(' ')} は本番に触る。${PRODUCTION_REASON}`];
}

const GIT_FLAGS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source']);
const PUSH_FLAGS_WITH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
// main の上で新しいコミットを作る操作。pull --ff-only と merge --ff-only は main を origin に追いつかせるだけなので通す。
// --ff-only を打ち消すオプション（--no-ff、--rebase など）と、値の取り違え（-m --abort）では抜けさせない
const COMMITTING = new Set(['commit', 'merge', 'pull', 'cherry-pick', 'revert', 'am']);
const MAKES_COMMIT = /^(--no-ff|--ff|--no-ff-only|--squash|--commit|--rebase|-r|-m|--message|-F|--file)(=|$)/;
function onlyStops(sub, args) {
  if (args.length === 1 && ['--abort', '--quit'].includes(args[0])) return true;
  return ['pull', 'merge'].includes(sub) && args.includes('--ff-only') && !args.some((a) => MAKES_COMMIT.test(a));
}

// git は長いオプションを一意な省略形でも受け付ける（--force-w は --force-with-lease、--mi は --mirror）
function isOption(arg, full, shortest) {
  const name = arg.split('=')[0];
  return name.length >= shortest && full.startsWith(name);
}

const FORCE_PUSH_REASON = 'force push はしない。ベースは sync-base で merge して取り込み、通常の push をする';

// push の位置引数の位置。--repo を付けると、先頭の位置引数もリモートではなく refspec になる
function pushOperands(rest) {
  const pos = positionalIndexes(rest, PUSH_FLAGS_WITH_VALUE);
  const hasRepo = rest.some((a) => a === '--repo' || a.startsWith('--repo='));
  return { hasRepo, pos, refspecs: hasRepo ? pos : pos.slice(1) };
}

// 値を次の語で取る長いオプション。git は一意な省略形でも受ける（--pu は --push-option、--rep は --repo）
function takesNextWord(a) {
  if (a.includes('=')) return false;
  return PUSH_FLAGS_WITH_VALUE.has(a) || isOption(a, '--push-option', 4) || isOption(a, '--repo', 5) || isOption(a, '--receive-pack', 6) || isOption(a, '--exec', 3);
}

// push の短いフラグは -4、-6、-o（値を取る）もまとめられる。-o の後ろは値なので、そこにある f は force ではない（-oforce、-o -f）
function forcesPush(rest) {
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') break;
    if (a.startsWith('--')) {
      if (a === '--force' || isOption(a, '--mirror', 3) || isOption(a, '--force-with-lease', 9) || isOption(a, '--force-if-includes', 9)) return true;
      if (takesNextWord(a)) i++;
      continue;
    }
    if (!/^-[^-]/.test(a)) continue;
    for (let k = 1; k < a.length; k++) {
      if (a[k] === 'f') return true;
      if (a[k] === 'o') {
        if (k + 1 === a.length) i++;
        break;
      }
    }
  }
  return pushOperands(rest).refspecs.some((at) => rest[at].startsWith('+'));
}

// git -C "$(git rev-parse --show-toplevel)"、-C ~/x、-C /rep?、-C src(N) の行き先は、実行するまで分からない。
// target は行き先の文字列で、at は args の中のその語の位置（-C src の src、-Csrc の -Csrc）。展開の印は語ぜんたいで見る
// （'sr?' のように引用符の中の記号は文字なので、行き先として解決する）
function gitDirAt(dir, target, args, at) {
  return /^~/.test(target) || isUnresolved(args, at) ? null : dir && path.resolve(dir, target);
}

// dir が null のときは、作業場所を判定できない（cd ~、cd $X、GIT_DIR=）
function judgeGit(args, dir, branchOf) {
  let i = 0;
  let gitDir = dir;
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '-C') gitDir = gitDirAt(gitDir, args[i + 1] ?? '.', args, i + 1);
    if (/^-C./.test(args[i])) gitDir = gitDirAt(gitDir, args[i].slice(2), args, i);
    if (/^--(git-dir|work-tree)/.test(args[i])) gitDir = null;
    i += GIT_FLAGS_WITH_VALUE.has(args[i]) ? 2 : 1;
  }
  const sub = args[i];
  const rest = sliceWords(args, i + 1);
  if (sub === 'push' && forcesPush(rest)) return [DENY, FORCE_PUSH_REASON];
  // 括弧の glob の後ろに語が続く形（git --no-pager(N) commit）は、judgeBash が道具を問わず確認を挟む。
  // ここで見るのは後ろに語が続かない push の refspec（git push origin x(N)）で、zsh が当たらない語を消して git push origin になり、
  // 今のブランチを push する
  if (sub === 'push' && rest.some((a) => a.endsWith(GLOB_GROUP))) {
    return [ASK, 'git push の refspec の zsh の括弧の glob（x(N)）は、当たらなければ消えて今のブランチの push になる。人が確かめる'];
  }
  // サブコマンドが展開で決まる（git {commit,} -m y、git $X -m y、git c?mmit -m y）と、コミットか push かを文字列で比べられない。
  // どちらにもなりうるものとして確認を挟む
  const verdict =
    sub !== undefined && isUnresolved(args, i)
      ? [ASK, 'git のサブコマンドを変数、$(...)、{a,b}、glob で渡すと、コミットや push をするかを判定できない。人が確かめる']
      : judgeGitCommand(sub, rest, gitDir, branchOf);
  // core.hooksPath を変えると .githooks/ の守りが外れる。止める判定はそのまま、それ以外は人が確かめる
  const touchesHooksPath = (a) => /core\.hookspath/i.test(a);
  const readsConfig = rest.some((a) => /^--(get|get-all|get-regexp|list)$|^-l$/.test(a));
  if (args.slice(0, i).some(touchesHooksPath) || (sub === 'config' && !readsConfig && rest.some(touchesHooksPath))) {
    if (verdict?.[0] !== DENY) return [ASK, 'core.hooksPath を変えると main を守る git のフック（.githooks/）が外れる。人が確かめる'];
  }
  return verdict;
}

function judgeGitCommand(sub, rest, gitDir, branchOf) {
  if (sub === 'add' && rest.some(mentionsSecret)) return [DENY, '.dev.vars と .env は git に入れない'];
  if (COMMITTING.has(sub) && !onlyStops(sub, rest)) {
    if (!gitDir) return [ASK, `git ${sub} をする作業コピーを判定できない（cd ~ や変数の先、GIT_DIR=）`];
    const branch = branchOf(gitDir);
    if (branch === 'main') return [DENY, `main の上で git ${sub} はしない。ワークツリーで作業ブランチを切り、PR を通す`];
    // 存在しない行き先（cd nope; git commit）と detached HEAD は、ブランチを引けない。main の判定に当たらないまま通さない
    if (branch === undefined) return [ASK, `git ${sub} をする作業コピーのブランチを引けない（存在しない行き先、detached HEAD、git の管理外）。人が確かめる`];
  }
  // --no-verify は .githooks/ の pre-commit と pre-push を外す。このフックが作業コピーを読み違えたときの第二の守りが無くなるので、
  // main の上の判定を先に効かせた後、ブランチを問わず人が確かめる
  if (COMMITTING.has(sub) && (skipsHooks(rest, sub === 'commit') || mayAddFlag(rest, GIT_SHORT_FLAGS_WITH_VALUE[sub]))) return [ASK, NO_VERIFY_REASON];
  if (sub === 'clean' && cleansIgnored(rest)) return [ASK, CLEAN_IGNORED_REASON];
  if (sub !== 'push') return null;

  if (rest.some((a) => isOption(a, '--all', 4))) return [DENY, '--all は main も push する'];

  const { hasRepo, pos, refspecs } = pushOperands(rest);

  const current = gitDir ? branchOf(gitDir) : undefined;
  // 先は { name, expands } で、expands は refspec の語に展開の印（変数、$(…)、{a,b}、glob）があるか。
  // cd の行き先と同じく isUnresolved で見る（git push origin {main,x}、git push origin ma?n）。
  // 引用符の中の * も、git が refspec のパターンとして読む（'refs/heads/*:refs/heads/*' は main も push する）
  const targets =
    refspecs.length === 0
      ? [{ name: 'HEAD', expands: false }]
      : refspecs.map((at) => ({ name: rest[at].split(':').pop(), expands: isUnresolved(rest, at) || rest[at].includes('*') }));
  const unknown = (t) => t.expands || ((t.name === 'HEAD' || t.name === '@') && !current);
  // 判定できない先があっても、並べて書いた main は先に止める
  for (const target of targets.filter((t) => !unknown(t))) {
    const name = (target.name === 'HEAD' || target.name === '@' ? current : target.name).replace(/^(refs\/)?heads\//, '');
    if (name === 'main') {
      return [DENY, 'main へは push しない。作業ブランチから PR を通す（文書だけの変更も同じ）'];
    }
  }
  if (skipsHooks(rest, false) || mayAddFlag(rest, 'o')) return [ASK, NO_VERIFY_REASON];
  if (targets.some((t) => t.expands)) return [ASK, '変数、$(...)、{a,b}、glob を含む refspec は、main を含むかを判定できない'];
  // リモートの位置の語が展開で複数の語に分かれる（git push {origin,x} main）と、後ろの語がリモートから refspec にずれる
  if (!hasRepo && pos.length > 0 && expandsAt(rest, pos[0])) return [ASK, 'push するリモートの語が展開で複数の語に分かれうるので、refspec を判定できない'];
  if (targets.some(unknown)) return [ASK, 'push する先のブランチを判定できない（cd ~ や変数の先、git の管理外）'];
  return null;
}

// 本体の作業コピーの git clean -x は、ワークツリーのリンクの先の .dev.vars（本体の本物）も消す。作業場所を問わず人が確かめる
const CLEAN_IGNORED_REASON =
  'git clean の -x、-X と ! で始まる -e は ignore したファイル（.dev.vars とそのリンク、.wrangler の手元の D1 と R2）も消す。消える先を git clean -n -x で見てから人が確かめる';

// git clean の引数に -x か -X（-fdx のようにまとめた形も）があり、-n と --dry-run（一意な省略形の --d も）が無いか。
// -e と --exclude は値を取るので、-exyz の xyz と -e x の x は数えない。-- と --end-of-options の後ろはパスなので見ない。
// git の parse-options は後に書いたものを採るので、--no-dry-run（--no-dry などの省略形も）の後は試し実行ではない（git clean -n --no-dry-run -f は消す）
// -e と --exclude の値が ! で始まると、ignore の規則を打ち消して ignore したファイル（.dev.vars）も消す（git clean -fd -e '!*' は -x と同じ）
const negatesIgnore = (value) => value?.startsWith('!') === true;
function cleansIgnored(args) {
  let ignored = false;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--' || a === '--end-of-options') break;
    if (a.startsWith('--')) {
      if (isOption(a, '--dry-run', 3)) dryRun = true;
      if (isOption(a, '--no-dry-run', 6)) dryRun = false;
      if (isOption(a, '--exclude', 3)) {
        const eq = a.indexOf('=');
        if (negatesIgnore(eq === -1 ? args[++i] : a.slice(eq + 1))) ignored = true;
      }
      continue;
    }
    if (!/^-./.test(a)) continue;
    for (let k = 1; k < a.length; k++) {
      if (a[k] === 'n') dryRun = true;
      if (a[k] === 'x' || a[k] === 'X') ignored = true;
      if (a[k] === 'e') {
        if (negatesIgnore(k + 1 === a.length ? args[++i] : a.slice(k + 1))) ignored = true;
        break;
      }
    }
  }
  return ignored && !dryRun;
}

const NO_VERIFY_REASON =
  '--no-verify と commit の -n（展開した結果がそうなりうる語も）は、main を守る git のフック（.githooks/ の pre-commit と pre-push）を外す。人が確かめる';
// サブコマンドごとの値を取る短いフラグ。値の語は、先頭が展開でもフラグとして読まれない（git commit -m "$msg"）。
// 同じ文字でも値を取るかはサブコマンドで違う（commit の -s は --signoff、merge の -s は --strategy）。
// 値を取らないフラグを入れると次の語を値として飛ばし、展開した --no-verify を見逃す（git commit -s "$X"）ので、確かめたものだけを並べる
const GIT_SHORT_FLAGS_WITH_VALUE = { commit: 'mFcCt', merge: 'mFsX', pull: 'sX', 'cherry-pick': 'mX', revert: 'mX', am: '' };
const GIT_LONG_FLAGS_WITH_VALUE = new Set([
  '--message', '--file', '--author', '--date', '--template', '--reuse-message', '--reedit-message', '--fixup', '--cleanup', '--trailer',
  '--strategy', '--strategy-option', ...PUSH_FLAGS_WITH_VALUE,
]);

// 展開した結果が - で始まり、git がフラグ（--no-verify、-n）として読みうる語があるか（wrangler の mayBecomeFlag と UNQUOTED_REASON と同じ考え方）。
// 引用符の外の変数と $(…) は語を分けるので位置を問わず、{a,b}、glob、括弧の glob は先頭にあるとき（{--no-verify,}）、
// 引用符の中の展開は先頭にあるとき（"$X"）、- で始まる語はフラグの名前に展開を含むとき（--no-verif*、--no-$X）に当たる。
// 値を取るフラグの値（-m "$msg"、--author="$A"、-m"$msg"）は、語を分けない限りフラグにならないので通す。-- の後ろはパスなので見ない
function mayAddFlag(args, shortWithValue) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') return false;
    const shape = shapeAt(args, i);
    const splits = expandsAt(args, i);
    if (splits && (shape.includes(DYNAMIC) || /^[{*?[(]/.test(a))) return true;
    if (shape.startsWith(DYNAMIC)) return true;
    if (!shape.startsWith('-')) continue;
    const dynamicAt = shape.indexOf(DYNAMIC);
    const name = dynamicAt === -1 ? shape : shape.slice(0, dynamicAt);
    const long = shape.startsWith('--');
    const valueAt = long ? name.indexOf('=') : [...name].findIndex((c, k) => k > 0 && shortWithValue.includes(c));
    if ((dynamicAt !== -1 || splits) && valueAt === -1) return true;
    // 値を取るフラグが語の最後なら、次の語はその値。語を分ける展開（-m $msg、-m {a,--no-verify}）だけを見る
    const takesNext = long ? GIT_LONG_FLAGS_WITH_VALUE.has(shape) : valueAt === shape.length - 1;
    if (takesNext && i + 1 < args.length) {
      i++;
      if (expandsAt(args, i) && (shapeAt(args, i).includes(DYNAMIC) || args[i].includes('{'))) return true;
    }
  }
  return false;
}
// commit の値を取る短いフラグ。まとめた短いフラグ（-am x）の中では、これ以降は値の一部（-mn は「n」というメッセージ）
const COMMIT_SHORT_FLAGS_WITH_VALUE = 'mFcCt';

// --no-verify（git は長いオプションを一意な省略形でも受け付けるので --no-v 以上）か、commit の -n（-an のようにまとめた形も）があるか。
// -n は commit だけで見る（merge と pull の -n は --no-stat、push の -n は --dry-run）。
// 値を取る短いフラグが語の最後なら次の語はその値なので飛ばし（-m -n）、-- の後ろはパスなので見ない
function skipsHooks(args, shortN) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') return false;
    if (a.startsWith('--')) {
      if (isOption(a, '--no-verify', 6)) return true;
      continue;
    }
    if (!shortN || !/^-[^-]/.test(a)) continue;
    for (let k = 1; k < a.length; k++) {
      if (a[k] === 'n') return true;
      // -u と -S は値を連結の形でだけ取る（-uno は --untracked-files=no）
      if ('uS'.includes(a[k])) break;
      if (COMMIT_SHORT_FLAGS_WITH_VALUE.includes(a[k])) {
        if (k + 1 === a.length) i++;
        break;
      }
    }
  }
  return false;
}

const MERGE_REASON = 'マージは人が指示したときだけ gh pr merge <番号> --squash --match-head-commit <head> で行う（docs/development.md の「マージの判定」）';

const FORCE_REF_REASON_UNKNOWN = 'ref の更新の API に force: true を送るかを判定できない（本文がファイルや読めない標準入力、force の値が展開）。本文は引数かヒアドキュメントで字面を渡す。人が確かめる';
const FORCE_DYNAMIC_PATH_REASON = 'エンドポイントを変数や展開で渡すと、force: true で ref を更新するかを判定できない。人が確かめる';
const GRAPHQL_UNREADABLE_REASON = 'GraphQL の query か本文を読めず（--input のファイル、読めない標準入力、query=@ファイル）、mutation の名前を判定できない。query は引数かヒアドキュメントで字面を渡す。人が確かめる';
const REBASE_BRANCH_REASON = `PR のブランチを rebase で更新する updatePullRequestBranch は、GitHub の側で head を書き換え、force push と同じになる。${FORCE_PUSH_REASON}`;

const hasExpansion = (text) => /[$`]/.test(text);
// 展開か curl の {{変数}} で決まる語
const isDynamic = (text) => hasExpansion(text) || text.includes('{{');
const JSON_STRING = /"(?:[^"\\]|\\.)*"/g;

// 要求の force を 'yes'（字面で true）、'unknown'（読めない）、'no' で返す。
// fields は gh api の -f と -F の値（key=value）、bodies は本文 { text, literal }（literal は展開を含まない字面）、unreadable は中身が見えない本文があるか。
// JSON のキーの形だけを見る（-f note=force=true は note の値）
function forceOf({ fields, bodies, unreadable }) {
  const verdicts = [unreadable ? 'unknown' : 'no'];
  for (const field of fields) {
    const eq = field.indexOf('=');
    const key = eq === -1 ? field : field.slice(0, eq);
    const value = eq === -1 ? '' : field.slice(eq + 1);
    // 展開で決まる名前（-F "$FIELD"）は force になりうる。-F の @ファイル は値を読めない
    if (hasExpansion(key) || (key === 'force' && (hasExpansion(value) || value.startsWith('@')))) verdicts.push('unknown');
    else if (key === 'force' && value === 'true') verdicts.push('yes');
    // true と false 以外（1、yes）を GitHub がどう受けるかは確かめていないので、読めないものとして確認に倒す
    else if (key === 'force' && value !== 'false') verdicts.push('unknown');
  }
  for (const { text, literal } of bodies) {
    for (const [, value] of text.matchAll(/"force"\s*:\s*"?([^,}\s"]*)/g)) {
      verdicts.push(value === 'true' ? 'yes' : value === 'false' ? 'no' : 'unknown');
    }
    // 展開を含む本文は、JSON の文字列の外（キー、値、区切り）に展開が来る形（{"sha":"a",$F}）と、JSON のキー、
    // コマンド置換の中身が force を持ち込みうる。文字列の値の中の変数（"sha":"$SHA"）は force を持ち込まないので読まない
    const outside = text.replace(JSON_STRING, '""');
    if (!literal && (hasExpansion(outside) || /"[^"]*[$`][^"]*"\s*:/.test(text) || /\$\(|`/.test(text))) verdicts.push('unknown');
  }
  return verdicts.includes('yes') ? 'yes' : verdicts.includes('unknown') ? 'unknown' : 'no';
}

// graphql の宛先の字面（glob や #、大文字は別の判定が拾うので、graphql を含む語を広く数える）
const isGraphqlEndpoint = (endpoint) => /graphql/i.test(endpoint);
// main の後ろに続く語（-fix、.json、/x）は別のブランチ。末尾の / だけは main と同じ ref に読まれうるので止める
const MAIN_REF = /\/git\/refs\/heads\/main(?![\w.-]|\/[^\s?#])/;

// 展開より前の字面で資源の種類が決まる宛先か（repos/o/r/issues/$n/comments は issues、repos/o/r/git/refs/$x は git/refs）。
// repos/$R/… や repos/o/r/$kind/… のように、種類が展開で決まるものは決まらない。種類は repos/<owner>/<repo>/<種類>/ の種類で、
// git は次の語まで（git/refs/ は ref の更新）。URL の場合はスキームとホストを外して見る
function resourceKnown(endpoint) {
  const at = endpoint.search(/[$`]|\{\{/);
  const prefix = (at === -1 ? endpoint : endpoint.slice(0, at)).replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
  const complete = prefix.replace(/^\//, '').split('/').slice(0, -1);
  return complete[0] === 'repos' && complete.length >= (complete[3] === 'git' ? 5 : 4);
}

// GitHub の API でも ref の強制更新は force push と同じに扱う。GET（読むだけ）は通す。
// words は引数ぜんたい、endpoints はエンドポイントの位置引数（gh api）か URL（curl）。ref の更新かどうかは、コマンドぜんたいの文字列でなく、
// endpoints だけで見る（Issue のコメントの本文に書いた /git/refs/ や {"force":true} は、ref を動かさない）。
// opaqueQuery は query のフィールドが字面でないか
function judgeGitHubWrite(words, method, { endpoints = [], fields = [], bodies = [], unreadable = false, opaqueQuery = false } = {}) {
  const path = endpoints.join(' ');
  // mutation の名前は、宛先を問わず引数と本文のぜんたいで見る（glob、#、大文字、query string、--url-query、-F で graphql の宛先を字面から外せるため）。
  // コメントの本文に書いた語も止まる
  const text = [...words, ...bodies.map(({ text: body }) => body)].join(' ');
  if (/enablePullRequestAutoMerge/.test(text)) return [DENY, 'auto-merge は使わない'];
  if (/mergePullRequest/.test(text)) return [DENY, MERGE_REASON];
  if (/updateRefs?\b/.test(text)) return [DENY, 'main は PR のマージでだけ進める'];
  // gh pr update-branch --rebase の中身。updateMethod を付けないか MERGE なら merge のコミットを足す通常の更新
  if (/updatePullRequestBranch/.test(text)) {
    if (/\bREBASE\b/.test(text)) return [DENY, REBASE_BRANCH_REASON];
    if (/updateMethod\s*[:=]\s*\$/.test(text)) return [ASK, 'updatePullRequestBranch の updateMethod を変数で渡すと REBASE かを判定できない。人が確かめる'];
  }
  // 展開より前の字面でも資源の種類が決まらない宛先は、宛先を確定できない
  const undecided = endpoints.some((e) => isDynamic(e) && !resourceKnown(e));
  const graphql = endpoints.some(isGraphqlEndpoint);
  // query か本文が字面でなければ、mutation の名前を読めない
  if ((graphql || (undecided && method !== 'GET')) && (opaqueQuery || bodies.some(({ literal }) => !literal))) return [ASK, GRAPHQL_UNREADABLE_REASON];
  if (graphql && (unreadable || fields.some((f) => f.startsWith('query=@')))) return [ASK, GRAPHQL_UNREADABLE_REASON];
  if (method === 'GET') return null;
  // ref の名前を変数で渡す形（git/refs/$REF）も当たるよう、heads/ までは問わない
  const updatesRef = /\/git\/refs\/[^\s]+/.test(path);
  if (updatesRef || undecided) {
    const force = forceOf({ fields, bodies, unreadable });
    if (force === 'yes') return updatesRef ? [DENY, FORCE_PUSH_REASON] : [ASK, FORCE_DYNAMIC_PATH_REASON];
    if (force === 'unknown' && !MAIN_REF.test(path)) return [ASK, updatesRef ? FORCE_REF_REASON_UNKNOWN : FORCE_DYNAMIC_PATH_REASON];
  }
  if (/\/pulls\/[^/\s]+\/merge\b|\/merges\b/.test(path)) return [DENY, MERGE_REASON];
  if (MAIN_REF.test(path)) return [DENY, 'main は PR のマージでだけ進める'];
  // contents API の書き込みは、ブランチを指定しなければ既定のブランチ（main）へ直にコミットする
  if (/\/contents\//.test(path)) return [DENY, 'contents API でのファイルの書き込みはしない。作業ブランチで git を使う'];
  return null;
}

// 変数で渡したメソッドは読めないので、書き込みとみなす
function methodOf(value, fallback) {
  if (value === undefined) return fallback;
  return value.includes('$') ? 'UNKNOWN' : value.toUpperCase();
}

// echo と printf が標準入力に流す本文。字面が引数と同じときだけ読む（printf の % の書式、\ のエスケープ、リダイレクトでファイルに書く echo は読めない）。
// splitSegments は区切りの種類（| か ;）を残さないので、直前の区切りがパイプで渡るかは見分けない。読めない形は undefined
function echoedText(words) {
  const ci = words ? commandIndex(words) : -1;
  if (ci === -1 || redirectsOf(words).some(isWriteRedirect)) return undefined;
  const tool = baseName(words[ci]);
  if (tool !== 'echo' && tool !== 'printf') return undefined;
  const args = [...sliceWords(words, ci + 1)];
  // 引数のどれかに展開があれば、本文は字面ではない
  const literal = !args.some((_, k) => shapeAt(words, ci + 1 + k).includes(DYNAMIC));
  while (tool === 'echo' && /^-[neE]+$/.test(args[0] ?? '')) args.shift();
  // printf の -- は書式の前の区切り
  if (tool === 'printf' && args[0] === '--') args.shift();
  const text = tool === 'echo' ? args.join(' ') : (args[0] ?? '');
  if ((tool === 'printf' && text.includes('%')) || /\\(?!n)/.test(text)) return undefined;
  // printf と zsh の echo は \n を改行にする。JSON の改行は空白なので、"force":\ntrue は force: true と読める
  return { text: text.replaceAll('\\n', '\n'), literal };
}

// グループ（{ …; }）とサブシェル（( … )）の構文があるか。引用符の外の ( ) と、単独の語の { } を見る。
// 中の echo が gh や curl の標準入力に流れるとは限らず（cat b.json | { echo x; gh api … --input -; }）、
// グループぜんたいへのリダイレクト（{ …; } < b.json）も区切りの語からは見えない
// 引用符の数え方がずれる形（ヒアドキュメントの本文のアポストロフィなど）は、走査の終わりで引用符が閉じないので、グループありとみなす。
// $( … ) と $(( … )) のコマンド置換は、中を別のコマンドとして判定するので、グループに数えない
function hasGrouping(command) {
  let quote = '';
  let substitutions = 0;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === '\\' && quote !== "'") i++;
      else if (c === (quote === "$'" ? "'" : quote)) quote = '';
      continue;
    }
    if (c === '\\') i++;
    else if (c === '#' && /^[\s;&|(]?$/.test(command[i - 1] ?? '')) {
      // 語の頭の # から行末まではコメント
      const end = command.indexOf('\n', i);
      if (end === -1) break;
      i = end;
    } else if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '$' && command[i + 1] === "'") {
      quote = "$'";
      i++;
    } else if (c === '$' && command[i + 1] === '(') {
      const arithmetic = command[i + 2] === '(';
      substitutions += arithmetic ? 2 : 1;
      i += arithmetic ? 2 : 1;
    } else if (c === '(') return true;
    else if (c === ')') {
      if (substitutions === 0) return true;
      substitutions--;
    } else if ((c === '{' || c === '}') && /^[\s;&|(]?$/.test(command[i - 1] ?? '') && /^[\s;&|)]?$/.test(command[i + 1] ?? '')) return true;
  }
  return quote !== '';
}

// ヒアドキュメントの本文が字面か（終わりの印にクォートがあるか）。区切りの語は redirect に残らないので、
// 本文の前の行の << の後ろの語と、本文の後ろの終わりの印の行を突き合わせて見つける。見つからなければクォートの無い印として読む
function heredocIsLiteral(command, body) {
  if (body === '') return true;
  for (let from = 0, at; (at = command.indexOf(body, from)) !== -1; from = at + 1) {
    if (at === 0 || command[at - 1] !== '\n') continue;
    const delimiter = /^\n([^\n]*)/.exec(command.slice(at + body.length))?.[1].trim();
    if (!delimiter) continue;
    const line = command.slice(command.lastIndexOf('\n', at - 2) + 1, at - 1);
    for (const [, raw] of line.matchAll(/(?<!<)<<-?[ \t]*([^\s;&|()<>]+)/g)) {
      if (raw.replaceAll(/['"\\]/g, '') === delimiter) return /['"\\]/.test(raw);
    }
  }
  return false;
}

// 標準入力の出どころの手がかりのうち、コマンドぜんたいの形で決まるもの
const stdinShape = (command) => ({ command, grouped: hasGrouping(command) });

// 標準入力で読む本文 { bodies: [{ text, literal }], unreadable }。読めるのは、この区切りのヒアドキュメントとヒアストリング、
// 直前の区切りの echo と printf の字面だけ。ファイルから読む（< body.json）、cat や jq のような別の道具の出力、
// グループの中の区切り、ほかの区切りの語は、本文として読めない
function stdinBody(args, { previous, command = '', grouped = false } = {}) {
  // 標準入力のリダイレクトが重なると、後ろのものが効く（<<<'…' < body.json は body.json）
  const last = redirectsOf(args).filter((r) => isHeredocRedirect(r) || isReadRedirect(r)).at(-1);
  if (last && isHeredocRedirect(last)) {
    // ヒアストリングは語と同じく展開の印（shape）で、ヒアドキュメントは終わりの印のクォートで、字面かを見る
    const literal = last.op === '<<<' ? !last.shape.includes(DYNAMIC) : heredocIsLiteral(command, last.target);
    return { bodies: [{ text: last.target, literal }], unreadable: false };
  }
  const echoed = last || grouped ? undefined : echoedText(previous);
  return echoed === undefined ? { bodies: [], unreadable: true } : { bodies: [echoed], unreadable: false };
}

// gh の真偽のフラグ（--rebase、--force）が付いているか。--flag=false で打ち消したものは付いていない
const ghFlagOn = (args, name) => args.some((a) => a === name || (a.startsWith(`${name}=`) && !/^(?:false|0|f|F|FALSE|False)$/.test(a.slice(name.length + 1))));

// gh api の値を取るフラグ（gh 2.103.3 の gh api --help）。別のフラグの値の位置にある語（--preview -XGET の -XGET）は値として飛ばす
const GH_API_LONG_WITH_VALUE = { method: 'method', header: 'header', field: 'field', 'raw-field': 'field', input: 'input', jq: 'jq', template: 'template', preview: 'preview', hostname: 'hostname', cache: 'cache' };
const GH_API_SHORT_WITH_VALUE = { X: 'method', H: 'header', f: 'field', F: 'field', q: 'jq', t: 'template', p: 'preview' };

// gh api の引数を一度だけ読み、{ methods, fields, input, positionals } にする。
// pflag は真偽の短いフラグと値を取る短いフラグをまとめ（-iXPATCH、-iFforce=true）、値を取る短いフラグの直後の = は区切りとして外す（-F=k=v）
function readGhApi(args) {
  const read = { methods: [], fields: [], inputs: [], positionals: [], opaqueQuery: false };
  // at は値のある語の位置。query のフィールド（名前が展開で決まるものも）の語に展開があれば、query を字面で読めない
  const take = (name, value, at) => {
    if (name === 'method') read.methods.push(value);
    else if (name === 'field') {
      read.fields.push(value);
      const key = value.split('=')[0];
      if ((key === 'query' || hasExpansion(key)) && shapeAt(args, at).includes(DYNAMIC)) read.opaqueQuery = true;
    } else if (name === 'input') read.inputs.push(value);
  };
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (options && a === '--') options = false;
    else if (options && a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = GH_API_LONG_WITH_VALUE[a.slice(2, eq === -1 ? undefined : eq)];
      if (name && eq !== -1) take(name, a.slice(eq + 1), i);
      else if (name && i + 1 < args.length) take(name, args[++i], i);
    } else if (options && /^-[^-]/.test(a)) {
      for (let k = 1; k < a.length; k++) {
        const name = GH_API_SHORT_WITH_VALUE[a[k]];
        if (!name) continue;
        const attached = a.slice(k + 1);
        if (attached) take(name, attached.startsWith('=') ? attached.slice(1) : attached, i);
        else if (i + 1 < args.length) take(name, args[++i], i);
        break;
      }
    } else read.positionals.push(a);
  }
  return read;
}

function judgeGh(args, stdinContext) {
  const pos = positionals(
    args,
    new Set(['-R', '--repo', '-X', '--method', '-H', '--header', '-f', '-F', '--field', '--raw-field', '--input', '--jq', '-q', '--template', '-t', '--hostname', '--cache', '-p', '--preview']),
  );
  // 人が指示したときだけ、gh pr merge でマージする。needs-human のラベルはフックから見えないので、確認で人に委ねる
  if (pos[0] === 'pr' && pos[1] === 'merge') {
    // --auto は確認の後に条件がそろった時点でマージし、--admin は条件を飛ばす
    if (args.some((a) => /^--(auto|admin)(=|$)/.test(a))) return [DENY, 'gh pr merge の --auto と --admin は使わない'];
    // 確かめた後に push された head をマージしないよう、確かめた head を固定させる
    if (!args.some((a) => /^--match-head-commit(=.|$)/.test(a))) {
      return [DENY, 'gh pr merge には --match-head-commit <確かめた head> を付ける'];
    }
    return [ASK, `${MERGE_REASON}。needs-human の PR と label が成功していない PR は人がマージする`];
  }
  // エイリアスは中身のサブコマンドをフックから隠す（gh alias set m 'pr merge --auto' の後の gh m）
  if (pos[0] === 'alias' && ['set', 'import'].includes(pos[1])) return [DENY, 'gh のエイリアスはフックから中身が見えないので作らない'];
  if (pos[0] === 'stack' && pos[1] === 'merge') return [DENY, 'スタック PR は原則使わない。マージは gh pr merge で1本ずつ行う'];
  if (pos[0] === 'stack' && ['push', 'sync', 'submit', 'rebase'].includes(pos[1])) {
    return [ASK, `gh stack ${pos[1]} は force push を伴う。スタック PR は原則使わない（docs/development.md の「並行して作業するときの決まり」）`];
  }
  // GitHub の側で PR のブランチを rebase で書き換え、force の更新と同じになる。付けない更新は merge のコミットを足す通常の更新
  if (pos[0] === 'pr' && pos[1] === 'update-branch' && ghFlagOn(args, '--rebase')) {
    return [DENY, `gh pr update-branch --rebase は GitHub の側で head を書き換え、force push と同じになる。--rebase を付けずに merge で更新する。${FORCE_PUSH_REASON}`];
  }
  // 宛先のブランチを hard reset する。付けない同期は fast-forward だけ
  if (pos[0] === 'repo' && pos[1] === 'sync' && ghFlagOn(args, '--force')) {
    return [DENY, `gh repo sync --force は GitHub の側で宛先のブランチを hard reset する。${FORCE_PUSH_REASON}`];
  }
  if (pos[0] === 'api') {
    const { methods, fields, inputs, positionals: apiPositionals, opaqueQuery } = readGhApi(args);
    // フィールドか --input があれば、メソッドの既定は POST。重ねたメソッドは最後の値が効く
    const method = methodOf(methods.at(-1), fields.length > 0 || inputs.length > 0 ? 'POST' : 'GET');
    const input = inputs.at(-1);
    // --input <ファイル> は中身を読めない
    const body = input === '-' ? stdinBody(args, stdinContext) : { bodies: [], unreadable: input !== undefined };
    return judgeGitHubWrite(args, method, { endpoints: apiPositionals.slice(apiPositionals.indexOf('api') + 1), fields, opaqueQuery, ...body });
  }
  return null;
}

// curl の値を取る短いフラグ。まとめた形（-sXPATCH、-sd）では、最初に出る値を取るフラグ以降が値（語の最後なら次の語）
const CURL_SHORT_WITH_VALUE = 'XdHFTouAebcwmrxyYzKECDPQtU';
// 値を取る長いオプション（curl の man の一覧）。値の位置の語（--user-agent -XGET の -XGET）を別のオプションに読まないために使う
const CURL_LONG_WITH_VALUE = new Set(
  (
    'request data data-raw data-binary data-ascii data-urlencode json upload-file form form-string header user-agent referer user proxy proxy-user cookie cookie-jar ' +
    'output write-out max-time connect-timeout retry retry-delay retry-max-time resolve connect-to cacert capath cert key config dump-header range time-cond limit-rate ' +
    'oauth2-bearer url url-query request-target interface local-port proxy-header quote telnet-option trace trace-ascii variable'
  ).split(' '),
);
// 値を取らず、判定に使うフラグ。-G（--get）は本文を URL の query にして GET に、-g（--globoff）は URL の {} と [] を展開しない
const CURL_FLAGS = new Set(['get', 'globoff']);
const CURL_SHORT_FLAGS = { G: '--get', g: '--globoff' };
const CURL_LONG_ALIASES = { request: '-X', data: '-d', 'upload-file': '-T', form: '-F' };
// --expand-<名前> は <名前> と同じで、値の {{変数}} を --variable で差し込む
const CURL_EXPANDABLE = new Set(['data', 'data-raw', 'data-binary', 'data-urlencode', 'json', 'url', 'request-target']);
// curl の要求ごとの { options, urls }。--next と -: で区切ると、後ろのオプションは次の要求にだけ効く。
// options は { name, value, at, expand } で、name は -X のような短い形か --data-raw のような長い形（別名と --expand- はここで寄せる）、
// at は値のある語の位置、expand は --expand- の形か。
// urls は位置の語（スキームの無い api.github.com/… も curl は URL に読む）と、URL と path を決めるオプション（--url、--request-target）の値。
// -H 'Host: api.github.com' のような値は含まない
function curlRequests(args) {
  const requests = [{ options: [], urls: [] }];
  const add = (name, value, at, expand = false) => {
    const request = requests.at(-1);
    request.options.push({ name, value, at, expand });
    if (name === '--url' || name === '--request-target') request.urls.push(value);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--next') requests.push({ options: [], urls: [] });
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const written = a.slice(2, eq === -1 ? undefined : eq);
      const expand = written.startsWith('expand-') && CURL_EXPANDABLE.has(written.slice(7));
      const name = expand ? written.slice(7) : written;
      const canonical = CURL_LONG_ALIASES[name] ?? `--${name}`;
      if (eq !== -1) add(canonical, a.slice(eq + 1), i, expand);
      else if (CURL_LONG_WITH_VALUE.has(name) && i + 1 < args.length) add(canonical, args[++i], i, expand);
      else if (CURL_FLAGS.has(name)) add(canonical, '', i);
    } else if (/^-[^-]/.test(a)) {
      for (let k = 1; k < a.length; k++) {
        if (a[k] === ':') requests.push({ options: [], urls: [] });
        else if (a[k] in CURL_SHORT_FLAGS) add(CURL_SHORT_FLAGS[a[k]], '', i);
        else if (CURL_SHORT_WITH_VALUE.includes(a[k])) {
          if (k + 1 < a.length) add(`-${a[k]}`, a.slice(k + 1), i);
          else add(`-${a[k]}`, args[i + 1] ?? '', ++i);
          break;
        }
      }
    } else if (a !== '-') requests.at(-1).urls.push(a);
  }
  return requests;
}

// curl の本文。-d と --data*、--json、-T の値で、@ファイルは中身が読めず、@- と -T - は標準入力（--data-raw の @ は文字）。
// --json を重ねると値は間に何も挟まずつながる。--expand- の値に {{ があれば、差し込む値を読めない
const CURL_BODY_OPTIONS = ['-d', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '--json', '-T'];
function curlBody(options, args, stdinContext) {
  const bodies = [];
  const json = [];
  let unreadable = false;
  let stdin = false;
  for (const { name, value, at, expand } of options.filter(({ name }) => CURL_BODY_OPTIONS.includes(name))) {
    const literal = !shapeAt(args, at).includes(DYNAMIC);
    if (value === '@-' || (name === '-T' && value === '-')) stdin = true;
    else if (name === '-T' || (name !== '--data-raw' && value.startsWith('@'))) unreadable = true;
    else if (expand && value.includes('{{')) unreadable = true;
    else if (name === '--json') json.push({ text: value, literal });
    else bodies.push({ text: value, literal });
  }
  if (json.length > 0) bodies.push({ text: json.map(({ text }) => text).join(''), literal: json.every(({ literal }) => literal) });
  if (stdin) {
    const body = stdinBody(args, stdinContext);
    bodies.push(...body.bodies);
    unreadable ||= body.unreadable;
  }
  // -F query=… の query が展開で決まる（名前が展開で決まる形も）
  const opaqueQuery = options.some(({ name, value, at }) => name === '-F' && (value.startsWith('query=') || hasExpansion(value.split('=')[0])) && shapeAt(args, at).includes(DYNAMIC));
  return { bodies, unreadable, opaqueQuery };
}

function judgeHttpClient(tool, args, stdinContext) {
  // URL のホストは大文字と小文字を区別しない。Host ヘッダーに書いて IP 宛てに送る形もあるので、語のどこかにあれば判定する
  const mentionsGitHub = args.some((a) => a.toLowerCase().includes('api.github.com'));
  if (!mentionsGitHub) return null;
  if (tool === 'curl') {
    // --next と -: で区切った要求ごとに判定し、どれかが止めるなら止める
    const verdicts = curlRequests(args).map(({ options, urls }) => {
      const sendsBody = options.some(({ name }) => CURL_BODY_OPTIONS.includes(name) || name === '-F');
      // -G は本文を URL の query にして GET にする（-X を付ければ -X が効く）
      const method = methodOf(options.findLast(({ name }) => name === '-X')?.value, options.some(({ name }) => name === '--get') ? 'GET' : sendsBody ? 'POST' : 'GET');
      // 展開や {{変数}} を含む URL のうち、展開より前の字面で資源の種類が決まらないものと、URL の語が無い要求は、
      // 決まる先を確定できないので語のぜんたいを path として見る
      const undecided = urls.length === 0 || urls.some((u) => isDynamic(u) && !resourceKnown(u));
      const verdict = judgeGitHubWrite(args, method, { endpoints: undecided ? [...urls, ...args] : urls, ...curlBody(options, args, stdinContext) });
      // curl は URL の {} と [] を展開して複数の要求にする（merg[e-e] は merge）。-g を付けない GET 以外は、送る先を字面で確かめられない
      const globs = urls.some((u) => /[{[]/.test(u)) && !options.some(({ name }) => name === '--globoff');
      return verdict ?? (globs && method !== 'GET' ? [ASK, 'curl は URL の {} と [] を展開して複数の要求にするので、送る先を判定できない。-g を付けるか、URL を字面で書く。人が確かめる'] : null);
    });
    return verdicts.find((v) => v?.[0] === DENY) ?? verdicts.find((v) => v?.[0] === ASK) ?? null;
  }
  const endpoints = args.filter((a) => a.toLowerCase().includes('api.github.com'));
  if (tool === 'wget') {
    // --method が無ければ GET（--post-data と --post-file を付ければ POST）
    const at = args.findIndex((a) => a === '--method' || a.startsWith('--method='));
    const value = at === -1 ? undefined : args[at].includes('=') ? args[at].slice(args[at].indexOf('=') + 1) : args[at + 1];
    return judgeGitHubWrite(args, methodOf(value, args.some((a) => a.startsWith('--post-')) ? 'POST' : 'GET'), { endpoints });
  }
  // httpie: http PUT https://...
  return judgeGitHubWrite(args, args.find((a) => /^[A-Z]+$/.test(a)) ?? 'GET', { endpoints });
}

// 値を取るフラグ。findWrangler が依存の情報を見るサブコマンドを探すときに使う。スクリプトの読み取りは道具ごとの表（PACKAGE_MANAGERS の flags）で読む
const PACKAGE_FLAGS_WITH_VALUE = new Set(['-C', '--dir', '--filter', '-F', '--prefix', '--cwd', '--workspace']);
const DEPLOY_SCRIPT = /(^|[:_-])deploy([:_-]|$)/;

const SCRIPT_ARGS_EXPAND_REASON = 'スクリプトの後ろの引数に変数、$(...)、glob があると、本体の末尾に足して実行される中身を判定できない';
const PACKAGE_CHANGE_REASON = '依存の変更は needs-human の領域。足す理由と代わりの手を確かめてから進める';
const UNKNOWN_PACKAGE_REASON =
  'スクリプトを走らせる場所（cd ~、-C や --prefix の変数の先）か、その場所の package.json を判定できず、走るスクリプトの中身を判定できない。人が確かめる';
const NAME_EXPANDS_REASON = 'スクリプトやコマンドの名前を変数、$(...)、glob で渡すと、何を実行するかを判定できない。人が確かめる';
const NPM_UNKNOWN_REASON = 'npm のコマンドの表（cmd-list の deref）で引けない名前は、版が上がって増えたコマンドかもしれず、何を実行するかを判定できない。人が確かめる';
const MANY_READINGS_REASON = '表に無いフラグの次の語を値とも名前とも読むと、読み方が 8 通りを超え、どのスクリプトを走らせるかを判定しきれない。人が確かめる';
const UNREADABLE_FLAG_REASON =
  '短いフラグのまとめ（npm -Cls、pnpm -xC）の中の、場所かシェルの文字列を取るフラグを道具がどう読むかを判定できない。人が確かめる';
const DEEP_REASON = 'コマンドの入れ子が深く、判定しきれない';

// 組み込みのコマンドの名前から正規の名前を引く表。plain は別名の無いコマンド、aliased は { 正規の名前: '別名 …' }
function commandTable(plain, aliased = {}) {
  const table = new Map(plain.split(' ').map((name) => [name, name]));
  for (const [name, aliases] of Object.entries(aliased)) for (const alias of [name, ...aliases.split(' ')]) table.set(alias, name);
  return table;
}

// pnpm 12.12.0 の pnpm --help の組み込みのコマンドと別名で確かめた（2026-10-27）。rum と te は別名ではない
const PNPM_COMMANDS = commandTable(
  'access init add outdated audit change version lane why sbom whoami deprecate undeprecate unpublish star unstar stars ping doctor ' +
    'rebuild rb pack publish stage patch patch-commit patch-remove peers tasks pipeline exec dlx create completion start stop restart ' +
    'find-hash env shim bin clean purge root prefix get set pkg pack-app store cache cat-file cat-index ignored-builds approve-builds ' +
    'permissions approve import dedupe deploy prune fetch repo self-update setup team logout with edit profile token xmas help',
  {
    recursive: 'multi m', install: 'i', 'install-test': 'it', update: 'up upgrade', bugs: 'issues', list: 'ls', ll: 'la',
    licenses: 'licences', view: 'info show v', 'dist-tag': 'dist-tags', search: 's se find', remove: 'uninstall rm un uni',
    'set-script': 'ss', test: 't tst', run: 'run-script', ci: 'clean-install ic install-clean', runtime: 'rt', config: 'c',
    link: 'ln', unlink: 'dislink', docs: 'home', login: 'adduser', owner: 'owners',
  },
);

// bun 1.4.4 の bun --help の組み込みのコマンドと別名で確かめた（2026-10-27）。bun test は bun の実行器だが、test のスクリプトとして見る
const BUN_COMMANDS = commandTable(
  'run test check fmt x repl exec update audit dedupe prune outdated link unlink publish patch pm info why build init upgrade',
  { install: 'i', add: 'a', remove: 'rm', create: 'c' },
);

// yarn 1.22.22 の yarn --help の組み込みのコマンドで確かめた（2026-10-27）。
// dlx と up は Berry のコマンドで、今の判定（dlx は経由、up は依存の変更）のまま読む
const YARN_COMMANDS = commandTable(
  'access add audit autoclean bin cache check config create exec generate-lock-entry generateLockEntry global help import info init ' +
    'install licenses link list login logout node outdated owner pack policies publish remove run tag team unlink unplug upgrade ' +
    'upgrade-interactive upgradeInteractive version versions why workspace workspaces dlx up',
);

// npm 11.20.0 の lib/utils/cmd-list.js の commands と aliases で確かめた（2026-10-27）
const NPM_COMMANDS = [
  'access', 'adduser', 'approve-scripts', 'audit', 'bugs', 'cache', 'ci', 'completion', 'config', 'dedupe', 'deny-scripts',
  'deprecate', 'diff', 'dist-tag', 'docs', 'doctor', 'edit', 'exec', 'explain', 'explore', 'find-dupes', 'fund', 'get', 'help',
  'help-search', 'init', 'install', 'install-ci-test', 'install-scripts', 'install-test', 'link', 'll', 'login', 'logout', 'ls',
  'org', 'outdated', 'owner', 'pack', 'ping', 'pkg', 'prefix', 'profile', 'prune', 'publish', 'query', 'rebuild', 'repo',
  'restart', 'root', 'run', 'sbom', 'search', 'set', 'shrinkwrap', 'stage', 'star', 'stars', 'start', 'stop', 'team', 'test',
  'token', 'trust', 'undeprecate', 'uninstall', 'unpublish', 'unstar', 'update', 'version', 'view', 'whoami',
];
const NPM_ALIASES = {
  author: 'owner', home: 'docs', issues: 'bugs', info: 'view', show: 'view', find: 'search', add: 'install', unlink: 'uninstall',
  remove: 'uninstall', rm: 'uninstall', r: 'uninstall', un: 'uninstall', rb: 'rebuild', list: 'ls', ln: 'link', create: 'init',
  i: 'install', it: 'install-test', cit: 'install-ci-test', u: 'update', up: 'update', c: 'config', s: 'search', se: 'search',
  tst: 'test', t: 'test', ddp: 'dedupe', v: 'view', 'run-script': 'run', 'clean-install': 'ci', 'clean-install-test': 'install-ci-test',
  x: 'exec', why: 'explain', la: 'll', verison: 'version', ic: 'ci', innit: 'init', in: 'install', ins: 'install', inst: 'install',
  insta: 'install', instal: 'install', isnt: 'install', isnta: 'install', isntal: 'install', isntall: 'install', 'install-clean': 'ci',
  'isntall-clean': 'ci', hlep: 'help', 'dist-tags': 'dist-tag', upgrade: 'update', udpate: 'update', rum: 'run',
  sit: 'install-ci-test', urn: 'run', ogr: 'org', 'add-user': 'adduser',
};
const NPM_NAMES = [...NPM_COMMANDS, ...Object.keys(NPM_ALIASES)];

// cmd-list.js の deref と同じ順で引く。キャメルケースをケバブに直し（runScript は run-script）、commands に完全一致、aliases、
// commands と aliases の一意な前置き（tes、run-scr、exe）の順。前置きで引いた別名は辿る（install-cl は install-clean から ci）。
// 引けなければ undefined
function derefNpm(word) {
  const c = word.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
  if (NPM_COMMANDS.includes(c)) return c;
  if (Object.hasOwn(NPM_ALIASES, c)) return NPM_ALIASES[c];
  const matches = c ? NPM_NAMES.filter((name) => name.startsWith(c)) : [];
  let found = matches.length === 1 ? matches[0] : undefined;
  while (found !== undefined && Object.hasOwn(NPM_ALIASES, found)) found = NPM_ALIASES[found];
  return found;
}

// npm 11.20.0 の @npmcli/config の設定の名前のうち c と p で始まるもの（2026-10-27）。nopt は長いフラグを、設定の名前の一意な前置きでも引く
// （--prefi は --prefix、--cal は --call。--ca は ca の設定そのもの、--pre は prefer-online などとも当たるので前置きにならない）
const NPM_CONFIG_NAMES_CP = [
  'ca', 'cache', 'cache-max', 'cache-min', 'cafile', 'call', 'cert', 'cidr', 'color', 'commit-hooks', 'cpu', 'package', 'package-lock',
  'package-lock-only', 'pack-destination', 'packages', 'parseable', 'prefer-dedupe', 'prefer-offline', 'prefer-online', 'prefix', 'preid',
  'production', 'progress', 'provenance', 'provenance-file', 'proxy', 'packages-all', 'packages-and-scopes-permission', 'password',
];
function npmLongName(flag) {
  const name = flag.slice(2);
  if (!/^--[cp]/.test(flag) || NPM_CONFIG_NAMES_CP.includes(name)) return flag;
  const matches = NPM_CONFIG_NAMES_CP.filter((n) => n.startsWith(name));
  return matches.length === 1 ? `--${matches[0]}` : flag;
}

// フラグの種類。dir は package.json を探す場所、call は npm のシェルの文字列（値を取る）、shell は pnpm の shell-mode（値を取らない）、
// value はほかの値を取るフラグ、flag は値を取らないフラグ。表に無いフラグは、次の語を値と読む形と読まない形の両方で見る。
// 道具をまたいで1つの表にすると、bun の --dir や npm の --filter（値を取らない）の次の語を値と取り違える
// pnpm 12.12.0 の pnpm --help と pnpm exec --help の短いフラグ（C と F は値を取る。c は exec の --shell-mode で、exec の前にも置ける）。
// clap はまとめた短いフラグを前から読み、値を取るフラグの後ろの残り（無ければ次の語）を値にする（-yC sub、-yCsub、-rc）
const PNPM_SHORT = { C: 'dir', F: 'value', c: 'shell', v: 'flag', y: 'flag', r: 'flag', w: 'flag', h: 'flag' };
// npm 11.20.0 の @npmcli/config の shorthands の1文字のもの（C は --prefix、c は --call、w は --workspace、L は --location、m は --message）。
// nopt はまとめた短いフラグを1文字ずつ広げ、最後のフラグが値を取るなら次の語を値にする（-sC ls）
const NPM_SHORT = {
  C: 'dir', c: 'call', w: 'value', L: 'value', m: 'value',
  ...Object.fromEntries([...'dqsnafglpSBDEOP?Hhvy'].map((c) => [c, 'flag'])),
};
// 経由先のコマンドの前で値を取るフラグ（pnpm dlx --package x、npm exec --package x）
const EXEC_FLAGS_WITH_VALUE = new Set(['-p', '--package']);

// 道具ごとの読み方。commandOf は組み込みのコマンドの正規の名前（無ければ undefined）、flags は長いフラグと短いフラグ1つの表、
// short と shortStyle は短いフラグのまとめの読み方（clap か nopt）、longName は長いフラグの前置きを正規の名前に直す関数、
// strings は - で始まる次の語を値に取らないフラグ（skipsFlagValue）、
// dirAnywhere は名前の後ろの場所のフラグもいつも読むか（npm だけ。pnpm、yarn、bun はスクリプトの名前の後ろのフラグをスクリプトに渡すが、
// 組み込みのコマンドの後ろのものは読む）、exec は後ろを経由先のコマンドとして動かすコマンド、shell は後ろの文字列をシェルで動かすコマンド、
// changes は依存を変えるコマンド、runsMissing は組み込みにもスクリプトにも無い名前を PATH のコマンドとして動かすか、
// unknownAsks は組み込みに無い名前を確認に回すか（npm は無い名前を実行せずにエラーにする）、installScripts はパッケージを渡さない install と
// ci が走らせるライフサイクルのスクリプト、bareInstall は名前の無い形を install として動かすか（yarn）、linkInstalls は引数の無い link が
// install と同じライフサイクルを走らせるか（npm）。
// 場所のフラグ（flags と short の dir）は、pnpm 12.12.0 の -C、--dir、--prefix、npm 11.20.0 の -C、--prefix（-C<dir> の連結の形は効かない）、
// yarn 1.22.22 と bun 1.4.4 の --cwd が package.json を探す場所を変えることを、中身を echo にした package.json で確かめた（2026-10-27）
const PACKAGE_MANAGERS = {
  pnpm: {
    commandOf: (word) => PNPM_COMMANDS.get(word),
    // 今の表（PACKAGE_FLAGS_WITH_VALUE）のうち、場所のフラグ以外も値を取るものとして読む
    flags: {
      '--dir': 'dir', '--prefix': 'dir', '--filter': 'value', '--cwd': 'value', '--workspace': 'value', '--shell-mode': 'shell',
    },
    short: PNPM_SHORT,
    shortStyle: 'clap',
    exec: ['exec', 'dlx'],
    changes: ['add', 'remove', 'update'],
    runsMissing: true,
    installScripts: ['pnpm:devPreinstall', 'install', 'prepare'],
  },
  npm: {
    commandOf: derefNpm,
    flags: { '--prefix': 'dir', '--call': 'call', '--workspace': 'value' },
    short: NPM_SHORT,
    shortStyle: 'nopt',
    longName: npmLongName,
    strings: new Set(['--call', '-c', '--message', '-m']),
    calls: true,
    dirAnywhere: true,
    exec: ['exec'],
    changes: ['uninstall', 'update'],
    unknownAsks: true,
    installScripts: ['install', 'prepare', 'prepublish'],
    linkInstalls: true,
  },
  yarn: {
    commandOf: (word) => YARN_COMMANDS.get(word),
    flags: { '--cwd': 'dir' },
    exec: ['exec', 'dlx'],
    changes: ['add', 'remove', 'up', 'upgrade'],
    installScripts: ['install', 'prepare', 'prepublish'],
    bareInstall: true,
  },
  bun: {
    commandOf: (word) => BUN_COMMANDS.get(word),
    flags: {
      '--cwd': 'dir', '--filter': 'value', '-F': 'value',
      // 本文と読み込むモジュールを取るフラグ。本文は judgeInterpreterBody が見る
      ...Object.fromEntries(['-e', '--eval', '-p', '--print', '-r', '--preload', '--require', '--import'].map((f) => [f, 'value'])),
    },
    exec: ['x'],
    shell: ['exec'],
    changes: ['add', 'remove', 'update', 'upgrade'],
    runsMissing: true,
    installScripts: ['install', 'prepare'],
  },
};
// yarnpkg は yarn のパッケージのもう1つの bin（yarn 1.22 と corepack 0.34 の bin で確かめた）
const PACKAGE_MANAGER_BINS = { yarnpkg: 'yarn' };
const managerOf = (word) => {
  const name = baseName(word);
  if (Object.hasOwn(PACKAGE_MANAGER_BINS, name)) return PACKAGE_MANAGER_BINS[name];
  return Object.hasOwn(PACKAGE_MANAGERS, name) ? name : undefined;
};

// 組み込みのコマンドのうち、スクリプトを走らせるもの。値は走らせるスクリプトの名前で、それぞれ pre と post も走る。
// restart は restart、stop、start を走らせる（npm は restart が無ければ stop と start）
const SCRIPT_COMMANDS = { test: ['test'], start: ['start'], stop: ['stop'], restart: ['restart', 'stop', 'start'] };
// 名前の後ろのフラグをスクリプトに渡すコマンド（pnpm test -C sub は今の場所の test に -C sub を足す）。restart は組み込みとして場所を読む
const PASSES_FLAGS = new Set(['test', 'start', 'stop']);
// pack と publish が走らせるライフサイクルのスクリプト（npm 11.20 と pnpm 12.12 の pack で prepack と prepare、npm の publish で prepublishOnly も
// 走ることを確かめた）。それぞれ pre と post も見るので、postpack と postpublish も入る
const PACK_SCRIPTS = ['prepack', 'prepare', 'postpack'];
const PUBLISH_SCRIPTS = ['prepublishOnly', ...PACK_SCRIPTS, 'publish'];
// 名前の後ろにパッケージを渡すと依存を足すコマンド。パッケージの無い install はロックファイルどおりに入れるだけ
const INSTALLS_PACKAGE = new Set(['install', 'add']);
// 表に無いフラグの読み方の上限。超えたら判定せずに確認を挟む
const MAX_READINGS = 8;

// i 番目の語（- で始まる）を道具の表で読み、{ end, dir, attachedDir, call, shell, unknown, unreadable } を返す。end はフラグの最後の語の位置。
// dir、attachedDir、call は { value, valueAt }。attachedDir は npm の -C<dir> の連結の形（npm 11.20 は今の場所で動かすが、版の違いを避けて
// 連結の先でも判定する）、unknown は表に無いフラグ、unreadable はまとめの途中の場所か call のフラグ（npm -Cls）。
// exec が true のとき（経由先のコマンドの前）は --package と -p も値を取るものとして読む
// spec.strings は nopt の型が String だけの npm のフラグ（--call、--message と短い形）。nopt はその次の語が -x、--x か -- なら値に取らず、
// 値を空にして次の語をフラグとして読む（nopt-lib.js の isTypeDef(argType, StringType) の枝。npm exec -m -c '…' の -c は --call）。
// --prefix（path）、--workspace（String と Array）、--location（列挙）は - で始まる次の語も値に取るので当たらない
function skipsFlagValue(spec, name, next) {
  return Boolean(spec.strings?.has(name)) && next !== undefined && /^(-{1,2}[^-]|-{2,}$)/.test(next);
}

function readFlag(spec, args, i, exec = false) {
  const a = args[i];
  const eq = a.indexOf('=');
  const raw = eq === -1 ? a : a.slice(0, eq);
  const long = raw.startsWith('--');
  const name = long && spec.longName ? spec.longName(raw) : raw;
  const kind = exec && EXEC_FLAGS_WITH_VALUE.has(raw) ? 'value' : (spec.flags[name] ?? (raw.length === 2 && !long ? spec.short?.[raw[1]] : undefined));
  if (kind === 'shell' || kind === 'flag') return { end: i, shell: kind === 'shell' };
  if (kind) {
    if (eq === -1 && skipsFlagValue(spec, name, args[i + 1])) return { end: i, ...(kind === 'value' ? {} : { [kind]: { value: '', valueAt: i } }) };
    const value = eq === -1 ? { value: args[i + 1], valueAt: i + 1 } : { value: a.slice(eq + 1), valueAt: i };
    return { end: eq === -1 ? i + 1 : i, [kind]: value };
  }
  if (eq !== -1) return { end: i };
  if (!long && raw.length > 2 && spec.short) return shortFlags(spec, args, i);
  return { end: i, unknown: true };
}

// 短いフラグのまとめ（-yC sub、-sC ls）を読む
function shortFlags(spec, args, i) {
  const chars = args[i].slice(1);
  const valueOf = (rest) => (rest ? { end: i, value: { value: rest, valueAt: i } } : { end: i + 1, value: { value: args[i + 1], valueAt: i + 1 } });
  const isTarget = (c) => ['dir', 'call', 'shell'].includes(spec.short[c]);
  if (spec.shortStyle === 'clap') {
    let shell = false;
    for (let k = 0; k < chars.length; k++) {
      const kind = spec.short[chars[k]];
      // 表に無い文字が値を取るかもしれず、その後ろの C や c をどう読むかが分からない
      if (!kind) return [...chars.slice(k + 1)].some(isTarget) ? { end: i, unreadable: true } : { end: i, unknown: true };
      if (kind === 'shell') shell = true;
      if (kind === 'dir' || kind === 'value') {
        const { end, value } = valueOf(chars.slice(k + 1));
        return { end, shell, ...(kind === 'dir' ? { dir: value } : {}) };
      }
    }
    return { end: i, shell };
  }
  if (![...chars].every((c) => Object.hasOwn(spec.short, c))) {
    // -C.. や -Cnode_modules/zod は、1文字ずつに広げられないので連結の形として読む
    if (chars[0] === 'C') return { end: i, attachedDir: { value: chars.slice(1), valueAt: i } };
    if (chars[0] === 'c') return { end: i, call: { value: chars.slice(1), valueAt: i } };
    return { end: i, unknown: true };
  }
  const last = chars.at(-1);
  if ([...chars.slice(0, -1)].some(isTarget)) return { end: i, unreadable: true };
  if (spec.short[last] === 'flag') return { end: i };
  if (skipsFlagValue(spec, `-${last}`, args[i + 1])) return { end: i, ...(spec.short[last] === 'call' ? { call: { value: '', valueAt: i } } : {}) };
  const { end, value } = valueOf('');
  return { end, ...(spec.short[last] === 'dir' ? { dir: value } : spec.short[last] === 'call' ? { call: value } : {}) };
}

// 場所は { dir, place } で持つ。dir は package.json を探す作業場所（判定できなければ null）、place は書かれた行き先
// （cd .claude の .claude。作業場所が分からなくても字面をつないで追い、守る先の判定に使う。判定できなければ null）。
// 場所のフラグの値で base から移った場所を返す。~ か $ で始まる値と、展開の印のある値（sr?、{a,b}、"src$X"。= の形と連結の形は語ぜんたいで見る）は
// どちらも判定できない（null）とする（pnpm -C .claude exec rm -rf hooks の place は .claude）。
// 絶対パスの値は、dirAfterEnv と同じく base が分からなくても行き先にする（popd; pnpm -C /repo/.claude exec rm -rf hooks）
function moved(base, words, { value, valueAt }) {
  const unknown = !value || /^[~$]/.test(value) || isUnresolved(words, valueAt);
  if (!unknown && path.posix.isAbsolute(value)) return { dir: path.resolve(value), place: value };
  return {
    dir: !base.dir || unknown ? null : path.resolve(base.dir, value),
    place: base.place == null || unknown ? null : path.posix.isAbsolute(value) ? value : path.posix.join(base.place, value),
  };
}
const UNKNOWN_PLACE = { dir: null, place: null };

// from から後ろ（-- の前まで）の場所のフラグを読み、package.json を探す場所の候補を返す。後ろのものが勝つ。場所のフラグが無ければ undefined。
// npm は名前の後ろの -C と --prefix も読み（npm test --prefix sub）、pnpm、yarn、bun も組み込みのコマンドの後ろのものは読む
// （pnpm install -C sub、bun install --cwd sub、yarn install --cwd sub）。npm の連結の形は今の場所と連結の先の両方を候補にし、
// まとめの途中の場所のフラグ（npm -Cls）は場所が分からないとする。base は道具を打った場所
function dirAnywhere(spec, args, from, base) {
  let locs;
  for (let i = from; i < args.length && args[i] !== '--'; i++) {
    if (!args[i].startsWith('-')) continue;
    const flag = readFlag(spec, args, i);
    if (flag.dir) locs = [moved(base, args, flag.dir)];
    else if (flag.attachedDir) locs = [...(locs ?? [base]), moved(base, args, flag.attachedDir)];
    else if (flag.unreadable) locs = [UNKNOWN_PLACE];
    i = flag.end;
  }
  return locs;
}

// 道具の前の npm_config_prefix=（npm は大文字小文字を区別しないので NPM_CONFIG_PREFIX も）の値の場所。
// npm 11.20 ではスクリプトの場所を変えないことを確かめたが、版による違いを追わず、元の場所と両方で判定する
function configuredDirs(prefix, base) {
  return prefix.flatMap((w, i) => {
    const value = /^npm_config_prefix=([\s\S]+)$/i.exec(w)?.[1];
    return value === undefined ? [] : [moved(base, prefix, { value, valueAt: i })];
  });
}

// args の from から、名前より前のフラグを道具の表で読み、{ readings } か { reason }（判定しきれない理由）を返す。
// readings は { at, dir, place, shell }（名前の位置、package.json を探す場所と書かれた行き先、pnpm の shell-mode が付いたか。
// 名前が無ければ at は -1）の並び。loc は読み始めの場所、base は道具を打った場所（場所のフラグの値はここから解決する）。
// 表に無いフラグ（= の無い形）の次の語は、値と読む形と名前と読む形の両方を返す（pnpm --loglevel error test は error も test も名前に取る）。
// 読み方が MAX_READINGS を超えるか、短いフラグのまとめを読めなければ reason を返す。
// exec が true のとき（経由先のコマンドの前）は、-- の次の語を名前に取る（pnpm exec -c -- '…'）
function nameReadings(spec, args, from, loc, base, { exec = false, shell = false } = {}) {
  const readings = [];
  let unreadable = false;
  const walk = (start, loc, shell) => {
    for (let i = start; i < args.length && readings.length <= MAX_READINGS; i++) {
      const a = args[i];
      if (a === '--') return void readings.push({ at: i + 1 < args.length ? i + 1 : -1, ...loc, shell });
      if (!a.startsWith('-') || a === '-') return void readings.push({ at: i, ...loc, shell });
      const flag = readFlag(spec, args, i, exec);
      unreadable ||= Boolean(flag.unreadable);
      // npm の場所は dirAnywhere が名前の後ろまで読んで決める
      // 重ねた場所のフラグは後ろが勝ち、前の値につながない（pnpm 12.12 は重ねるとエラー、npm、yarn、bun は後ろを打った場所から読む）
      if (flag.dir && !spec.dirAnywhere) loc = moved(base, args, flag.dir);
      shell ||= flag.shell;
      if (flag.unknown && i + 1 < args.length && !args[i + 1].startsWith('-')) walk(i + 2, loc, shell);
      i = flag.end;
    }
    readings.push({ at: -1, ...loc, shell });
  };
  walk(from, { dir: loc.dir, place: loc.place }, shell);
  if (unreadable) return { reason: UNREADABLE_FLAG_REASON };
  return readings.length > MAX_READINGS ? { reason: MANY_READINGS_REASON } : { readings };
}

// npm の --call、-c、--cal=…（前置き）の値。npm exec と npm x は、これをシェルの文字列として動かす（-- の前なら名前の前でも後ろでも効く）
function npmCalls(spec, args) {
  const calls = [];
  for (let i = 0; i < args.length && args[i] !== '--'; i++) {
    if (!args[i].startsWith('-')) continue;
    const flag = readFlag(spec, args, i);
    if (flag.unreadable) return null;
    if (flag.call) calls.push(flag.call.value ?? '');
    i = flag.end;
  }
  return calls;
}

// 道具の前の代入の npm_config_call=（npm は大文字小文字を区別しない）の値。npm exec、npm x、npx はこれをシェルの文字列として動かす
// （npm 11.20 で確かめた）。道具を問わず見る
function configuredCalls(words, ci) {
  return words.flatMap((w, i) => ((ci === -1 || i < ci) && isAssignment(w) ? (/^npm_config_call=([\s\S]+)$/i.exec(w)?.slice(1) ?? []) : []));
}

// パッケージマネージャー（pnpm、npm、yarn、bun。corepack の後ろも）のコマンドから、どのスクリプトとコマンドを、どの package.json から
// 走らせるかを読み、それぞれを同じ規則で判定する。prefix は道具の前の語（代入、env などの前置き）で、経由先に掛け直すときに付け直す。
// 判定の並びを返す
function judgePackageManager(manager, args, prefix, ctx) {
  const spec = PACKAGE_MANAGERS[manager];
  if (spec.shortStyle === 'nopt') {
    const argvs = noptArgvs(spec, args);
    if (argvs.length > MAX_READINGS) return [[ASK, MANY_READINGS_REASON]];
    if (argvs[0] !== args) return argvs.flatMap((argv) => judgeArgs(spec, argv, prefix, ctx));
  }
  return judgeArgs(spec, args, prefix, ctx);
}

// nopt（npm 11.20 の node_modules/nopt/lib/nopt-lib.js の parse と resolveShort）の読み方に合わせ、npm の語の並びを直したものを返す。
// 直すところが無ければ [args]。-- の前の語について次を直す（--- のような - だけの語も -- として読み終える）。
// - nopt は先頭の - を全部外して名前を引くので、- を2つ以上重ねた名前は、1文字なら短いフラグ（--c、---c は -c）、長い名前（all、ca、call）
//   でなく全部の文字が1文字のフラグなら短いフラグのまとめ（--sc は -sc）、ほかは長いフラグ（---call は --call）として読む。
//   まとめに読める名前が表のフラグの前置きにも当たれば（--cal）、nopt はまとめとして読むが、長いフラグとしての読み方も残す
// - nopt は = の形を2語に分けてから読むので、値が - で始まる語（--message=-c、-m=--call=…）は、値を取らないフラグか
//   String の型のフラグ（spec.strings）なら値をフラグとして読み直す。表の String でない値のフラグ（--prefix、-w、-L、-C）は値のまま、
//   表に無いフラグ（--tag、--mess）は型が分からないので両方で読む
// - nopt は String でも Boolean でもない型のフラグ（--prefix、-w、-L、-C、表に無い --otp、--userconfig）の次の語を、- で始まっても
//   値に取る（- だけの語を除く）。表の値のフラグの次の語は、= を含んでも分けずに値のまま残す（npm -L -y=-C test の -y=-C は -L の値）。
//   表に無いフラグの次の - で始まる語は、値に取る形（--otp=-C の1語につなぎ、後ろの読み方がフラグと取り違えないようにする）と
//   取らない形の両方で読む
// 読み方が MAX_READINGS を超えれば、そこで打ち切った並び（MAX_READINGS より多い）を返す
function noptArgvs(spec, args) {
  const done = [];
  let changed = false;
  // 読みかけの並び { argv, i }。分かれた並びも同じ語から1つずつ読むので、語の数に比例する手間で済む
  const queue = [{ argv: [], i: 0 }];
  const pieces = args.map((_, i) => sliceWords(args, i, i + 1));
  while (queue.length > 0) {
    if (done.length + queue.length > MAX_READINGS) return [...done, ...queue.map(({ argv }) => argv)];
    const { argv, i } = queue.shift();
    if (i >= args.length) {
      done.push(argv);
      continue;
    }
    const w = args[i];
    const piece = pieces[i];
    const next = args[i + 1];
    if (/^-{2,}$/.test(w)) {
      changed ||= w !== '--';
      done.push([...argv, ['--'], sliceWords(args, i + 1)]);
      continue;
    }
    if (!/^-./.test(w)) {
      queue.push({ argv: [...argv, piece], i: i + 1 });
      continue;
    }
    const eq = w.indexOf('=');
    const flag = eq === -1 ? w : w.slice(0, eq);
    const value = eq === -1 ? undefined : w.slice(eq + 1);
    for (const name of noptNames(spec, flag)) {
      const same = name === flag ? piece : [eq === -1 ? name : `${name}=${value}`];
      changed ||= same !== piece;
      const type = noptType(spec, name);
      if (value !== undefined) {
        // = の値が - で始まれば、値を取らないフラグと String の型のフラグは値をフラグとして読み直す
        const reread = /^-{1,2}[^-]/.test(value) && type !== 'value';
        if (reread) changed = true;
        if (reread) queue.push({ argv: [...argv, [name], [value]], i: i + 1 });
        if (!reread || type === 'unknown') queue.push({ argv: [...argv, same], i: i + 1 });
        continue;
      }
      const dashed = next !== undefined && next.startsWith('-') && !/^-{2,}$/.test(next);
      if (dashed && type === 'value') queue.push({ argv: [...argv, same, pieces[i + 1]], i: i + 2 });
      else queue.push({ argv: [...argv, same], i: i + 1 });
      if (dashed && type === 'unknown') {
        changed = true;
        queue.push({ argv: [...argv, [`${name}=${next}`]], i: i + 2 });
      }
    }
  }
  return changed ? done.map((argv) => concatWords(...argv)) : [args];
}

// nopt の resolveShort で、すべての文字が1文字の shorthands でもまとめにしない長い名前（npm 11.20 の設定の名前）
const NOPT_LONG_NAMES = new Set(['all', 'ca', 'call']);
// - を2つ以上重ねたフラグ（= の前）を、nopt の読み方で直した名前の候補。- が1つのものはそのまま（readFlag と shortFlags が読む）
function noptNames(spec, flag) {
  const key = flag.replace(/^-+/, '');
  if (flag.length - key.length < 2 || key === '') return [flag];
  const long = `--${key}`;
  const bundle = [...key].every((c) => Object.hasOwn(spec.short, c)) && !NOPT_LONG_NAMES.has(key);
  if (!bundle) return [long];
  return spec.longName(long) !== long ? [`-${key}`, long] : [`-${key}`];
}

// npm 11.20 の @npmcli/config の definitions で型が Boolean の設定と、値を取らない形に広がる長い shorthands（silent は --loglevel silent、
// local は --no-global）。nopt はこれらの次の語を値に取らない（true か false だけは値に取るが、- で始まる語ではない）
const NPM_BOOLEAN_FLAGS = new Set(
  [
    'all', 'allow-same-version', 'audit', 'bin-links', 'browser', 'bypass-2fa', 'color', 'commit-hooks', 'dangerously-allow-all-scripts',
    'description', 'dev', 'diff-ignore-all-space', 'diff-name-only', 'diff-no-prefix', 'diff-text', 'dry-run', 'engine-strict',
    'expect-results', 'force', 'foreground-scripts', 'format-package-lock', 'fund', 'git-tag-version', 'global', 'global-style',
    'if-present', 'ignore-scripts', 'include-staged', 'include-workspace-root', 'include-attestations', 'init-private', 'install-links',
    'json', 'legacy-bundling', 'legacy-peer-deps', 'link', 'long', 'offline', 'omit-lockfile-registry-resolved', 'optional',
    'package-lock', 'package-lock-only', 'parseable', 'allow-scripts-pending', 'allow-scripts-pin', 'prefer-dedupe', 'prefer-offline',
    'prefer-online', 'production', 'progress', 'provenance', 'read-only', 'rebuild-bundle', 'save', 'save-bundle', 'save-dev',
    'save-exact', 'save-optional', 'save-peer', 'save-prod', 'packages-all', 'shrinkwrap', 'sign-git-commit', 'sign-git-tag',
    'strict-peer-deps', 'strict-allow-scripts', 'strict-ssl', 'timing', 'unicode', 'update-notifier', 'usage', 'version', 'versions',
    'workspaces', 'workspaces-update', 'yes',
    // shorthands
    'dd', 'ddd', 'quiet', 'silent', 'verbose', 'desc', 'help', 'local', 'no', 'porcelain', 'readonly', 'iwr', 'ws',
  ].map((name) => `--${name}`),
);

// nopt がフラグの次の語と = の値をどう読むかの型。reread は - で始まる語を値に取らず、= の値が - で始まればフラグとして読み直すもの
// （String の型のフラグ、値を取らない短いフラグ、npm の Boolean の設定、--no- で始まるフラグ。nopt は --no- を外して真偽として読む）、
// value は表の String でない値のフラグ（- で始まる語も値に取る）、unknown は表に無いフラグ（両方で読む）
function noptType(spec, name) {
  if (name.startsWith('--')) {
    const long = spec.longName(name);
    if (spec.strings.has(long) || /^--no-/i.test(long) || NPM_BOOLEAN_FLAGS.has(long)) return 'reread';
    return spec.flags[long] ? 'value' : 'unknown';
  }
  const kinds = [...name.slice(1)].map((c) => spec.short[c]);
  if (kinds.some((k) => !k)) return 'unknown';
  return spec.strings.has(`-${name.at(-1)}`) || ['flag', 'shell'].includes(kinds.at(-1)) ? 'reread' : 'value';
}

// args を道具の表で読み、名前ごとに判定する（judgePackageManager の本体）
function judgeArgs(spec, args, prefix, ctx) {
  const base = { dir: ctx.dir, place: ctx.place };
  const anywhere = spec.dirAnywhere ? dirAnywhere(spec, args, 0, base) : undefined;
  const locs = anywhere ?? [base, ...configuredDirs(prefix, base)];
  const results = [];
  for (const loc of locs) {
    const { readings, reason } = nameReadings(spec, args, 0, loc, base);
    if (reason) return [[ASK, reason]];
    for (const reading of readings) results.push(...judgeName(spec, args, prefix, ctx, reading));
  }
  return results;
}

// at の名前を判定する。builtins が false のとき（run の後ろ）は、組み込みのコマンドとして引かず、スクリプトの名前として読む。
// package.json のスクリプトにある名前は、組み込みより先にスクリプトとして見る（pnpm 12 は clean、purge、tasks で同名のスクリプトを優先する。
// ほかの組み込みでも止めすぎの側に倒し、組み込みとしても見る）
function judgeName(spec, args, prefix, ctx, reading, builtins = true) {
  const { at, dir } = reading;
  if (at === -1) {
    // yarn は名前の無い形（yarn、yarn --frozen-lockfile）で install を走らせる（yarn 1.22 で確かめた）。版と help の表示は除く
    const shows = args.some((a) => /^(-v|--version|-h|--help)$/.test(a));
    return builtins && spec.bareInstall && !shows ? judgeBuiltin(spec, 'install', args, prefix, ctx, reading) : [];
  }
  const name = args[at];
  if (isUnresolved(args, at)) return [[ASK, NAME_EXPANDS_REASON]];
  if (DEPLOY_SCRIPT.test(name)) return [[DENY, 'デプロイは Workers Builds だけが行う']];
  const known = Boolean(dir && ctx.packageDirOf(dir));
  const isScript = known && Boolean(ctx.scriptOf(dir, name));
  const rest = sliceWords(args, at + 1);
  const results = [];
  // 実行の道具の名前（pnpm node x、npm run tsx x、yarn node x）は、スクリプトがあっても経由先として見る
  const runner = RUNNERS.has(baseName(name));
  if (runner) results.push(...judgeVia(prefix, args, at, reading, ctx));
  const command = builtins ? spec.commandOf(name) : undefined;
  if (command === undefined) {
    if (builtins && spec.unknownAsks) return [...results, [ASK, NPM_UNKNOWN_REASON]];
    // pnpm と bun は、スクリプトに無い名前を PATH のコマンドとして動かす（pnpm bash -c '…'、bun run git push）。
    // 場所が分からなければスクリプトかどうかも分からないので、確認を挟んだうえで経由先としても見る
    const via = spec.runsMissing && !isScript && !runner ? judgeVia(prefix, args, at, reading, ctx) : [];
    return [...results, ...via, ...judgeScripts([name], rest, reading, ctx)];
  }
  if (isScript) results.push(...judgeScripts([name], rest, reading, ctx));
  return [...results, ...judgeBuiltin(spec, command, args, prefix, ctx, reading)];
}

// 組み込みのコマンドを判定する。reading の at は名前の位置（名前の無い yarn では -1）、dir と place はその場所
function judgeBuiltin(spec, command, args, prefix, ctx, reading) {
  const { at, shell } = reading;
  const loc = { dir: reading.dir, place: reading.place };
  const base = { dir: ctx.dir, place: ctx.place };
  // run の後ろはスクリプトの名前。pnpm with <版> の後ろは、pnpm のコマンドとして読み直す
  if (command === 'run' || command === 'with') {
    const { readings, reason } = nameReadings(spec, args, at + (command === 'run' ? 1 : 2), loc, base, { shell });
    if (reason) return [[ASK, reason]];
    return readings.flatMap((r) => judgeName(spec, args, prefix, ctx, r, command === 'with'));
  }
  if (spec.exec.includes(command)) return judgeExec(spec, args, prefix, ctx, reading);
  // npm init <初期化子>（create、innit も）は、npm exec と同じく libnpmexec に --call と -c の文字列を渡して動かす
  // （npm 11.20 の lib/commands/init.js の execCreate）。初期化子の無い npm init は動かさない。
  // 前の区切りで npm_config_call を設定した後は、npm exec と同じく確認を挟む
  const called = [];
  if (spec.calls && command === 'init' && commandPositionals(spec, args, at + 1).length > 0) {
    if (ctx.env?.[NPM_CALL_VARIABLE]) called.push([ASK, NPM_CALL_SET_REASON]);
    const calls = npmCalls(spec, args);
    if (!calls) return [[ASK, UNREADABLE_FLAG_REASON]];
    called.push(...calls.map((script) => judgeBash(script, { ...ctx, cwd: loc.dir, place: loc.place, depth: ctx.depth + 1 })).filter(Boolean));
  }
  const rest = sliceWords(args, at + 1);
  // bun exec "<文字列>" は、最初の位置引数をシェルの文字列として動かす（2つ目からは使わない）
  if (spec.shell?.includes(command)) {
    const script = commandPositionals(spec, args, at + 1)[0];
    return script === undefined ? [] : [judgeBash(script, { ...ctx, cwd: loc.dir, place: loc.place, depth: ctx.depth + 1 })].filter(Boolean);
  }
  if (spec.changes.includes(command) || (INSTALLS_PACKAGE.has(command) && commandPositionals(spec, args, at + 1).length > 0)) {
    return [[ASK, PACKAGE_CHANGE_REASON]];
  }
  // 組み込みのコマンドの後ろの場所のフラグも読む（pnpm install -C sub。npm は dirAnywhere が読んである）。
  // test、start、stop の後ろはスクリプトに渡るので読まない（pnpm test -C sub は今の場所の test）
  const locs = spec.dirAnywhere || PASSES_FLAGS.has(command) ? [loc] : (dirAnywhere(spec, args, at + 1, base) ?? [loc]);
  const name = args[at];
  return [
    ...called,
    ...locs.flatMap((l) => {
      if (SCRIPT_COMMANDS[command]) return judgeScripts(SCRIPT_COMMANDS[command], rest, l, ctx);
      const lifecycle = lifecycleOf(spec, command, args, at);
      if (lifecycle) return judgeScripts(lifecycle, [], l, ctx);
      // ほかの組み込みも、同じ名前の pre と post のスクリプトがあれば見る（止めすぎの側。場所が分からなくても確認は挟まない）
      return l.dir && ctx.packageDirOf(l.dir) ? judgeScripts([name], rest, l, ctx) : [];
    }),
  ];
}

// 組み込みのコマンドが走らせるライフサイクルのスクリプトの名前。走らせなければ undefined
function lifecycleOf(spec, command, args, at) {
  if (command === 'install' || command === 'ci') return spec.installScripts;
  if (command === 'install-test' || command === 'install-ci-test') return [...spec.installScripts, 'test'];
  if (command === 'pack') return PACK_SCRIPTS;
  if (command === 'publish') return PUBLISH_SCRIPTS;
  // 引数の無い npm link は、このパッケージを大域に入れ、install と prepare を走らせる（npm 11.20 で大域の場所を一時の場所に向けて確かめた）
  if (command === 'link' && spec.linkInstalls && commandPositionals(spec, args, at + 1).length === 0) return ['install', 'prepare'];
  return undefined;
}

// exec（pnpm exec、pnpm dlx、npm exec、npm x、yarn exec、bun x）の後ろの経由先を判定する。
// pnpm の shell-mode（-c、--shell-mode。exec の前でも後ろでも効き、値を取らない）では、位置引数を空白でつないだ文字列をシェルで動かす。
// npm の --call（-c、一意な前置きの --cal も）の値と、道具の前の npm_config_call= の値もシェルの文字列として動かす（後者は judgeSegment が見る）。
// 同じコマンドの前の区切りで npm_config_call を設定した後（ctx.env、judgeBash が積む）は、値を読まずに確認を挟む
function judgeExec(spec, args, prefix, ctx, { at, dir, place, shell }) {
  const results = [];
  if (spec.calls) {
    if (ctx.env?.[NPM_CALL_VARIABLE]) results.push([ASK, NPM_CALL_SET_REASON]);
    const calls = npmCalls(spec, args);
    if (!calls) return [[ASK, UNREADABLE_FLAG_REASON]];
    for (const script of calls) results.push(judgeBash(script, { ...ctx, cwd: dir, place, depth: ctx.depth + 1 }));
  }
  const base = { dir: ctx.dir, place: ctx.place };
  const { readings, reason } = nameReadings(spec, args, at + 1, { dir, place }, base, { exec: true, shell });
  if (reason) return [...results, [ASK, reason]];
  for (const target of readings) {
    if (target.at === -1) continue;
    const shellCtx = { ...ctx, cwd: target.dir, place: target.place, depth: ctx.depth + 1 };
    if (target.shell) results.push(judgeBash(args.slice(target.at).join(' '), shellCtx));
    else results.push(...judgeVia(prefix, args, target.at, target, ctx));
  }
  return results.filter(Boolean);
}

// npx-cli.js（npm 11.20）が npm exec に渡す前に読むフラグの名前（先頭の - を全部外し、= の前まで）。
// NPX_SHORTHANDS は npm の1文字の shorthands で、npx は = の有無を問わず広げてから読み直す（-m=-c は --message と -c の2語、
// -d は --loglevel info。p は npx が先に --package に直し、n は取り除くので広げない）。
// NPX_REMOVED は取り除いたフラグで、= の無い形は次の語も一緒に消す。NPX_OPTS は次の語をいつも値に取る。
// NPX_SWITCHES は値を取らない（npx の switches のうちよく使うものと、1文字の名前の先の npm の真偽の設定）。
// NPX_VALUES は - で始まらない次の語を値に取る。どれでもない名前は、npm の真偽の設定かどうかを引かないので、
// 次の語を値と読む形と読まない形の両方で見る
const NPX_REMOVED = new Set(['n', 'npm', 'node-arg']);
const NPX_OPTS = new Set(['package', 'p', 'cache', 'userconfig', 'call', 'c', 'shell']);
const NPX_SHORTHANDS = {
  c: ['--call'], C: ['--prefix'], w: ['--workspace'], L: ['--location'], m: ['--message'],
  d: ['--loglevel', 'info'], q: ['--loglevel', 'warn'], s: ['--loglevel', 'silent'],
  a: ['--all'], f: ['--force'], g: ['--global'], l: ['--long'], S: ['--save'], B: ['--save-bundle'], D: ['--save-dev'],
  E: ['--save-exact'], O: ['--save-optional'], P: ['--save-prod'], '?': ['--usage'], H: ['--usage'], h: ['--usage'],
  v: ['--version'], y: ['--yes'],
};
const NPX_SWITCHES = new Set([
  'no-install', 'quiet', 'version', 'help', 'yes', 'all', 'force', 'global', 'long', 'usage',
  'save', 'save-bundle', 'save-dev', 'save-exact', 'save-optional', 'save-prod',
]);
const NPX_VALUES = new Set(['message', 'workspace', 'location', 'prefix', 'loglevel']);
function npxFlagKind(key) {
  if (NPX_REMOVED.has(key)) return 'removed';
  if (NPX_SWITCHES.has(key)) return 'switch';
  if (NPX_OPTS.has(key)) return 'opt';
  return NPX_VALUES.has(key) ? 'value' : 'unknown';
}

// npx の後ろの語を、npx-cli.js と同じく npm exec に渡す語の並びに直す。最初の位置引数の前に -- を差し込み、-- か位置引数でフラグを読み終える。
// 取り除いたフラグ（-n foo）は値ごと消し、1文字の名前は NPX_SHORTHANDS で広げる。表に無いフラグで読み方が分かれれば、並びを複数返す。
// 並びは語の切れ端（sliceWords で切った1語か、広げた語と差し込んだ -- の印の無い1語）の並び
function npxArgvs(args) {
  const argvs = [];
  const walk = (items, start, kept) => {
    for (let i = start; i < items.length && argvs.length <= MAX_READINGS; i++) {
      const a = items[i][0];
      if (a === '--') return void argvs.push([...kept, ...items.slice(i)]);
      if (!a.startsWith('-')) return void argvs.push([...kept, ['--'], ...items.slice(i)]);
      const eq = a.indexOf('=');
      const key = (eq === -1 ? a : a.slice(0, eq)).replace(/^-+/, '');
      if (key !== 'p' && Object.hasOwn(NPX_SHORTHANDS, key)) {
        const expanded = [...NPX_SHORTHANDS[key], ...(eq === -1 ? [] : [a.slice(eq + 1)])].map((w) => [w]);
        items = [...items.slice(0, i), ...expanded, ...items.slice(i + 1)];
        i--;
        continue;
      }
      const kind = npxFlagKind(key);
      const next = items[i + 1]?.[0];
      if (kind === 'removed') {
        if (eq === -1) i++;
        continue;
      }
      kept = [...kept, items[i]];
      if (eq !== -1 || kind === 'switch' || next === undefined) continue;
      if (kind === 'opt' || (kind === 'value' && !next.startsWith('-'))) kept = [...kept, items[++i]];
      else if (kind === 'unknown' && !next.startsWith('-')) walk(items, i + 2, [...kept, items[i + 1]]);
    }
    argvs.push(kept);
  };
  walk(
    args.map((_, i) => sliceWords(args, i, i + 1)),
    0,
    [],
  );
  return argvs;
}

// npx と pnpx を、npm exec と pnpm dlx として判定する。args は npx か pnpx の後ろの語、prefix はその前の語。
// npx は引数を npm exec に渡し、最初の位置引数の前に -- を差し込む（npm 11.20 の bin/npx-cli.js）ので、npx vitest -c x の -c x は
// vitest の引数で、npm の --call ではない。npxArgvs の並びごとに npm exec <並び> を npm の表で判定する。
// pnpx は pnpm dlx と同じに動く（pnpm 12.12）ので、pnpm dlx <後ろ> として読む
function judgeNpx(tool, args, prefix, ctx) {
  if (tool === 'pnpx') return judgePackageManager('pnpm', concatWords(['dlx'], args), prefix, ctx);
  const argvs = npxArgvs(args);
  if (argvs.length > MAX_READINGS) return [[ASK, MANY_READINGS_REASON]];
  const seen = new Set();
  return argvs.flatMap((argv) => {
    const exec = concatWords(['exec'], ...argv);
    const key = exec.join('\0');
    if (seen.has(key)) return [];
    seen.add(key);
    return judgePackageManager('npm', exec, prefix, ctx);
  });
}

// from から後ろの位置引数（フラグとその値を飛ばす。-- の後ろは全部）
function commandPositionals(spec, args, from) {
  const result = [];
  for (let i = from; i < args.length; i++) {
    if (args[i] === '--') return [...result, ...args.slice(i + 1)];
    if (args[i].startsWith('-')) i = readFlag(spec, args, i).end;
    else result.push(args[i]);
  }
  return result;
}

// dir から見た package.json の names のスクリプトの中身を、pre と post も含めて同じ規則で見る。
// 名前より後ろの語（extra）は、道具が引用符で包んで本体の末尾に足す（pnpm test x は node --test scripts/*.test.ts 'x'）。
// npm が -- の前のフラグを取る違いはまねず、全部の語を足す。-- は pnpm が残し、npm、yarn、bun が消すので、
// 残した形と最初の -- を消した形の両方を見る（git や wrangler の判定は -- の後ろをフラグとして読まないため）。
// loc は { dir, place }。場所が分からないか、package.json を引けなければ確認を挟む
function judgeScripts(names, extra, { dir, place }, ctx) {
  const packageDir = dir && ctx.packageDirOf(dir);
  if (!packageDir) return [[ASK, UNKNOWN_PACKAGE_REASON]];
  const separator = extra.indexOf('--');
  const appended = separator === -1 ? [extra] : [extra, concatWords(sliceWords(extra, 0, separator), sliceWords(extra, separator + 1))];
  // 道具は package.json のあるディレクトリでスクリプトを動かすので、本体と足した語もそこで判定する（cd src && pnpm test '*/x.ts'）。
  // 作業場所は分かっているので、書かれた行き先（place）は package.json のある場所が dir と同じときだけ引き継ぐ
  const scriptCtx = { ...ctx, cwd: packageDir, place: packageDir === dir ? place : packageDir, depth: ctx.depth + 1 };
  const results = [];
  for (const name of names) {
    const body = ctx.scriptOf(dir, name);
    for (const b of [`pre${name}`, `post${name}`].map((n) => ctx.scriptOf(dir, n)).filter(Boolean)) results.push(judgeBash(b, scriptCtx));
    if (!body) continue;
    results.push(...appended.map((words) => judgeBash(appendWords(body, words), scriptCtx)));
    // 足した語は引用符で包むので、展開（$X、$(…)、glob）の印が消え、直に打つより緩く読みうる
    if (extra.some((_, i) => isUnresolved(extra, i))) results.push([ASK, SCRIPT_ARGS_EXPAND_REASON]);
  }
  return results.filter(Boolean);
}

// 語をシェルの1語として単引用符で包み、本体の末尾に足す
function appendWords(body, words) {
  return [body, ...words.map((w) => `'${w.replaceAll("'", "'\\''")}'`)].join(' ');
}

// args の start から後ろを、経由先のコマンドとして前置き（prefix）ごと judgeSegment に掛け直す。
// env、代入、timeout などの前置きも同じ規則で効く。前置きの env -C の分は解決済みなので重ねない（envFrom）
// loc は経由先の場所 { dir, place }（pnpm -C .claude exec rm -rf hooks の place は .claude）
function judgeVia(prefix, args, start, { dir, place }, ctx) {
  if (ctx.depth + 1 > MAX_DEPTH) return [[ASK, DEEP_REASON]];
  return judgeSegment(concatWords(prefix, sliceWords(args, start)), { ...ctx, dir, place, envFrom: prefix.length, depth: ctx.depth + 1 });
}

// .dev.vars と .env（.example は除く）。コードの文字列の中（readFileSync('.dev.vars')）も拾う。
// .envrc や process.env は拾わない。.dev.v* のように名前の途中で切ったグロブは取りこぼす。
// macOS の APFS は大文字小文字を区別しないので、.DEV.VARS も同じファイルを指す（i）
export function mentionsSecret(word) {
  return /(^|[^\w.])\.(dev\.vars|env)(?!\.example)(?![\w-])/i.test(word);
}

const READERS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'bat', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'awk', 'sed', 'sort', 'uniq',
  'wc', 'cut', 'tr', 'diff', 'cmp', 'xxd', 'od', 'hexdump', 'strings', 'base64', 'source', '.', 'vi', 'vim', 'nvim',
  'nano', 'code', 'open', 'jq', 'yq', 'python', 'python3', 'node', 'ruby', 'perl', 'deno', 'bun', 'tee', 'export',
  // 中身を外へ送る（curl -d @.env、curl -F file=@.dev.vars）
  'curl', 'wget', 'http', 'https', 'nc',
]);
// -c の中身を Bash のコマンドとして読むシェル。デプロイのスクリプトを読む道具（SCRIPT_READERS）にも入る
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'csh', 'tcsh', 'fish']);
const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag']);
const SEARCH_FLAGS_WITH_VALUE = new Set(['-e', '-f', '--regexp', '--file', '-g', '--glob', '-t', '--type', '-A', '-B', '-C', '-m']);

const INTERPRETERS = new Set(['node', 'python', 'python3', 'ruby', 'perl', 'deno', 'bun', 'osascript', 'php', 'tclsh']);
// リダイレクトの種類。op は記述子の番号と zsh の ! を含まない。<> は読み書きで開き、切り詰めずに先頭から上書きできるので、読み込み元と書き込み先の両方に数える
const isHeredocRedirect = (r) => r.op === '<<' || r.op === '<<<';
const isReadRedirect = (r) => r.op.includes('<') && !isHeredocRedirect(r);
const isWriteRedirect = (r) => r.op === '<>' || !r.op.includes('<');
// リダイレクトの先（本文）と、その中の $(…) と `…` の中身。置換の出力が先や本文になる（> "$(echo .dev.vars)"、
// python3 <<< "$(echo 'open(".env")')"）が、置換が書き込みでも実行でもない道具（echo）だけなら、別の区切りの判定には当たらないため。
// 中身は、そのまま、空白や引用符で区切った語ごと、シェルと同じく引用符を解いた語ごと（"$(echo .en'v')" の .env）で返す
// 先に置換が文字を挟んで続く形（> $(echo .claude/settings).json、cat < $(echo .dev).vars）は、先の shape の実行時に決まる位置（DYNAMIC）を
// 中身の語で埋めた文字列も返す。名前が置換の境目にまたがり、先の文字列にも中身にも名前が現れないため。
// 埋めるのは中身の語だけなので、> "$(mktemp)"、> "$(mktemp -d)/out.log"、> /tmp/$(date +%s).log は名前に当たらず通る。
// 先の ${X:-.dev}.vars の既定値も語として埋める
const redirectTextsCache = new WeakMap();
function redirectTexts(redirect) {
  let texts = redirectTextsCache.get(redirect);
  if (!texts) {
    const pieces = redirect.substitutions.flatMap((s) => [s, ...s.split(CODE_SEPARATORS).filter(Boolean), ...splitSegments(s).flat()]);
    texts = [redirect.target, ...pieces, ...fillDynamic(redirect, pieces)];
    redirectTextsCache.set(redirect, texts);
  }
  return texts;
}

// 先の shape の DYNAMIC を、pieces と ${NAME:-既定値} の既定値と空文字（未設定の変数）で埋めた文字列。
// 位置が1つだけで固定の文字を持たない先（"$(mktemp)"）は、中身がそのまま名前になるので埋めない。
// 位置が複数あれば、位置ごとに別の語を割り当てた組み合わせを見る（$(echo .dev)$(echo .vars) は .dev と .vars をつないだ .dev.vars）。
// 組み合わせが MAX_FILLED を超えるときは、全部の位置を同じ語で埋めた形と、1か所だけ埋めた形に絞る
function fillDynamic({ target, shape }, pieces) {
  const parts = shape.split(DYNAMIC);
  const positions = parts.length - 1;
  if (positions === 0 || (positions === 1 && !parts.join(''))) return [];
  const defaults = [...target.matchAll(/\$\{[^}:=?+-]*:?[-=+?]([^}]*)\}/g)].map((m) => m[1]);
  const options = [...new Set(['', ...pieces, ...defaults])];
  if (options.length ** positions <= MAX_FILLED) {
    let filled = [parts[0]];
    for (let k = 1; k < parts.length; k++) filled = filled.flatMap((prefix) => options.map((o) => prefix + o + parts[k]));
    return filled;
  }
  const filled = [];
  for (const piece of options) {
    filled.push(parts.join(piece));
    if (positions <= MAX_DYNAMIC_POSITIONS) {
      for (let k = 0; k < positions; k++) filled.push(parts.reduce((acc, p, idx) => acc + p + (idx === k ? piece : ''), ''));
    }
  }
  return filled;
}
const MAX_FILLED = 4096;
const MAX_DYNAMIC_POSITIONS = 4;

// ヒアドキュメントとヒアストリングの本文（中の置換の中身を含む）。照合に使う
const heredocBodies = (words) => redirectsOf(words).filter(isHeredocRedirect).flatMap(redirectTexts);
// シェルに渡す本文。judgeBash に掛けるのは本文と置換の中身だけで、照合用に区切った語は掛けない
const heredocScripts = (words) => redirectsOf(words).filter(isHeredocRedirect).flatMap((r) => [r.target, ...r.substitutions]);
// リダイレクトの先の語（本文を含む）。語の並びに混ぜて数える判定（xargs の名前の流し込み、変数の設定）が見落とさないために使う
const redirectTargets = (words) => redirectsOf(words).map((r) => r.target);

// 読み書き共通の文言。ワークツリーの .dev.vars は本体の本物へのリンクなので、.dev.vars への書き込みは本体の値を上書きする
const SECRET_FILE_REASON =
  '.dev.vars と .env は開発用のシークレット。読むのも書くのも人に任せる（手元のセッションでは ! を付けて打ってもらう）。例は .dev.vars.example に置く';

// words は区切りの全部の語（< .env cmd のように、道具の前に置いた入力も見る）
function judgeSecretAccess(tool, args, words) {
  if (redirectsOf(words).some((r) => isReadRedirect(r) && redirectTexts(r).some(mentionsSecret))) return true;
  if (GNU_PREFIXED.has(tool)) tool = tool.slice(1);
  // 引数を実行しない道具以外は、引数のどれかに名前があれば止める（sqlite3 x.db '.output .dev.vars'、expect -c 'spawn cat .dev.vars'、
  // docker run --env-file .env x のように、表に無い道具の読み書きを列挙しきれないため）。pnpm test -- --grep .env のような止めすぎは人に任せる。
  // find は探すだけの形（find . -name .dev.vars）が多いので外し、-exec などと -fprint などの書き込み先（writesTo）で見る
  if (!isNonExecuting(tool) && tool !== 'find' && args.some(mentionsSecret)) return true;
  // 書き込み先（>）と、文書として流すヒアドキュメントの本文は args に入らないので、args は読み取りの引数として見てよい
  if (INTERPRETERS.has(tool)) return heredocBodies(args).some(mentionsSecret);
  if (SEARCHERS.has(tool)) {
    // 最初の位置の引数は探す文字列なので、grep ".dev.vars" docs のような検索は通す
    const pos = positionals(args, SEARCH_FLAGS_WITH_VALUE);
    const files = args.some((a) => ['-e', '-f', '--regexp', '--file'].includes(a)) ? pos : pos.slice(1);
    return files.some(mentionsSecret);
  }
  if (READERS.has(tool) || SHELLS.has(tool)) return args.some(mentionsSecret);
  if (COPY_TOOLS.has(tool)) {
    // ここで見るのはコピーの元。書き込み先は writesTo が見る（cp .dev.vars.example .dev.vars はそちらで止まる）
    const pos = positionals(args);
    return pos.slice(0, -1).some(mentionsSecret);
  }
  return false;
}

// zsh の括弧の glob を語の末尾に付けた形（wrangler.jsonc(N)、wrangler.jsonc(.)）は、当たればその名前のファイルに展開される。
// 後ろに語が続かないと judgeBash の区切りの判定に当たらないので、照合の前に外した形でも見る
const withoutGlobGroup = (word) => word.replace(/(\(…\))+$/, '');

// Write と Edit のフック（file-rules.mjs）が守るファイル。Bash から書き換えるときは人の確認を挟む。
// .claude、.githooks、migrations のディレクトリそのもの（mv .claude /tmp/x、cp -r /tmp/x/migrations .、中身ごとのコピーの宛先 .claude/）も含める。
// APFS は大文字小文字を区別しないので、.Claude/Settings.json も同じファイルを指す（i）
function isProtectedPath(word) {
  return [word, withoutGlobGroup(word)].some((w) =>
    /(^|\/)\.claude\/(settings[^/]*\.json$|hooks(\/|$))|(^|\/)\.claude\/?$|(^|\/)\.githooks(\/|$)|(^|\/)migrations(\/|$)/i.test(w),
  );
}
// 守る先の候補（リポジトリの根からの相対パス）。glob の語（mv .claude/* /tmp/x、mv .gith* /tmp/x）はこれに照合する
const PROTECTED_CANDIDATES = ['.claude/settings.json', '.claude/settings.local.json', '.claude/hooks', '.githooks', 'migrations'];

// 語が守る先に当たるか。{a,b} は展開してから（mv .claude/settings.json{,.bak}）、書かれた語、正規化した語、作業場所が分かるときは
// 作業場所から解決した絶対パス（cd .claude && cp /tmp/settings.json .）で見る（wranglerConfigAt と同じ）。
// glob の語は、作業場所が分かるときは根（scripts/deploy-production.ts のあるディレクトリ。見つからなければ作業場所）の候補の絶対パスに、
// 分からないときは候補の相対パスに照合する。根の外の glob（rm /tmp/*）は止めない。
// isProtectedPath と同じく大文字小文字を区別しないよう、候補も glob も小文字にそろえて照合する（mv .Claude/* /tmp/x、mv .GITH* /tmp/x）。
// 展開が MAX_BRACE_EXPANSION を超える語は、照合せずに当たるものとして扱う（BIG_GLOB_REASON と同じ）
function protectedAt(dir) {
  const root = dir && (repoRootOf(dir) ?? dir);
  return (word) => {
    const written = withoutGlobGroup(word);
    if (expansionSize(written) > MAX_BRACE_EXPANSION) return true;
    return expandBraces(written).some((w) => {
      const absolute = dir ? path.resolve(dir, w) : null;
      if ([w, path.posix.normalize(w), absolute].some((f) => f && isProtectedPath(f))) return true;
      if (!GLOB_CHARS.test(w)) return false;
      const [base, pattern] = root ? [root.toLowerCase(), absolute.toLowerCase()] : ['', w.toLowerCase()];
      return PROTECTED_CANDIDATES.some((c) => matchesGlob(base ? path.join(base, c) : c, pattern));
    });
  };
}
// 宛先がディレクトリのコピーで、元が glob（cp /tmp/settings* .claude/）のときに、守る先に置かれうる名前。
// .githooks/ と migrations/ の下はどの名前でも守る先なので、.claude/ の下の名前だけを並べる。
// ディレクトリそのものの名前（cp -r /tmp/x/migrations .）は、glob でない元の名前として isProtectedPath が見るので並べない
// （並べると、cp /tmp/* . の * が migrations に当たって止まる）
const PROTECTED_NAMES = ['settings.json', 'settings.local.json', 'hooks'];
const PROTECTED_DIRECTORY_NAMES = ['.claude', '.githooks', 'migrations'];
// 宛先が展開で決まるコピー（cp -t "$D" /tmp/settings.json）で、守る先に置かれうる元の名前。.githooks の名前は git のフックの名前
const GIT_HOOK_NAMES = new Set([
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit',
  'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-receive', 'update', 'proc-receive', 'post-receive', 'post-update',
  'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate', 'fsmonitor-watchman', 'post-index-change',
]);
function placedInProtected(name) {
  const plain = withoutGlobGroup(name).toLowerCase();
  return [...PROTECTED_NAMES, ...PROTECTED_DIRECTORY_NAMES].includes(plain) || GIT_HOOK_NAMES.has(plain) || /\.sql$/.test(plain);
}
// 宛先の展開されない部分が守る先の名前を含むか（cp -t "$PWD/.claude" …、cp -t$PWD/.githooks …）
const PROTECTED_DIRECTORY_HINT = /(^|\/|\0)(\.claude|\.githooks|migrations)(\/|$)/i;

// wrangler の設定と、-c が無いときの転送先を決める .wrangler/deploy/config.json。remote の binding を入れると wrangler dev が本番に届く。
// APFS は大文字小文字を区別しないので、Wrangler.jsonc も同じファイルを指す（i）
const WRANGLER_CONFIG_FILES = ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml'];
const WRANGLER_DEPLOY_FILE = 'config.json';
// 設定のファイルの名前。元が glob のコピー（cp /tmp/wrangler* .）は、glob が当たる名前を宛先に置かれるものとして見る
const WRANGLER_CONFIG_NAMES = [...WRANGLER_CONFIG_FILES, WRANGLER_DEPLOY_FILE];
const escapeDots = (name) => name.replaceAll('.', '\\.');
const WRANGLER_CONFIG_PATH = new RegExp(
  `(^|/)(${WRANGLER_CONFIG_FILES.map(escapeDots).join('|')})$|(^|/)\\.wrangler/deploy/${escapeDots(WRANGLER_DEPLOY_FILE)}$`,
  'i',
);
function isWranglerConfig(word) {
  return WRANGLER_CONFIG_PATH.test(word) || WRANGLER_CONFIG_PATH.test(withoutGlobGroup(word));
}

// 書かれた語のほかに、正規化した語（.wrangler//deploy/./config.json）と、作業場所が分かるときは作業場所から解決した絶対パス
// （cd .wrangler/deploy && … > config.json）でも設定に当たるかを見る。作業場所が null のときは書かれた語だけで見る
function wranglerConfigAt(dir) {
  return (word) => {
    return isWranglerConfig(word) || isWranglerConfig(path.posix.normalize(word)) || Boolean(dir && isWranglerConfig(path.resolve(dir, word)));
  };
}

// cp x dir/ や cp x .、cp x .. のように、宛先がディレクトリのとき（末尾が /、.、..、または作業場所から解決して実在するディレクトリ）
function isDirectoryTarget(dest, dir) {
  if (/(^|\/)\.\.?$|\/$/.test(dest)) return true;
  try {
    return Boolean(dir) && statSync(path.resolve(dir, dest)).isDirectory();
  } catch {
    return false;
  }
}

// 宛先がディレクトリのコピーは、元の名前でそのディレクトリに置かれる（cp /tmp/wrangler.jsonc .）。元の basename を宛先に付けて見る。
// wrangler の設定では、絶対パスの宛先は、作業場所が分かり、その根（scripts/deploy-production.ts のあるディレクトリ）の中のときだけ見る
// （cp wrangler.jsonc /tmp/ は別の場所への複製）。~ で始まる宛先は見ない。
// 守る先（anywhere）は、別のチェックアウトや ~ の下の .claude/ も守るので、この絞り込みをしない。
// -t の宛先は必ずディレクトリ（実在を確かめられない cd $X の後や、まだ無いディレクトリでも）なので、isDirectory を付けて呼ぶ。
// into は { dir, names, bareGlob, anywhere } で、dir は作業場所、names と bareGlob は namesCopiedFrom に渡す glob の候補
function copiesIntoDirectory(matches, pos, into, isDirectory = false) {
  const { dir } = into;
  const dest = pos.at(-1);
  if (pos.length < 2 || !dest || !(isDirectory || isDirectoryTarget(dest, dir))) return false;
  if (!into.anywhere && dest.startsWith('~')) return false;
  if (!into.anywhere && dest.startsWith('/')) {
    const root = dir && (repoRootOf(dir) ?? dir);
    const absolute = path.resolve(dest);
    if (!root || !(absolute === root || absolute.startsWith(root + path.sep))) return false;
  }
  // 展開が多すぎて名前を出せない元は、設定に当たるかを判定できないので当たるものとして扱う（BIG_GLOB_REASON と同じ）
  // glob の元は、namesCopiedFrom が候補の名前に照合した結果で見る。glob のまま宛先に付けて照合すると、
  // 宛先にもともとある名前（cp /tmp/* . の * と ./migrations）に当たってしまう
  return pos.slice(0, -1).some((src) => {
    const names = namesCopiedFrom(src, into);
    return names === null || names.some((name) => !GLOB_CHARS.test(name) && matches(path.posix.join(dest, name)));
  });
}

// 元の語から宛先に置かれる名前。{a,b} は語ぜんたいで展開してから basename を取る（{x/wrangler.jsonc,y} の basename は jsonc,y} ではない）。
// glob（/tmp/wrangler*）は、候補の名前（names。wrangler の設定の名前か、守る先に置かれうる名前）のうち当たるものすべて。
// * や ** だけの語（cp /tmp/* .）は、文字を1つも含まず何にでも当たるので、bareGlob が無ければ見ない（judgeDeployWord と同じ）。
// 守る先は、cp /tmp/* .claude/ のように何にでも当たる glob を置く先として普段使わないので、bareGlob を付けて見る。
// 展開が MAX_BRACE_EXPANSION を超える語は展開せず null
function namesCopiedFrom(src, { names, bareGlob = false }) {
  if (expansionSize(src) > MAX_BRACE_EXPANSION) return null;
  return expandBraces(src).flatMap((word) => {
    // 末尾の括弧の glob（/tmp/x/wrangler.jsonc(N)）は、当たれば外した名前で置かれる
    const name = path.posix.basename(withoutGlobGroup(word));
    if (!GLOB_CHARS.test(name) || (!bareGlob && !/[\w.]/.test(name))) return [name];
    const pattern = name.toLowerCase();
    return [name, ...names.filter((n) => matchesGlob(n, pattern))];
  });
}

// {a,b} と {1..3}、{a..c}、{1..9..2} を bash と同じ順に展開する。展開しない {x}（要素が1つで範囲でもない）は文字のまま残す。
// 呼ぶ前に expansionSize で数を確かめる
function expandBraces(text) {
  const open = text.indexOf('{');
  if (open === -1) return [text];
  let depth = 0;
  let close = -1;
  for (let j = open; j < text.length && close === -1; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}' && --depth === 0) close = j;
  }
  if (close === -1) return [text];
  const head = text.slice(0, open);
  const inner = text.slice(open + 1, close);
  const tails = expandBraces(text.slice(close + 1));
  const options = braceOptions(inner) ?? [`{${inner}}`];
  return options.flatMap((option) => tails.map((tail) => head + option + tail));
}

function braceOptions(inner) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let k = 0; k < inner.length; k++) {
    if (inner[k] === '{') depth++;
    else if (inner[k] === '}') depth--;
    else if (inner[k] === ',' && depth === 0) {
      parts.push(inner.slice(start, k));
      start = k + 1;
    }
  }
  parts.push(inner.slice(start));
  if (parts.length > 1) return parts.flatMap(expandBraces);
  const range = /^(-?\d+|[a-z])\.\.(-?\d+|[a-z])(?:\.\.(-?\d+))?$/i.exec(inner);
  if (!range) return null;
  const numeric = /\d/.test(range[1]);
  if (numeric !== /\d/.test(range[2])) return null;
  const [from, to] = numeric ? [Number(range[1]), Number(range[2])] : [range[1].charCodeAt(0), range[2].charCodeAt(0)];
  const step = Math.abs(Number(range[3])) || 1;
  const values = [];
  for (let v = from; from <= to ? v <= to : v >= to; v += from <= to ? step : -step) {
    values.push(numeric ? String(v) : String.fromCharCode(v));
  }
  return values;
}

// Homebrew の GNU coreutils、grep、gawk、gsed は g を前に付けた名前で入る（gcp、gsed、gcat）。書き込みと読み取りの判定は g を外した名前で表を引く。
// 全部の名前から g を外すと gh や git が崩れるので、名前の集合を持つ
const GNU_PREFIXED = new Set([
  'gcp', 'gmv', 'gln', 'ginstall', 'grm', 'grmdir', 'gsed', 'gdd', 'gtee', 'gtruncate', 'gshred', 'gtouch',
  'gcat', 'ghead', 'gtail', 'ggrep', 'gegrep', 'gfgrep', 'gawk', 'gsort', 'guniq', 'gwc', 'gcut', 'gtr', 'god', 'gbase64',
  'gtar', 'gfind', 'gpatch', 'gunlink',
  // 引数を実行しない道具（NON_EXECUTING）も g を外して引く
  'greadlink', 'grealpath', 'gbasename', 'gdirname', 'gls', 'gstat', 'gecho', 'gprintf',
]);
const MULTI_ARG_WRITERS = new Set(['tee', 'rm', 'truncate', 'unlink', 'shred', 'srm', 'sponge', 'ed', 'ex', 'patch']);
// コピーの道具。宛先は writesTo が、元は judgeSecretAccess が見る
const COPY_TOOLS = new Set(['cp', 'mv', 'ln', 'rsync', 'install', 'scp', 'ditto']);
// -t DIR（GNU の coreutils）を持つ道具。rsync の -t は --times、scp の -t はサーバー側の印で、宛先を取らない
const TARGET_DIRECTORY_TOOLS = new Set(['cp', 'mv', 'ln', 'install']);
// 値を取る短いフラグ（-S 接尾辞、install の -m -g -o）。まとめた短いフラグ（-vS.bak）の中では、これ以降は値の一部
const SHORT_FLAGS_WITH_VALUE = 'Smgo';
// 値を取る長いオプション。GNU は一意な省略形（--suf）も受け付ける
const LONG_FLAGS_WITH_VALUE = ['suffix', 'mode', 'owner', 'group', 'strip-program', 'sparse', 'no-preserve'];
// 値を取るオプションの表 { long, short }。cp、ln、install は共通の表で読む
const COPY_FLAGS_WITH_VALUE = { long: LONG_FLAGS_WITH_VALUE, short: SHORT_FLAGS_WITH_VALUE };
// mv が値を取るのは --suffix と -S だけ（-t は targetDirectoryOf が読む）。--strip と --st は --strip-trailing-slashes の省略形で値を取らず
// （coreutils 9.4 で確かめた）、-m、-g、-o は install のもの（mv -g . /tmp/x の . は元）
const MV_FLAGS_WITH_VALUE = { long: ['suffix'], short: 'S' };
const flagsWithValueOf = (tool) => (tool === 'mv' ? MV_FLAGS_WITH_VALUE : COPY_FLAGS_WITH_VALUE);
const FIND_ACTIONS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir']);
const TOUCH_FLAGS_WITH_VALUE = new Set(['-r', '-d', '-t', '--reference', '--date']);
// find の書き込み先を値に取るアクション（-fprintf は値の次に書式を取る）
const FIND_OUTPUTS = new Set(['-fprint', '-fprint0', '-fprintf', '-fls']);

// 値を取るオプション（targetDirectoryOf と同じ表）の値を除いた位置引数。install x .claude/hooks/y -m 600 の 600 は -m の値で、宛先は y。
// -- の後ろは全部が位置引数。flags は道具ごとの値を取るオプションの表（flagsWithValueOf）
function copyOperands(args, flags = COPY_FLAGS_WITH_VALUE) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') return [...result, ...args.slice(i + 1)];
    const long = /^--([a-z-]+)(=[\s\S]*)?$/.exec(a);
    if (long) {
      if (long[2] === undefined && flags.long.some((full) => abbreviates(long[1], full))) i++;
      continue;
    }
    if (!/^-[^-<>]/.test(a)) {
      result.push(a);
      continue;
    }
    const at = [...a].findIndex((c, k) => k > 0 && flags.short.includes(c));
    if (at === a.length - 1) i++;
  }
  return result;
}

// tar のアーカイブ（-f の値）。-cf x のようにまとめた形、-cfx、--file x、--file=x、ダッシュの無い古い形（tar cf x）。
// { archives, directories, modes } の directories は -C の値（-C x、-Cx、--directory x、--directory=x）で、展開するときの書き込み先。
// modes は動作の文字（c、r、u、A、x、t、d と、長い形を同じ文字にそろえたもの）
const TAR_LONG_MODES = {
  create: 'c', append: 'r', update: 'u', concatenate: 'A', catenate: 'A', delete: 'D', extract: 'x', get: 'x', list: 't', diff: 'd', compare: 'd',
};
function tarOperands(args) {
  const archives = [];
  const directories = [];
  const modes = new Set();
  const take = (flag, value) => (flag === 'f' ? archives : directories).push(value ?? '');
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    const long = /^--([a-z-]+)(=([\s\S]*))?$/.exec(a);
    if (long) {
      if (TAR_LONG_MODES[long[1]]) modes.add(TAR_LONG_MODES[long[1]]);
      if (long[1] === 'file' || long[1] === 'directory') take(long[1] === 'file' ? 'f' : 'C', long[2] === undefined ? args[++i] : long[3]);
    } else if (i === 0 && /^[a-zA-Z]+$/.test(a)) {
      // 古い形は、f と C の位置を問わず、文字の順に次の語が値（tar cfz x.tgz y、tar xfC x.tar dir）
      for (const c of a) {
        if ('crutAxd'.includes(c)) modes.add(c);
        if (c === 'f' || c === 'C') take(c, args[++i]);
      }
    } else if (/^-[^-]/.test(a)) {
      for (let k = 1; k < a.length; k++) {
        if ('crutAxd'.includes(a[k])) modes.add(a[k]);
        if (a[k] !== 'f' && a[k] !== 'C') continue;
        take(a[k], k + 1 < a.length ? a.slice(k + 1) : args[++i]);
        break;
      }
    }
  }
  return { archives, directories, modes };
}

// -t DIR、-tDIR、-vt DIR、--target-directory DIR、--target-directory=DIR（GNU は長いオプションを一意な省略形でも受け付ける）の宛先。
// { dir, valueAt, at } の valueAt は、値が独立した語のときのその位置（連結の形は -1）、at は値を含む語の位置。無ければ null。
// 他の値を取るフラグ（-S -t /tmp/x の -t、--suffix -- の --）の次の語は、その値であってオプションではないので飛ばす
function targetDirectoryOf(args, flags = COPY_FLAGS_WITH_VALUE) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') return null;
    const long = /^--([a-z-]+)(=([\s\S]*))?$/.exec(a);
    if (long) {
      if (abbreviates(long[1], 'target-directory')) {
        return long[2] === undefined ? (args[i + 1] === undefined ? null : { dir: args[i + 1], valueAt: i + 1, at: i + 1 }) : { dir: long[3], valueAt: -1, at: i };
      }
      if (long[2] === undefined && flags.long.some((full) => abbreviates(long[1], full))) i++;
      continue;
    }
    if (!/^-[^-<>]/.test(a)) continue;
    for (let k = 1; k < a.length; k++) {
      if (flags.short.includes(a[k])) {
        if (k + 1 === a.length) i++;
        break;
      }
      if (a[k] !== 't') continue;
      if (k + 1 < a.length) return { dir: a.slice(k + 1), valueAt: -1, at: i };
      return args[i + 1] === undefined ? null : { dir: args[i + 1], valueAt: i + 1, at: i + 1 };
    }
  }
  return null;
}

// 書き込みのリダイレクトの先が matches に当たるか。先の中の置換の中身（> "$(echo .claude)/settings.json"）も redirectTexts で照合する。
// > "$(mktemp)" は mktemp が当たらず通る
function redirectHits(matches, redirect) {
  return redirectTexts(redirect).some(matches);
}

// 書き込み先のどれかが matches（isProtectedPath か mentionsSecret）に当たるか。守る先とシークレットで道具の表を共用する。
// words は区切りの全部の語。リダイレクトは語の並びの外にある区切りの属性で、道具の前に置いたもの（> f cat x）や、道具の無い区切り（> f、exec > f）にもあるので args でなく words で見る。
// anyOperand は、書き込み先か読み取り元かを区別せずに止めてよいとき（シークレット）に付ける。
// コピーの宛先は、GNU の並べ替え（install x .dev.vars -m 600）で最後とは限らないので、位置引数のどれかを見る。
// find -exec は書くか読むかが分からないので、名前が引数にあれば止める。
// 守る先では、コピーの元（cp .claude/hooks/x.mjs /tmp/）と find -exec での読み取り（find .claude/hooks -exec grep）に確認を挟まないよう、
// コピーは最後の引数（と、値を取るオプションの値を除いた最後の引数）だけを見て、find は -fprint などの書き込み先だけを見る。
// intoDirectory は wrangler の設定と守る先の判定に付け、宛先がディレクトリのコピーを元の名前で見る（copiesIntoDirectory の into）。
// anyInstallOperand を付けると（wrangler の設定）、install は GNU の並べ替えがあるので位置引数のどれかも見る
function writesTo(matches, tool, args, words, { anyOperand = false, intoDirectory = null } = {}) {
  if (redirectsOf(words).some((r) => isWriteRedirect(r) && redirectHits(matches, r))) return true;
  if (GNU_PREFIXED.has(tool)) tool = tool.slice(1);
  const pos = positionals(args);
  if (['sed', 'perl'].includes(tool) && args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a))) {
    return pos.some(matches);
  }
  // touch の -r、-d、-t の値は、時刻を読むファイルか時刻で、書き込み先ではない（touch -r .claude/hooks/x docs/new.md）
  if (tool === 'touch') return positionals(args, TOUCH_FLAGS_WITH_VALUE).some(matches);
  if (MULTI_ARG_WRITERS.has(tool)) return pos.some(matches);
  if (COPY_TOOLS.has(tool)) {
    const target = TARGET_DIRECTORY_TOOLS.has(tool) ? targetDirectoryOf(args, flagsWithValueOf(tool)) : null;
    if (target) {
      // -t のときの宛先は target のディレクトリで、位置引数は全部が元。
      // 読み違えても取りこぼさないよう、この後の「最後の位置引数を宛先として見る」判定も残し、どちらかに当たれば止める
      const sources = positionals(args.filter((_, j) => j !== target.valueAt));
      if (isUnresolved(args, target.at)) {
        // 宛先が展開で決まる（-t "$PWD"）ときは置かれる先を判定できないので、元の名前が設定の名前に当たれば止める
        if (intoDirectory !== null && placedIntoUnknown(matches, sources, shapeAt(args, target.at), intoDirectory)) return true;
      } else {
        if (anyOperand ? [...sources, target.dir].some(matches) : matches(target.dir)) return true;
        if (intoDirectory !== null && copiesIntoDirectory(matches, [...sources, target.dir], intoDirectory, true)) return true;
      }
    }
    const anyDestination = anyOperand || (intoDirectory?.anyInstallOperand === true && tool === 'install');
    if (anyDestination ? pos.some(matches) : matches(pos.at(-1) ?? '') || matches(copyOperands(args, flagsWithValueOf(tool)).at(-1) ?? '')) return true;
    // 守る先は、最後の位置引数が展開で決まる（cp /tmp/settings.json "$D"）ときも -t と同じに見る
    const last = positionalIndexes(args).at(-1);
    if (intoDirectory?.unresolvedDestination && pos.length >= 2 && isUnresolved(args, last)) {
      if (placedIntoUnknown(matches, pos.slice(0, -1), shapeAt(args, last), intoDirectory)) return true;
    }
    return intoDirectory !== null && copiesIntoDirectory(matches, pos, intoDirectory);
  }
  if (tool === 'dd') return args.some((a) => a.startsWith('of=') && matches(a.slice('of='.length)));
  if (tool === 'tar') {
    // -f のアーカイブに書くのは作る、足す、更新する、つなぐ、消す（c、r、u、A、--delete）とき、-C の先に書くのは展開（x）だけ。
    // 一覧（t）と比べる（d）は読むだけ。動作を判定できないときは両方を書き込み先とみなす
    const { archives, directories, modes } = tarOperands(args);
    const unknown = modes.size === 0;
    const writesArchive = unknown || [...'cruAD'].some((m) => modes.has(m));
    const extracts = unknown || modes.has('x');
    return [...(writesArchive ? archives : []), ...(extracts ? directories : [])].some(matches);
  }
  if (tool === 'find') {
    if (args.some((a, j) => FIND_OUTPUTS.has(a) && matches(args[j + 1] ?? ''))) return true;
    return anyOperand && args.some((a) => FIND_ACTIONS.has(a)) && args.some(matches);
  }
  if (tool === 'git') {
    // git archive の -o と git format-patch の -o（出力のディレクトリ）も、値を書き込み先として見る
    const sub = positionals(args, GIT_FLAGS_WITH_VALUE)[0];
    const short = sub === 'archive' || sub === 'format-patch';
    return args.some(
      (a, j) =>
        (/^--output(-directory)?=/.test(a) && matches(a.slice(a.indexOf('=') + 1))) ||
        ((a === '--output' || a === '--output-directory' || (short && a === '-o')) && matches(args[j + 1] ?? '')) ||
        (short && /^-o./.test(a) && matches(a.slice(2))),
    );
  }
  return false;
}

// 宛先が展開で決まるコピーで、元が守りたい先に置かれうるか。into.placeable があれば元の名前をそれで（守る先の名前、git のフックの名前、*.sql）、
// 無ければ matches で（wrangler の設定の名前）見る。into.destinationHint は宛先の展開されない部分（shape）で見る（"$PWD/.claude"）。
// 展開が多すぎて名前を出せない元は当たるものとして扱う
function placedIntoUnknown(matches, sources, destinationShape, into) {
  if (into.destinationHint?.test(destinationShape)) return true;
  return sources.some((src) => namesCopiedFrom(src, into)?.some(into.placeable ?? matches) ?? true);
}

// インタープリタに渡した語。位置引数とヒアドキュメントの本文は、-e の本文の中のパス（writeFileSync('wrangler.jsonc')）を
// 拾えるよう、空白、引用符、括弧で区切った語も見る
function interpreterWords(tool, args) {
  if (!INTERPRETERS.has(tool)) return [];
  const bodies = [...args, ...heredocBodies(args)];
  return bodies.flatMap((b) => [b, ...b.split(CODE_SEPARATORS).filter(Boolean)]);
}

// インタープリタの本文（-e、-c、-r、-p、--eval の値と、-pe のようにまとめた形の値、ヒアドキュメントとヒアストリングの本文）を、
// 空白、引用符、括弧で区切った語。位置引数のファイル（node --test .claude/hooks/guards.test.mjs）は本文ではないので入れない
// 連結した値（perl -e'…'、python3 -c'…'）も本文とする。本文を取る短いフラグはインタープリタごとに違う。
// -c は python では本文、node、perl、ruby では構文の確かめ、php では設定のパス。-r は php では本文、node と ruby では require。
// perl の -p は行ごとに回すだけのフラグ。node の --print も -p と同じ。tclsh と deno は本文をヒアドキュメントとヒアストリングでだけ見る
const BODY_FLAGS = { node: 'ep', bun: 'ep', python: 'c', python3: 'c', ruby: 'e', perl: 'eE', php: 'rRBE', osascript: 'e' };
function interpreterBodyWords(tool, args) {
  const bodies = heredocBodies(args);
  const flags = BODY_FLAGS[tool] ?? '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const long = /^--(eval|print)(=([\s\S]*))?$/.exec(a);
    if (long) {
      if (long[2] !== undefined) bodies.push(long[3]);
      else if (args[i + 1] !== undefined) bodies.push(args[i + 1]);
      continue;
    }
    if (!/^-[a-zA-Z]/.test(a)) continue;
    const at = [...a].findIndex((c, k) => k > 0 && flags.includes(c));
    if (at === -1) continue;
    // 最初の本文のフラグより後ろが連結した値。-pe 'code' のように文字だけの語が本文のフラグで終われば、次の語も本文とする
    if (at + 1 < a.length) bodies.push(a.slice(at + 1));
    if (new RegExp(`^-[a-zA-Z]*[${flags}]$`).test(a) && args[i + 1] !== undefined) bodies.push(args[i + 1]);
  }
  return bodies.flatMap((b) => b.split(CODE_SEPARATORS).filter(Boolean));
}

// fish の -c のほかに中身を Bash のコマンドとして読む値（--command、--command=、-C、--init-command、--init-command=）
function fishCommands(args) {
  const found = [];
  for (let i = 0; i < args.length; i++) {
    const long = /^--(command|init-command)(=([\s\S]*))?$/.exec(args[i]);
    if (long) found.push(long[2] === undefined ? (args[++i] ?? '') : long[3]);
    else if (args[i] === '-C') found.push(args[++i] ?? '');
  }
  return found;
}

// 本文の中の wrangler（python3 -c 'os.system("wrangler deploy")'）と守る先（writeFileSync(".claude/settings.json", …)）には確認を挟む。
// 本文の中のコマンドの引数（--remote など）は読めないので、止めずに人が確かめる
function judgeInterpreterBody(tool, args) {
  const words = interpreterBodyWords(tool, args);
  if (words.some((w) => isWrangler(w) || isCfWrangler(w))) {
    return [ASK, 'インタープリタの本文から wrangler を動かすと、本番に触るかを判定できない。人が確かめる'];
  }
  if (words.some(isProtectedPath)) return [ASK, 'インタープリタの本文に守る仕組み（Claude の設定とフック）とマイグレーションの名前がある。書き換えは人が確かめる'];
  return null;
}

// 道具の無い区切り（> f、exec > f）と cd、pushd のリダイレクトも見るので、tool を空、args を空にして呼べる。
// dir は作業場所（分からなければ null）。wrangler の設定は相対パスを dir から解決しても見る
function judgeFileWrites(tool, args, words, dir = null) {
  const results = [];
  if (judgeSecretAccess(tool, args, words) || writesTo(mentionsSecret, tool, args, words, { anyOperand: true })) {
    results.push([DENY, SECRET_FILE_REASON]);
  }
  // mv は元を消すので、元が守る先（mv .githooks/pre-commit /tmp/）でも守りが外れる。コピーの元（cp .claude/hooks/x.mjs /tmp/）は見ない
  const isProtected = protectedAt(dir);
  const movesProtected = ['mv', 'gmv'].includes(tool) && positionals(args).some(isProtected);
  const intoProtected = {
    dir,
    names: PROTECTED_NAMES,
    bareGlob: true,
    anywhere: true,
    unresolvedDestination: true,
    placeable: placedInProtected,
    destinationHint: PROTECTED_DIRECTORY_HINT,
  };
  if (writesTo(isProtected, tool, args, words, { intoDirectory: intoProtected }) || movesProtected) {
    results.push([ASK, '守る仕組み（Claude の設定とフック）とマイグレーションの書き換えは人が確かめる']);
  }
  const isConfig = wranglerConfigAt(dir);
  if (writesTo(isConfig, tool, args, words, { intoDirectory: { dir, names: WRANGLER_CONFIG_NAMES, anyInstallOperand: true } }) || interpreterWords(tool, args).some(isConfig)) {
    results.push([ASK, 'wrangler の設定（wrangler.jsonc、.wrangler/deploy/config.json）に remote の binding を入れると、wrangler dev が本番の D1 と R2 に届く。書き換えは人が確かめる']);
  }
  return results;
}

const REMOVES_PROTECTED_REASON = '守る仕組み（Claude の設定とフック）とマイグレーションを消すか動かすと守りが外れる。何が消えるかを人が確かめる';
const REMOVES_ROOT_REASON = 'リポジトリの根かその祖先（.、..、/、~ など）を消すか動かすと、作業コピーと守る仕組みごと失う。どこを消すかを人が確かめる';
// 消すか動かす道具の元を、守る先かリポジトリの根とその祖先かで見る。rm -rf worktrees/x は根の祖先でも守る先でもないので通す
function judgeRemoval(tool, args, ctx) {
  const removed = removedPaths(tool, args);
  return removed.length === 0 ? null : removalJudge(ctx)(removed);
}

// 消すか動かす語の並びを判定する関数。守る先の照合と根は ctx ごとに1回だけ作る（-execdir の起点ごとに呼ぶため）
function removalJudge(ctx) {
  const isProtected = protectedAt(ctx.dir);
  // 作業場所が分からないまま cd した先（cd .claude && find hooks -delete）は、書かれた行き先をつないで見る
  const written = (word) => (ctx.dir || ctx.place == null || path.posix.isAbsolute(word) ? word : path.posix.join(ctx.place, word));
  const roots = [...new Set([ctx.root, ctx.dir && repoRootOf(ctx.dir)].filter(Boolean))];
  // 作業場所が分からなくなった後（cd -P ..、popd、cd ~）は、始めの根の名前と根の祖先の名前で消す形（rm -rf scrum-guild）を止める
  const rootNames = !ctx.dir && ctx.root ? ancestorNames(ctx.root) : null;
  const namesRoot = (w) => rootNames?.has(path.posix.basename(path.posix.normalize(w)).toLowerCase()) === true;
  // {a,b} はシェルが展開してから渡すので、展開した語のどれかで見る（rm -rf {.,build}）。展開が大きすぎる語は当たるものとする（protectedAt と同じ）
  const hitsRoot = (w) => expansionSize(w) > MAX_BRACE_EXPANSION || expandBraces(w).some((e) => removesRoot(e, ctx.dir, roots) || namesRoot(e));
  return (removed) => {
    if (removed.some((w) => isProtected(w) || isProtected(written(w)))) return [ASK, REMOVES_PROTECTED_REASON];
    if (removed.some(hitsRoot)) return [ASK, REMOVES_ROOT_REASON];
    return null;
  };
}

// 根とその祖先のディレクトリの名前（小文字。APFS は大文字小文字を区別しない）
function ancestorNames(root) {
  const names = new Set();
  for (let d = root; d !== path.dirname(d); d = path.dirname(d)) names.add(path.basename(d).toLowerCase());
  return names;
}

// 消すか動かす元。rm と rmdir は位置引数の全部、mv は宛先を除いた位置引数（-t があれば位置引数の全部）、find は -delete があるときの起点
function removedPaths(tool, args) {
  if (GNU_PREFIXED.has(tool)) tool = tool.slice(1);
  if (tool === 'rm' || tool === 'rmdir') return positionals(args);
  if (tool === 'mv') {
    const target = targetDirectoryOf(args, MV_FLAGS_WITH_VALUE);
    if (!target) return copyOperands(args, MV_FLAGS_WITH_VALUE).slice(0, -1);
    // -t のときは位置引数の全部が元。-t の値の語（連結の形は -t を含む語ごと）を外し、-S などの値も除く（mv -S '~' -t /tmp/x build の ~）
    const flagWord = target.valueAt === -1 ? target.at : -1;
    return copyOperands(
      args.filter((_, j) => j !== target.valueAt && j !== flagWord),
      MV_FLAGS_WITH_VALUE,
    );
  }
  if (tool === 'find' && args.includes('-delete')) return findStartingPoints(args);
  return [];
}

// 語がリポジトリの根か根の祖先（/ を含む）を指すか。根が分かり、語を解決できる（作業場所が分かるか、/ か ~ で始まる）ときは絶対パスで比べる。
// ~ は判定のたびに os.homedir() で解決する（HOME が変わりうる）。~名前 は解決しない。
// それ以外は字面で、末尾の / を外して . と .. だけからなる語（.、./..、../..）、/、~ に当てる。
// ~+ は作業場所（$PWD）なので、作業場所が分かれば解決し、分からなければ . と同じに見る。~- は前の作業場所（$OLDPWD）で、判定できないので当たるものとする
function removesRoot(word, dir, roots) {
  if (/^~-(\/|$)/.test(word)) return true;
  if (/^~\+(\/|$)/.test(word)) word = (dir && roots.length > 0 ? dir : '.') + word.slice(2);
  if (roots.length > 0 && (dir || /^[/~]/.test(word))) {
    if (/^~(?!\/|$)/.test(word)) return false;
    // HOME が無く passwd にも無いと os.homedir() は投げる。ホームを引けない ~ は判定できないので当たるものとする
    let home = null;
    try {
      home = path.resolve(os.homedir());
    } catch {
      if (word.startsWith('~')) return true;
    }
    const absolute = word.startsWith('~') ? path.resolve(path.join(home, word.slice(1))) : path.resolve(dir ?? '/', word);
    // ホームそのものと / は、字面の判定と同じく根との関係を問わず当たる（根がホームの外にあっても rm -rf ~ は止める）
    if (absolute === '/' || absolute === home) return true;
    // APFS は大文字小文字を区別しないので、小文字にそろえて比べる（守る先と同じ）
    return roots.some((root) => {
      const inside = path.relative(absolute.toLowerCase(), root.toLowerCase());
      return inside !== '..' && !inside.startsWith(`..${path.sep}`) && !path.isAbsolute(inside);
    });
  }
  // /. は /、~/. は ~、src/.. は . と同じ道なので、正規化してから見る。~ がホームになるのは語の先頭のときだけ（./~ は ~ という名前のファイル）
  const bare = path.posix.normalize(word).replace(/\/+$/, '') || '/';
  return bare === '/' || (bare === '~' && word.startsWith('~')) || /^\.\.?(\/+\.\.?)*$/.test(bare);
}

// find の起点。前に置くオプション（GNU の -H、-L、-P、-D の値、-O と、オプションの終わりの --。
// BSD の -E、-X、-d、-s、-x（-Ex のようにまとめた形も）と、値を起点として取る -f path）の後ろから、- か ( か ! で始まる語の手前まで。無ければ .
function findStartingPoints(args) {
  const starts = [];
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      i++;
      break;
    }
    if (a === '-D') i++;
    else if (a === '-f') {
      if (args[i + 1] !== undefined) starts.push(args[++i]);
    } else if (!/^-([HLPEXdsx]+|O\d*)$/.test(a)) break;
  }
  for (; i < args.length && !/^[-(!),]/.test(args[i]); i++) starts.push(args[i]);
  return starts.length > 0 ? starts : ['.'];
}

const FIND_EXECS = new Set(['-exec', '-execdir', '-ok', '-okdir']);
// find の -exec 系で、{} を起点に置き換えて掛け直すコマンドの数と重さ（findCommands の weight）の上限（コマンドぜんたいで数える）。
// 重さは、起点 256 の grep x {} + を通し、重い glob を並べた cp を 1 秒以内に止める大きさにする
const MAX_FIND_COMMANDS = 256;
const MAX_FIND_WEIGHT = 8192;
const FIND_COMMANDS_REASON = [ASK, 'find の起点と -exec の入れ子が多く、{} を起点に置き換えて掛け直すコマンドが多すぎるので判定しない。何を実行するかを人が確かめる'];
// find の -exec、-execdir、-ok、-okdir の後ろのコマンド（; か、{} の後ろの + まで）。語の中の {} も含めて、{} を起点のそれぞれに置き換えた語の並び。
// 書き込み（rm、sed -i）か読み取り（grep、cat）かを、置き換えた後のコマンドで今の規則に判定させる
// -execdir と -okdir は、見つけたファイルのそれぞれについて、そのファイルのあるディレクトリで動かす。起点そのものは起点の親で {} が ./<basename> になる。
// 起点の下の深いファイルの親は数えきれないので、有限の候補で見る。起点の親と起点に加え、起点が守る先を含みうる（根か根の祖先、守る先かその中。holdsProtected）ときは、
// 起点の下の守る先のディレクトリ（PROTECTED_SUBDIRS）も作業場所にする（find . -execdir rm pre-commit \; は .githooks/pre-commit を消す）。
// 起点の {a,b} は、シェルが展開してから渡すので展開してから dirname を取る（find {x,.claude/settings.json} -execdir は .claude でも動く）。
// { words, to } の to は、find の作業場所から見た掛け直すときの作業場所（-exec は null）。
// 判定の前に { count, weight } で重さを返す。count は -exec 系の数と起点の数の積、weight は作業場所の数と、掛け直すコマンドの語の数と
// 語の {a,b} の展開の数（{} に入る起点の展開も掛ける）の和の積
const PROTECTED_SUBDIRS = ['.claude', '.claude/hooks', '.githooks', 'migrations', 'hooks'];
function findCommands(args, holdsProtected) {
  const starts = findStartingPoints(args);
  const execs = [];
  for (let i = 0; i < args.length; i++) {
    if (!FIND_EXECS.has(args[i])) continue;
    let end = i + 1;
    while (end < args.length && args[end] !== ';' && !(args[end] === '+' && args[end - 1] === '{}')) end++;
    const at = [...Array(end - i - 1).keys()].map((k) => i + 1 + k);
    if (at.length > 0) execs.push({ at, inDir: args[i].endsWith('dir') });
    i = end;
  }
  // runsFound は、-exec 系の後ろのコマンドの道具の位置（前置きを飛ばした位置）の語に {} があるか
  const runsFound = execs.some(({ at }) => {
    const words = sliceWords(args, at[0], at.at(-1) + 1);
    const ci = commandIndex(words);
    return ci !== -1 && words[ci].includes('{}');
  });
  const count = execs.length * starts.length;
  if (count > MAX_FIND_COMMANDS) return { count, weight: Infinity, build: () => [], runsFound };
  const size = (word) => Math.min(expansionSize(word), MAX_BRACE_EXPANSION + 1);
  // -execdir 系は起点の展開ごとに守る先を含みうるかを見るので重い。重さの下限（展開ごとに作業場所 2 つ × 語の数）を先に見積もり、
  // 上限を超えるなら組み合わせを作らずに打ち切る
  const leastWeight = execs.reduce((sum, { at, inDir }) => sum + (inDir ? starts.reduce((s, start) => s + size(start), 0) * 2 * at.length : 0), 0);
  if (leastWeight > MAX_FIND_WEIGHT) return { count, weight: Infinity, build: () => [], runsFound };
  // 掛け直す組み合わせ。{ at, placed, tos } の placed は {} に入れる語、tos は作業場所の候補
  const plans = execs.flatMap(({ at, inDir }) =>
    starts.flatMap((start) => {
      if (!inDir) return [{ at, placed: start, tos: [null] }];
      if (expansionSize(start) > MAX_BRACE_EXPANSION) return [{ at, placed: start, tos: [], tooBig: true }];
      return expandBraces(start).map((e) => ({
        at,
        placed: `./${path.posix.basename(e)}`,
        tos: [path.posix.dirname(e), e, ...(holdsProtected(e) ? PROTECTED_SUBDIRS.map((c) => path.posix.join(e, c)) : [])],
      }));
    }),
  );
  const weightOf = ({ at, placed, tos, tooBig }) =>
    tooBig ? Infinity : tos.length * at.reduce((w, k) => w + 1 + (args[k].includes('{}') ? size(args[k].replaceAll('{}', '')) * size(placed) : size(args[k])), 0);
  const weight = plans.reduce((sum, plan) => sum + weightOf(plan), 0);
  const build = () =>
    plans.flatMap(({ at, placed, tos }) => {
      const words = concatWords(...at.map((k) => (args[k].includes('{}') ? [args[k].replaceAll('{}', placed)] : sliceWords(args, k, k + 1))));
      return tos.map((to) => ({ words, to }));
    });
  return { count, weight, build, runsFound };
}

// 作業場所を to（書かれた行き先）へ移した ctx。作業場所が分からないときは、書かれた行き先（place）につなぐ。~ と展開で決まる行き先は判定できない
function movedTo(ctx, to, unresolved = false) {
  if (unresolved || /^[~$]/.test(to)) return { ...ctx, dir: null, place: null };
  if (path.posix.isAbsolute(to)) return { ...ctx, dir: to, place: to };
  return { ...ctx, dir: ctx.dir && path.resolve(ctx.dir, to), place: ctx.place == null ? null : path.posix.join(ctx.place, to) };
}

// WORKERS_CI=1 は deploy() が本番に触る唯一の条件で、付けるのは Workers Builds だけ。値は問わず、名前がちょうど WORKERS_CI のものだけを見る
// （WORKERS_CI_COMMIT_SHA は Workers Builds が渡す別の変数）
const WORKERS_CI_REASON = 'WORKERS_CI は Workers Builds だけが付ける。試すのは人に任せる（手元のセッションでは ! を付けて打ってもらう）';
const ENV_DECLARERS = new Set(['export', 'declare', 'typeset', 'readonly', 'local']);

// ci は道具の位置（WORKERS_CI=1; export WORKERS_CI の最初の区切りのように、道具が無いときは -1）。
// 道具の前の代入（env を含む）と、export などの引数を見る。引数を実行しない道具（echo、grep、git、gh など）の引数と、
// ヒアドキュメントの本文は見ない。それ以外の道具は、npx dotenv -v WORKERS_CI=1 -- node x のように後ろへ代入を渡せるので、引数のどこにあっても止める
// （findWrangler と同じ考え方）
const WORKERS_CI_ASSIGN = /^WORKERS_CI\+?=/;
function setsWorkersCi(words, ci) {
  if (words.slice(0, ci === -1 ? words.length : ci).some((w) => WORKERS_CI_ASSIGN.test(w))) return true;
  if (ci === -1) return false;
  const tool = baseName(words[ci]);
  const args = words.slice(ci + 1);
  if (ENV_DECLARERS.has(tool)) return args.some((w) => /^WORKERS_CI(\+?=|$)/.test(w));
  return !isNonExecuting(tool) && args.some((w) => WORKERS_CI_ASSIGN.test(w));
}

// 引数のスクリプトを動かす道具。テストが偽の wrangler で動くため、デプロイのスクリプトを渡すと本番の入口が動く
const RUNNERS = new Set(['node', 'nodejs', 'tsx', 'ts-node', 'bun', 'deno']);
// 値がパスではなく名前の正規表現なので、判定から外すフラグ（node --test --test-name-pattern x scripts/deploy.test.ts）
const PATTERN_FLAGS = new Set(['--test-name-pattern', '--test-skip-pattern']);
const DEPLOY_PATH = /(^|\/)scripts\/deploy[^/]*$/;
const DEPLOY_ENTRIES = ['scripts/deploy.ts', 'scripts/deploy-production.ts'];
// *、?、[、{ のどれか、または extglob の !(、+(、@(。{a,b} も glob として照合する
const GLOB_CHARS = /[*?[{]|[!+@]\(/;
// 展開が多い glob（{1..1000000}、{a,b} を何個も並べた形）は matchesGlob が展開するので、数が多いと終わらない。照合せず確認を挟む
const MAX_BRACE_EXPANSION = 256;
// -e の値やヒアドキュメントの本文は複数の語を含むので、空白、引用符、括弧で区切って1語ずつ判定する
const CODE_SEPARATORS = /[\s'"()`]+/;
// 引数のスクリプトを読んで動かす道具（実行の道具は RUNNERS）。位置引数は区切らずに見る
const SCRIPT_READERS = new Set([...SHELLS, 'source', '.']);

// 語が展開で別の文字列になりうるか（変数、$(…)、glob、{a,b}、zsh の括弧の glob、~名前、引用符の中の "src$X"）。
// cd の行き先と -C の値がこれに当たると、作業場所を解決できない
function isUnresolved(words, i) {
  return expandsAt(words, i) || shapeAt(words, i).includes(DYNAMIC);
}


// 実行の道具が読むファイルの候補。位置引数、--flag=値 の右側（--import=、--require= など）、
// ヒアドキュメントとヒアストリングの本文を返す。リダイレクトは stdinTargets が別に見る
function runnerWords(args) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') continue;
    if (!a.startsWith('-')) {
      result.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (PATTERN_FLAGS.has(eq === -1 ? a : a.slice(0, eq))) {
      if (eq === -1) i++;
      continue;
    }
    if (eq !== -1) result.push(a.slice(eq + 1));
  }
  return [...result, ...heredocBodies(args)];
}

// node < scripts/deploy-production.ts と bash < scripts/deploy.sh の読み込み元。道具の前に置いた < も拾う
const stdinTargets = (words) => redirectsOf(words).filter(isReadRedirect).flatMap(redirectTexts);

function matchesGlob(target, pattern) {
  // 無い Node で false を返すと素通りになる。投げれば guard-bash が exit 2 で止める
  if (typeof path.matchesGlob !== 'function') throw new Error('path.matchesGlob が使えない Node では glob を判定できない');
  try {
    return path.matchesGlob(target, pattern);
  } catch {
    // 壊れた glob は照合できない。止めすぎるより、他の判定に任せる
    return false;
  }
}

// dir から上へ、scripts/deploy-production.ts のあるディレクトリ（リポジトリの根）を探す。見つからなければ null
// 探した結果は、辿ったディレクトリのそれぞれについて覚える（深い作業場所で -execdir の起点ごとに探すと、段数の2乗で重くなるため）。
// 覚えるのは judgeBash の1回の呼び出しの間だけ（rootCache.clear()）
const rootCache = new Map();
function repoRootOf(dir) {
  const visited = [];
  let found = null;
  for (let d = dir; ; d = path.dirname(d)) {
    if (rootCache.has(d)) {
      found = rootCache.get(d);
      break;
    }
    visited.push(d);
    if (existsSync(path.join(d, DEPLOY_ENTRIES[1]))) {
      found = d;
      break;
    }
    if (d === path.dirname(d)) break;
  }
  for (const d of visited) rootCache.set(d, found);
  return found;
}

// glob の固定の部分（最初の glob の文字より前のディレクトリ）
function fixedDirOf(pattern) {
  const head = pattern.slice(0, pattern.search(GLOB_CHARS));
  const slash = head.lastIndexOf('/');
  return slash === -1 ? '' : head.slice(0, slash) || '/';
}

// 固定の部分とその祖先のそれぞれに入口を付けて照合する。scripts/*.ts は祖先の 1 つ上から scripts/deploy.ts が当たり、scripts/*.test.ts は当たらない
function ancestorsHit(pattern) {
  for (let dir = fixedDirOf(pattern); ; dir = path.posix.dirname(dir)) {
    if (DEPLOY_ENTRIES.some((entry) => matchesGlob(path.posix.join(dir, entry), pattern))) return true;
    if (path.posix.dirname(dir) === dir) return false;
  }
}

// glob に変数の語を含む区間（worktrees/*/scripts/*.ts）があり、その後ろが scripts/<入口の名前に当たる語> で終わるか。
// 固定の部分から根を探せない glob のために、実在を確かめずに形だけ見る
function scriptsSegmentHit(pattern) {
  const segments = pattern.split('/');
  const [dirName, last] = segments.slice(-2);
  if (dirName !== 'scripts' || !segments.slice(0, -2).some((s) => GLOB_CHARS.test(s))) return false;
  return DEPLOY_ENTRIES.some((entry) => matchesGlob(path.posix.basename(entry), last));
}

// glob が scripts/deploy.ts か scripts/deploy-production.ts に当たるか。
// 解決した glob を、作業場所の根と、glob の固定の部分から見つかる根（別のチェックアウトや絶対パスの先）の入口の絶対パスに照合する。
// 根の入口だけに照合するので、test/**/*.ts のような無関係な glob は止めない。
// どちらの根も見つからない（場所が不明か、リポジトリの外）ときは、書かれた形と解決した形の固定の部分と祖先に入口を付けて照合する。
// 根は小文字にする前の absolute から探す。大文字と小文字を区別するファイルシステム（Linux）では、小文字にしたパスは見つからない
function globHitsDeploy(written, resolved, absolute, workRoot) {
  const roots = new Set([workRoot, absolute && repoRootOf(fixedDirOf(absolute))].filter(Boolean));
  if (resolved && [...roots].some((r) => DEPLOY_ENTRIES.some((e) => matchesGlob(path.join(r, e).toLowerCase(), resolved)))) return true;
  if (scriptsSegmentHit(written) || (resolved && scriptsSegmentHit(resolved))) return true;
  return roots.size === 0 && (ancestorsHit(written) || (resolved !== null && ancestorsHit(resolved)));
}

// {a,b} と {1..n} の展開の数を、展開せずに見積もる。上限を超えたら数え続けない
function expansionSize(text) {
  let total = 1;
  for (let i = 0; i < text.length && total <= MAX_BRACE_EXPANSION; i++) {
    if (text[i] !== '{') continue;
    let depth = 1;
    let j = i + 1;
    for (; j < text.length && depth > 0; j++) depth += text[j] === '{' ? 1 : text[j] === '}' ? -1 : 0;
    if (depth > 0) break;
    total *= braceSize(text.slice(i + 1, j - 1));
    i = j - 1;
  }
  return total;
}

function braceSize(inner) {
  const range = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(inner);
  if (range) return Math.floor(Math.abs(range[2] - range[1]) / (Math.abs(range[3]) || 1)) + 1;
  if (/^[a-z]\.\.[a-z]$/i.test(inner)) return 52;
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let k = 0; k < inner.length; k++) {
    if (inner[k] === '{') depth++;
    else if (inner[k] === '}') depth--;
    else if (inner[k] === ',' && depth === 0) {
      parts.push(inner.slice(start, k));
      start = k + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts.length < 2 ? 1 : parts.reduce((sum, p) => sum + expansionSize(p), 0);
}

// テスト（scripts/deploy*.test.ts）は偽の wrangler と fetch で手順を呼ぶだけなので外す。
// --test の有無では見分けない。node --test scripts/deploy-production.ts も本番の入口を実行する。
// 外すのは英数字と . / * - _ だけの語に限る。deploy-production.ts$IFS.test.ts はシェルが2語に分け、
// --import ./scripts/deploy-production.ts#.test.ts は Node が # 以降を URL のフラグメントとして捨てる
const isTestFile = (word) => /^[\w./*-]+$/.test(word) && word.endsWith('.test.ts');

const TOOL_EXPANDS_REASON = '道具の名前を変数、$(...)、glob で渡すと、何を実行するか（wrangler で本番に触るか）を判定できない。人が確かめる';
const DEPLOY_REASON = [DENY, 'デプロイのスクリプトは Workers Builds だけが実行する'];
const UNKNOWN_DIR_REASON = [ASK, 'デプロイのスクリプトらしい語を、作業場所を判定できない（cd ~ や変数の先）まま渡している。人が確かめる'];
const BIG_GLOB_REASON = [ASK, '展開の大きい glob（{1..1000} など）は、デプロイのスクリプトに当たるかを判定しない。人が確かめる'];

// 語がデプロイのスクリプトを指すか。[DENY, 理由]、[ASK, 理由]、null を返す。
// 書かれた語は小文字にして全部の語に DEPLOY_PATH を掛ける。dir から解決した絶対パス（scripts//、scripts/./、cd scripts && …）の判定と、
// dir が null（cd ~、cd $X の後）のときに相対の語の名前が deploy で始まれば確認を挟む判定は、パスの形の語（/ を含むか .拡張子 で終わる）に限る。
// -e の中の deploy や deploying のような、ただの語を止めないため。
// 空白を含む語（bash -c "echo scripts/deploy.ts" の -c の値）はパスではない。-c の中身は judgeBash が別に見る
function judgeDeployWord(word, dir, root) {
  if (isTestFile(word)) return null;
  const written = word.toLowerCase();
  if (DEPLOY_PATH.test(written)) return DEPLOY_REASON;
  if (/\s/.test(word)) return null;

  const isPathShaped = /\/|\.\w+$/.test(word);
  const absolute = dir ? path.resolve(dir, word) : null;
  const resolved = absolute?.toLowerCase() ?? null;
  if (resolved && isPathShaped && DEPLOY_PATH.test(resolved)) return DEPLOY_REASON;
  // * や ** だけの語（-e の中の 2 ** 10）は見ない
  if (GLOB_CHARS.test(word) && /[\w.]/.test(word)) {
    if (expansionSize(word) > MAX_BRACE_EXPANSION) return BIG_GLOB_REASON;
    if (globHitsDeploy(written, resolved, absolute, root)) return DEPLOY_REASON;
  }
  const isRelative = !/^[/~]/.test(word);
  if (!dir && isPathShaped && isRelative && written.split('/').pop().startsWith('deploy')) return UNKNOWN_DIR_REASON;
  return null;
}

// 最初の DENY で打ち切る。残りの語に重い照合（glob の展開）があっても、結論が出ていれば評価しない
function judgeDeployWords(words, dir) {
  const root = dir ? repoRootOf(dir) : null;
  let ask = null;
  for (const word of words) {
    const verdict = judgeDeployWord(word, dir, root);
    if (verdict?.[0] === DENY) return verdict;
    ask ??= verdict;
  }
  return ask;
}

// 実行の道具、スクリプトを読む道具（シェル、source、.）、デプロイのスクリプトそのものに渡した語を判定する。止めるものが無ければ null
function judgeDeployScript(words, ci, dir) {
  const tool = baseName(words[ci]);
  const args = sliceWords(words, ci + 1);
  // node --test は並べたファイルを全部実行するので、先頭だけでなく位置引数を全部見る。
  // --test の無い node と bash では2つ目からはただの引数だが、取りこぼすより止めすぎるほうを取る。
  // 道具の語、スクリプトを読む道具の位置引数、< の読み込み元は区切らずに見る。実行の道具の引数だけは、-e の値と本文を含むので語に区切る
  const scriptWords = [words[ci]];
  if (SCRIPT_READERS.has(tool)) scriptWords.push(...positionals(args));
  if (SCRIPT_READERS.has(tool) || RUNNERS.has(tool)) scriptWords.push(...stdinTargets(words));
  if (RUNNERS.has(tool)) {
    // 区切る前の語も見る（'scripts/!(*.test).ts' は括弧で区切ると壊れる）
    const code = runnerWords(args);
    scriptWords.push(...code, ...code.flatMap((w) => w.split(CODE_SEPARATORS).filter(Boolean)));
  }
  return judgeDeployWords(scriptWords, dir);
}

// env -C <dir> と env --chdir=<dir> は、その後ろのコマンドの作業場所を変える。GNU の env は長いオプションを一意な省略形でも
// 受け付けるので、--c、--ch、--c=<dir> も --chdir と読む。
// ~ か $ で始まる値と、展開の印のある値は判定できない（null）とする。
// { dir, place } を返し、place（書かれた行き先）は cd と同じく作業場所が分からなくても値をつなぐ（env -C .claude rm -rf hooks）
function dirAfterEnv(words, ci, dir, from, place) {
  for (let i = from; i < ci; i++) {
    if (prefixName(words[i]) !== 'env') continue;
    for (let j = i + 1; j < ci; j++) {
      const w = words[j];
      let value;
      let valueAt = j;
      if (w === '-u' || w === '--unset') {
        j++;
        continue;
      }
      const long = /^--([a-z-]+)(=([\s\S]*))?$/.exec(w);
      const chdir = long && abbreviates(long[1], 'chdir');
      if (w === '-C' || (chdir && long[2] === undefined)) value = words[(valueAt = ++j)];
      else if (chdir) value = long[3];
      else if (/^-C./.test(w)) value = w.slice(2);
      else continue;
      const unknown = !value || /^[~$]/.test(value) || isUnresolved(words, valueAt);
      // 絶対パスの値は、前の作業場所が分からなくても行き先が決まる（nextDir と同じ）
      dir = unknown ? null : path.isAbsolute(value) ? path.resolve(value) : dir && path.resolve(dir, value);
      place = place == null || unknown ? null : path.posix.isAbsolute(value) ? value : path.posix.join(place, value);
    }
  }
  return { dir, place };
}

// env の -S、--split-string、--split-string=…、-S"…"、-iS のようにまとめた短いフラグ。env -S は文字列をシェルと違う規則で分けて
// 実行する（引用符の外の \_ が区切り、# から後ろを捨てる、\c、${VAR} だけを展開する。GNU の env は別の解き方をする）ので、
// 中身は読まずに確認を挟む。値を取る短いフラグ（-C、-u、-P）の後ろの S は値の一部なので除く。
// GNU の env は長いオプションを一意な省略形でも受け付ける。s から始まる長いオプションは split-string だけなので、
// --s、--sp=x、--split も拾う
const ENV_SPLIT_REASON = 'env -S は文字列をシェルと違う規則で分けて実行するので、何を実行するかを判定できない。人が確かめる';
function isEnvSplitFlag(word) {
  if (/^-[^-CuPS]*S/.test(word)) return true;
  const long = /^--([a-z-]+)(=|$)/.exec(word);
  return Boolean(long) && abbreviates(long[1], 'split-string');
}
function splitsString(words, prefixes, ci) {
  const end = ci === -1 ? words.length : ci;
  return prefixes.some((i) => prefixName(words[i]) === 'env' && words.slice(i + 1, end).some(isEnvSplitFlag));
}

const CF_WRANGLER_REASON = 'cf-wrangler は引数の読み方が wrangler と違い（util.parseArgs）、dev は本番の資源に向きうる。このリポジトリでは使わない';
const XARGS_WRANGLER_REASON = 'xargs は標準入力から wrangler に引数を足すので、--remote が加わるかを判定できない。wrangler は xargs の後ろに置かない';
const HEREDOC_UNTERMINATED_REASON = 'ヒアドキュメントの終わりの印の行が見つからず、後ろのコマンドを全部本文として読むので、何を実行するかを判定できない。人が確かめる';
const XARGS_REASON = 'xargs は標準入力から引数を足すので、何を実行するか（デプロイ、main への push、シークレットの読み取り）を判定できない。人が確かめる';
// xargs の後ろに置いても、足される引数で書き込みや実行に変わらない読むだけの道具。xargs を外したときと同じ判定で通す。
// rg の --pre、ag の --pager、file の -C は、標準入力から足した引数でコマンドを実行や書き込みをするので含めない
const XARGS_READERS = new Set(['grep', 'egrep', 'fgrep', 'wc', 'ls', 'cat', 'head', 'tail', 'stat']);

// xargs のフラグに引数の出どころを変える -a、-afile、-0a のようにまとめた形、--arg-file（--arg、--arg-file=file も）があるか。
// 標準入力ではなくファイルから足すので、読むだけの道具でも何を読むかが見えない。値を取る短いフラグ（-I、-P …）の後ろの a は値の一部
function xargsReadsFile(flags) {
  return flags.some((w) => {
    if (/^-[^-IPLdEnsJRSa]*a/.test(w)) return true;
    const long = /^--(a[a-z-]*)(=|$)/.exec(w);
    return Boolean(long) && 'arg-file'.startsWith(long[1]);
  });
}

function judgeSegment(words, ctx) {
  const ci = commandIndex(words);
  const results = [];
  const outer = ctx;
  if (setsWorkersCi(words, ci)) results.push([DENY, WORKERS_CI_REASON]);
  const tool = ci === -1 ? '' : baseName(words[ci]);
  const args = ci === -1 ? [] : sliceWords(words, ci + 1);
  // env -C は後ろのコマンドの作業場所を変える。経由先に掛け直すとき（envFrom）は、前置きの env の分を解決済みなので重ねない
  // 字面の行き先（place）も、env -C の値をつないで追う
  if (ci !== -1) {
    ctx = { ...ctx, ...dirAfterEnv(words, ci, ctx.dir, ctx.envFrom ?? 0, ctx.place) };
  }
  results.push(...judgeFileWrites(tool, args, words, ctx.dir));
  const removal = judgeRemoval(tool, args, ctx);
  if (removal) results.push(removal);
  const prefixes = prefixIndexes(words);
  // env -S の文字列は、道具の名前の位置に1語として見えるか、フラグに紛れて道具が見つからない。ci が -1 でも見る
  if (splitsString(words, prefixes, ci)) results.push([ASK, ENV_SPLIT_REASON]);
  const nextCtx = { ...ctx, cwd: ctx.dir, depth: ctx.depth + 1 };
  // script -qc "…"（util-linux）の文字列は、後ろに道具が無いので ci が -1 でも見る
  results.push(...prefixCommands(words).map((script) => judgeBash(script, nextCtx)).filter(Boolean));
  // npm_config_call='…' npx のように、道具の前の代入で npm exec にシェルの文字列を渡す。npx だけなら ci は -1 なので先に見る
  results.push(...configuredCalls(words, ci).map((script) => judgeBash(script, nextCtx)).filter(Boolean));
  // 前置きとして飛ばした npx と pnpx は、npm exec と pnpm dlx として読む（npx --call='…' だけなら ci は -1 なので先に見る）。
  // 場所は npx より前の env -C までで決める。npx の後ろの入れ子の npx は、経由先に掛け直したときに見る
  const npx = prefixes.find((j) => ['npx', 'pnpx'].includes(prefixName(words[j])));
  if (npx !== undefined) {
    const npxCtx = { ...outer, ...dirAfterEnv(words, npx, outer.dir, outer.envFrom ?? 0, outer.place) };
    results.push(...judgeNpx(prefixName(words[npx]), sliceWords(words, npx + 1), sliceWords(words, 0, npx), npxCtx));
  }
  if (ci === -1) return results;
  // 道具の名前が変数や $(...)、glob で決まると、何を実行するかが分からない（"$(which wrangler)" deploy）
  if (shapeAt(words, ci).includes(DYNAMIC) || expandsAt(words, ci)) results.push([ASK, TOOL_EXPANDS_REASON]);

  // 他の判定で止まっているなら、glob を展開する重い照合はしない
  if (!results.some(([d]) => d === DENY)) results.push(judgeDeployScript(words, ci, ctx.dir));

  // パッケージマネージャーは、走らせるスクリプトの中身と、pnpm exec env WORKERS_CI=1 node x のような経由先を前置きごと同じ規則で見る。
  // corepack <道具>[@版] は、その道具として読む。corepack の後ろの npx と pnpx は、corepack を外して直に打つ形と同じに見る
  const corepack = tool === 'corepack';
  const manager = managerOf(corepack ? (args[0] ?? '') : words[ci]);
  if (manager) {
    results.push(...judgePackageManager(manager, corepack ? sliceWords(args, 1) : args, sliceWords(words, 0, ci), ctx));
  } else if (corepack && ['npx', 'pnpx'].includes(baseName(args[0] ?? ''))) {
    if (ctx.depth + 1 > MAX_DEPTH) results.push([ASK, DEEP_REASON]);
    else results.push(...judgeSegment(concatWords(sliceWords(words, 0, ci), args), { ...ctx, envFrom: ci, depth: ctx.depth + 1 }));
  }

  // find の -exec 系は、{} を起点に置き換えたコマンドを同じ規則で見る（find .claude/hooks -exec rm {} \; は rm .claude/hooks）
  // 入れ子の find は起点の数の深さ乗に増えるので、コマンドぜんたいで掛け直す数を MAX_FIND_COMMANDS までにする
  if (tool === 'find' || tool === 'gfind') {
    // 起点が守る先を含みうるかは、起点を消すときの判定（守る先か、根か根の祖先か）で見る
    const judgeRemoved = removalJudge(ctx);
    const { count, weight, build, runsFound } = findCommands(args, (start) => judgeRemoved([start]) !== null);
    // 道具の位置に {} があると、見つけたファイルそのものを実行する（-exec {} deploy \; は wrangler でありうる）
    if (runsFound) results.push([ASK, TOOL_EXPANDS_REASON]);
    const budget = ctx.findBudget;
    if (count > budget.left || weight > budget.weight) {
      budget.left = 0;
      budget.weight = 0;
      results.push(FIND_COMMANDS_REASON);
    } else if (count > 0 && ctx.depth + 1 > MAX_DEPTH) {
      results.push([ASK, DEEP_REASON]);
    } else if (count > 0) {
      budget.left -= count;
      budget.weight -= weight;
      for (const { words: command, to } of build()) {
        const inner = to === null ? ctx : movedTo(ctx, to);
        results.push(...judgeSegment(command, { ...inner, envFrom: 0, depth: ctx.depth + 1 }));
      }
    }
  }

  // wrangler の語そのものに展開の印があれば（./*/wrangler）、引数を読まずに止める
  const wrangler = findWrangler(words, ci);
  if (wrangler !== -1 && isCfWrangler(words[wrangler])) results.push([DENY, CF_WRANGLER_REASON]);
  else if (wrangler !== -1) results.push(expandsAt(words, wrangler) ? UNQUOTED_REASON : judgeWrangler(sliceWords(words, wrangler + 1)));

  const playwright = findPlaywright(words, ci);
  if (playwright !== -1) results.push(judgePlaywright(sliceWords(words, playwright + 1)));

  // xargs は標準入力かファイル（-a）から引数を足すので、wrangler の引数（--remote）も、node や git が何を実行するかも見えない。
  // 読むだけの道具以外では、findWrangler が引数を実行しない道具（echo、git など）で打ち切っても、後ろの語の wrangler を見る
  const xargs = prefixes.find((j) => prefixName(words[j]) === 'xargs');
  if (xargs !== undefined) {
    // パスの付いた名前（./cat、/tmp/cat）は PATH の道具とは別のファイルかもしれないので、読むだけの道具に数えない
    const isReader = XARGS_READERS.has(tool) && !words[ci].includes('/');
    const wranglerAfter = wrangler !== -1 || (!isReader && words.some((w, i) => i > ci && (isWrangler(w) || isCfWrangler(w))));
    if (wranglerAfter) results.push([DENY, XARGS_WRANGLER_REASON]);
    else if (!isReader || xargsReadsFile(words.slice(xargs + 1, ci))) results.push([ASK, XARGS_REASON]);
  }

  if (INTERPRETERS.has(tool)) results.push(judgeInterpreterBody(tool, args));
  if (tool === 'git') {
    // 道具の前の代入と、前の区切りの export などで GIT_DIR か GIT_WORK_TREE を設定した後（ctx.env、judgeBash が積む）は、git が別の作業コピーを見る。
    // 道具の前の代入は、経由先に掛け直したとき（pnpm exec env GIT_DIR=x git）にも見えるよう語で見る
    const envMovesGit = words.slice(0, ci).some((w) => /^GIT_(DIR|WORK_TREE)=/.test(w)) || GIT_LOCATION_VARIABLES.some((name) => ctx.env?.[name]);
    results.push(judgeGit(args, envMovesGit ? null : ctx.dir, ctx.branchOf));
  }
  if (tool === 'gh') results.push(judgeGh(args, ctx.stdinContext));
  if (['curl', 'wget', 'http', 'https'].includes(tool)) results.push(judgeHttpClient(tool, args, ctx.stdinContext));
  if (tool === 'eval') results.push(judgeBash(args.join(' '), nextCtx));
  if (SHELLS.has(tool)) {
    // bash -c "..."、bash -lc "..."、bash <<< "..."、bash <<EOF の中身も同じ規則で見る
    const c = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    if (c !== -1 && args[c + 1]) results.push(judgeBash(args[c + 1], nextCtx));
    if (tool === 'fish') for (const body of fishCommands(args)) results.push(judgeBash(body, nextCtx));
    for (const body of heredocScripts(args)) results.push(judgeBash(body, nextCtx));
  }
  return results.filter(Boolean);
}

const SWITCH_FLAGS_WITH_VALUE = new Set(['-b', '-B', '-c', '-C', '--orphan']);

// git checkout <branch> と git switch <branch> の切り替え先。切り替えでなければ null、判定できなければ undefined
function switchedBranch(args) {
  const [sub] = positionals(args, GIT_FLAGS_WITH_VALUE);
  if (sub !== 'checkout' && sub !== 'switch') return null;
  const rest = args.slice(args.indexOf(sub) + 1);
  if (rest.includes('--')) return null; // git checkout -- <file> はファイルの復元
  if (rest.includes('-')) return undefined; // 直前のブランチ
  const created = rest.findIndex((a) => SWITCH_FLAGS_WITH_VALUE.has(a));
  const name = created !== -1 ? rest[created + 1] : positionals(rest)[0];
  if (name === undefined) return null;
  return name === '-' || name.includes('$') ? undefined : name;
}

// 作業場所の判定を変える環境変数。CDPATH は相対の cd と pushd の行き先を、GIT_DIR と GIT_WORK_TREE は git の作業コピーを変える
const GIT_LOCATION_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE'];
const LOCATION_VARIABLES = ['CDPATH', ...GIT_LOCATION_VARIABLES];
// npm exec、npm x、npx がシェルの文字列として動かす設定の変数（npm は大文字小文字を区別しない）。前の区切りで設定したものは値を読まない
const NPM_CALL_VARIABLE = 'npm_config_call';
const NPM_CALL_MENTION = /(^|[^\w])npm_config_call([^\w]|$)/i;
const NPM_CALL_SET_REASON =
  '前の区切りで npm_config_call を設定した（か名前に触れた）後の npm exec、npm x、npx、初期化子を渡した npm init と npm create は、設定したシェルの文字列を動かしうるが、値を判定しない。人が確かめる';
// 同じコマンドの中で設定した変数の値。値は読まないので、設定されたことだけを表す空でない文字列
const SET_IN_COMMAND = '(このコマンドの中で設定)';

// 語に変数の名前があるか。zsh の cdpath は CDPATH と結び付いた配列（cdpath=(x)）
const VARIABLE_MENTIONS = {
  CDPATH: /(^|[^\w])(CDPATH|cdpath)([^\w]|$)/,
  GIT_DIR: /(^|[^\w])GIT_DIR([^\w]|$)/,
  GIT_WORK_TREE: /(^|[^\w])GIT_WORK_TREE([^\w]|$)/,
};
// 中身をこのシェルで動かす道具。中で cd、export をしても見えないので、後ろの作業場所と GIT_DIR を判定できないものとする
const IN_SHELL_RUNNERS = new Set(['eval', 'source', '.']);

// 区切りが設定する LOCATION_VARIABLES の名前を { once, after } で返す。値は読まない（空の代入や unset で戻すのも追わず、止めすぎる側に倒す）。
// once は道具の前の一回限りの代入（GIT_DIR=x git status、CDPATH=x cd src）で、その区切りだけに効く。
// after はその区切りから後ろに効くもの。設定の書き方は read CDPATH、printf -v CDPATH、for CDPATH in、: ${CDPATH:=x}、cdpath=(x) と多いので、
// 道具の前の代入を除くどこかの語に名前があれば設定とみなす（単独の代入と export、declare などの引数もこれに当たる）。
// export、declare などの引数に展開の語（export $(echo GIT_DIR=x)、export $X）があるときと、eval、source、. の後は、全部の名前を設定とみなす。
// NPM_CALL_VARIABLE も同じ規則で after に入れる。道具の前の一回限りの代入（npm_config_call='…' npx）は configuredCalls が値を読むので once に入れない
function variablesSetBy(words, ci) {
  const once = new Set();
  const after = new Set();
  const isPrefix = (i) => ci !== -1 && i < ci && isAssignment(words[i]);
  const mentionedAfter = (pattern) => words.some((w, i) => !isPrefix(i) && pattern.test(w)) || redirectTargets(words).some((t) => pattern.test(t));
  for (const [name, pattern] of Object.entries(VARIABLE_MENTIONS)) {
    if (words.some((w, i) => isPrefix(i) && w.startsWith(`${name}=`))) once.add(name);
    if (mentionedAfter(pattern)) after.add(name);
  }
  if (mentionedAfter(NPM_CALL_MENTION)) after.add(NPM_CALL_VARIABLE);
  if (ci !== -1) {
    const tool = baseName(words[ci]);
    const declaresUnknown = ENV_DECLARERS.has(tool) && words.some((_, i) => i > ci && isUnresolved(words, i));
    if (declaresUnknown || IN_SHELL_RUNNERS.has(tool)) for (const name of [...LOCATION_VARIABLES, NPM_CALL_VARIABLE]) after.add(name);
  }
  return { once, after };
}

// cd、pushd、popd の後の作業場所。判定できなければ null。env は区切りに効く環境変数（CDPATH）
function nextDir(words, ci, dir, env) {
  const to = cdTarget(words, ci, env);
  // 絶対パスの行き先は、前の作業場所が判定できなくても（cd sr? && cd /abs）解決し直せる
  if (to === null || (!to.startsWith('/') && !dir)) return null;
  return path.resolve(dir ?? '/', to);
}

// cd、pushd の行き先の語。前の作業場所が分からないことは問わず、行き先の語だけで判定できなければ null
function cdTarget(words, ci, env) {
  // popd は、ディレクトリのスタックの中身を追わないので判定できない
  if (words[ci] === 'popd') return null;
  // -L と -P（シンボリックリンクの扱い）、オプションの終わりの -- は行き先ではないので飛ばす（リダイレクトは words に入らない）
  const operands = [];
  let physical = false;
  let options = true;
  for (let j = ci + 1; j < words.length; j++) {
    if (options && /^-[LP]+$/.test(words[j])) {
      physical ||= words[j].includes('P');
      continue;
    }
    if (options && words[j] === '--') {
      options = false;
      continue;
    }
    options = false;
    operands.push(j);
  }
  const at = operands[0];
  const to = words[at];
  // 行き先が2つ以上ある cd は、zsh では語の置き換え（cd 旧 新）、bash ではエラー。どこへ移るかを判定できない
  // cd -P は .. を物理パスで辿るので、シンボリックリンクを経由した行き先では path.resolve の字面と別の場所へ移る
  const walksUp = physical && /(^|\/)\.\.(\/|$)/.test(to ?? '');
  // CDPATH があると、相対の行き先（./x と ../x も。シェルごとの扱いの差は追わない）は CDPATH のディレクトリから探される。
  // 引数なしの pushd（入れ替え）と +N、-N（スタックの回転。zsh の cd も同じ）は、スタックの中身を追わないので判定できない
  const viaCdpath = !to?.startsWith('/') && Boolean(env.CDPATH);
  if (!to || operands.length > 1 || walksUp || viaCdpath || /^[~$-]|^\+\d*$/.test(to) || isUnresolved(words, at)) return null;
  return to;
}

// 一番重い判定を [決定, 理由] で返す。止めるものが無ければ null
// branchOf(dir) は dir のブランチ、scriptOf(dir, name) は dir から見た package.json のスクリプトの中身、
// packageDirOf(dir) はその package.json のあるディレクトリ（道具がスクリプトを動かす場所）を返す。
// env はセッションの環境変数のうち作業場所の判定を変えるもの（guard-bash.mjs が CDPATH を渡す）。空文字は無いものとする。
// root は消すか動かすのを止めるリポジトリの根で、入れ子では外の作業場所の根を引き継ぐ（cd .. && rm -rf <根の名前>）。
// place は作業場所を、外の作業場所からの書かれた行き先（cd .claude の .claude）で表したもの。作業場所が分からないときの守る先の判定に使う。
// findBudget は find の -exec 系で掛け直せる残りの数で、入れ子でも同じものを共有する
export function judgeBash(command, options) {
  // 根を探した結果は、ひとつのコマンドを判定する間だけ覚える（入れ子の呼び出しは depth が 1 以上）
  if (!options.depth) rootCache.clear();
  return judgeCommand(command, options);
}

function judgeCommand(
  command,
  {
    cwd,
    branchOf,
    scriptOf = () => undefined,
    packageDirOf = (d) => d,
    depth = 0,
    env = {},
    root = cwd ? repoRootOf(cwd) : null,
    place = '',
    findBudget = { left: MAX_FIND_COMMANDS, weight: MAX_FIND_WEIGHT },
  },
) {
  if (depth > MAX_DEPTH) return [ASK, DEEP_REASON];
  let dir = cwd;
  // 同じコマンドの中で checkout や switch をした後の push は、切り替えた先のブランチで判定する
  const switched = new Map();
  const currentBranch = (d) => (switched.has(d) ? switched.get(d) : branchOf(d));
  const results = [];
  const segments = splitSegments(command);
  // 直前の区切り。標準入力を前の区切りから受ける gh api --input - の本文を見るのに使う（ctx.stdinContext）
  let lastSegment;
  const shapeOfStdin = stdinShape(command);
  // xargs は標準入力から引数を足すので、シークレットの名前を標準入力に流す形（echo <名前> | xargs cat）は、xargs の後ろの道具からは見えない。
  // xargs がどこかの区切りにあれば、コマンド全体のどこかの語がシークレットの名前に当たるだけで止める。
  // 名前が見えない形（ls -a | xargs grep TOKEN）は止められない
  const hasXargs = segments.some((words) => prefixIndexes(words).some((i) => prefixName(words[i]) === 'xargs'));
  if (hasXargs && segments.some((words) => [...words, ...redirectTargets(words)].some(mentionsSecret))) results.push([DENY, SECRET_FILE_REASON]);
  for (const words of segments) {
    const previous = lastSegment;
    lastSegment = words;
    // 括弧の glob（cp /tmp/x(N) wrangler.jsonc）の閉じの後ろの語は、同じコマンドの引数なのに別の区切りに切られ、前の区切りからは見えない。
    // 道具を問わず、何をどこへ渡すかを判定できないものとする。後ろがリダイレクトだけ（ls *(N) 2>/dev/null）なら、宛先はこの区切りで見るので通す
    if (followsGlobGroup(words) && words.length > 0) {
      results.push([ASK, 'zsh の括弧の glob（x(N)、(a|b)）は後ろの語を別の区切りに切るので、コマンドの引数（コピーの宛先、git のサブコマンド）を判定できない。人が確かめる']);
    }
    const ci = commandIndex(words);
    if (redirectsOf(words).some((r) => r.unterminated)) results.push([ASK, HEREDOC_UNTERMINATED_REASON]);
    // 同じコマンドの中で CDPATH、GIT_DIR、GIT_WORK_TREE を設定したら、その区切りから後ろは設定されたものとして見る（入れ子の bash -c にも渡す）。
    // 道具の前の一回限りの代入は、この区切りだけ（segmentEnv）に効かせる。名前を含む語は、設定を終えた後の区切りに効かせる
    // （git commit -m "GIT_DIR を直す" のメッセージの語で、そのコミット自身を止めない）
    const { once, after } = variablesSetBy(words, ci);
    const mark = (names) => Object.fromEntries([...names].map((name) => [name, env[name] || SET_IN_COMMAND]));
    const segmentEnv = { ...env, ...mark(once) };
    env = { ...env, ...mark(after) };
    // cd の後の git push は、移った先のブランチで判定する。展開できない cd の先と popd の後は判定できないものとする
    if (ci !== -1 && ['cd', 'pushd', 'popd'].includes(words[ci])) {
      if (setsWorkersCi(words, ci)) results.push([DENY, WORKERS_CI_REASON]);
      // cd . > .dev.vars のようにリダイレクトを付けられる。道具として見ない（cd の引数は書き込み先ではない）
      results.push(...judgeFileWrites('', [], words, dir));
      dir = nextDir(words, ci, dir, segmentEnv);
      const to = cdTarget(words, ci, segmentEnv);
      place = to === null || place === null ? null : to.startsWith('/') ? to : path.posix.join(place, to);
      continue;
    }
    results.push(...judgeSegment(words, { dir, branchOf: currentBranch, scriptOf, packageDirOf, depth, env: segmentEnv, root, place, findBudget, stdinContext: { previous, ...shapeOfStdin } }));
    if (ci !== -1 && baseName(words[ci]) === 'git' && dir) {
      const branch = switchedBranch(words.slice(ci + 1));
      if (branch !== null) switched.set(dir, branch);
    }
    // eval、source、. は中身をこのシェルで動かすので、中の cd の後を判定できない（popd と同じ扱い）
    if (ci !== -1 && IN_SHELL_RUNNERS.has(baseName(words[ci]))) {
      dir = null;
      place = null;
    }
  }
  return results.find(([d]) => d === DENY) ?? results.find(([d]) => d === ASK) ?? null;
}
