// Bash の判定。本番に触る操作、WORKERS_CI の設定、main の上のコミットと main への push、--force-with-lease 以外の force push、
// シークレット（.dev.vars と .env）の読み取りと書き込み、gh pr merge を通さないマージを止め、
// gh pr merge、依存の変更、マイグレーションの作成、判定しきれない push と場所を判定できないデプロイのスクリプト、git のフックを外す --no-verify、
// 道具の名前が展開で決まるコマンド、env -S、読むだけの道具以外の xargs、wrangler の設定の書き換えと wrangler dev の -c、
// インタープリタの本文の中の wrangler と守る先の名前、展開を含む package.json のスクリプトの引数、
// 守る先とリポジトリの根とその祖先の削除と移動（rm、rmdir、mv、find -delete）、git clean の -x と -X では人の確認を挟む。
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
  if (tool in PACKAGE_CHANGES && PACKAGE_INFO.has(positionals(words.slice(ci + 1), PACKAGE_FLAGS_WITH_VALUE)[0])) return -1;
  for (let i = ci + 1; i < words.length; i++) {
    if (words[i - 1] === '-p' || words[i - 1] === '--package') continue;
    if (isTool(words[i])) return i;
  }
  return -1;
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

const GIT_FLAGS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
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

  const forced = rest.some((a) => a === '--force' || isOption(a, '--mirror', 4) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a));
  if (forced) return [DENY, '--force と -f は使わない。rebase の後は --force-with-lease で push する'];
  if (rest.some((a) => isOption(a, '--all', 4))) return [DENY, '--all は main も push する'];
  // --force-with-lease が守るのは、最後に fetch した後の他人の push だけ。fetch 済みの他人のコミットを
  // 手元が含んでいるかは sync-base が確かめる。--force-if-includes は lease に添えるときだけ意味を持つ
  const leased = rest.some((a) => isOption(a, '--force-with-lease', 9));
  if (rest.some((a) => isOption(a, '--force-if-includes', 9)) && !leased) {
    return [DENY, '--force-if-includes は --force-with-lease と一緒に使う'];
  }

  // --repo を付けると、先頭の位置引数もリモートではなく refspec になる
  const hasRepo = rest.some((a) => a === '--repo' || a.startsWith('--repo='));
  const pos = positionalIndexes(rest, PUSH_FLAGS_WITH_VALUE);
  const refspecs = hasRepo ? pos : pos.slice(1);
  if (refspecs.some((at) => rest[at].startsWith('+'))) return [DENY, '+ で始まる refspec は force push になる'];

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
  // 作業ブランチへの --force-with-lease は、sync-base の rebase の後に使うので通す
  if (targets.some(unknown)) return [ASK, 'push する先のブランチを判定できない（cd ~ や変数の先、git の管理外）'];
  return null;
}

// 本体の作業コピーの git clean -x は、ワークツリーのリンクの先の .dev.vars（本体の本物）も消す。作業場所を問わず人が確かめる
const CLEAN_IGNORED_REASON =
  'git clean の -x と -X は ignore したファイル（.dev.vars とそのリンク、.wrangler の手元の D1 と R2）も消す。消える先を git clean -n -x で見てから人が確かめる';

// git clean の引数に -x か -X（-fdx のようにまとめた形も）があり、-n と --dry-run（一意な省略形の --d も）が無いか。
// -e と --exclude は値を取るので、-exyz の xyz と -e x の x は数えない。-- と --end-of-options の後ろはパスなので見ない。
// git の parse-options は後に書いたものを採るので、--no-dry-run（--no-dry などの省略形も）の後は試し実行ではない（git clean -n --no-dry-run -f は消す）
function cleansIgnored(args) {
  let ignored = false;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--' || a === '--end-of-options') break;
    if (a.startsWith('--')) {
      if (isOption(a, '--dry-run', 3)) dryRun = true;
      if (isOption(a, '--no-dry-run', 6)) dryRun = false;
      if (isOption(a, '--exclude', 3) && !a.includes('=')) i++;
      continue;
    }
    if (!/^-./.test(a)) continue;
    for (let k = 1; k < a.length; k++) {
      if (a[k] === 'n') dryRun = true;
      if (a[k] === 'x' || a[k] === 'X') ignored = true;
      if (a[k] === 'e') {
        if (k + 1 === a.length) i++;
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

// GitHub の API でのマージと main の書き換え。GET（読むだけ）は通す
function judgeGitHubWrite(words, method) {
  const text = words.join(' ');
  if (/enablePullRequestAutoMerge/.test(text)) return [DENY, 'auto-merge は使わない'];
  if (/mergePullRequest/.test(text)) return [DENY, MERGE_REASON];
  if (/updateRefs?\b/.test(text)) return [DENY, 'main は PR のマージでだけ進める'];
  if (method === 'GET') return null;
  if (/\/pulls\/[^/\s]+\/merge\b|\/merges\b/.test(text)) return [DENY, MERGE_REASON];
  if (/\/git\/refs\/heads\/main\b/.test(text)) return [DENY, 'main は PR のマージでだけ進める'];
  // contents API の書き込みは、ブランチを指定しなければ既定のブランチ（main）へ直にコミットする
  if (/\/contents\//.test(text)) return [DENY, 'contents API でのファイルの書き込みはしない。作業ブランチで git を使う'];
  return null;
}

// -X PUT、-XPUT、-X=PUT、--method PUT、--method=PUT のどれでも値を読む
function valueAfter(words, flags) {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (flags.includes(w)) return words[i + 1];
    for (const f of flags) {
      if (w.startsWith(`${f}=`)) return w.slice(f.length + 1);
      if (!f.startsWith('--') && w.startsWith(f) && w.length > f.length) return w.slice(f.length);
    }
  }
  return undefined;
}

// 変数で渡したメソッドは読めないので、書き込みとみなす
function methodOf(value, fallback) {
  if (value === undefined) return fallback;
  return value.includes('$') ? 'UNKNOWN' : value.toUpperCase();
}

function judgeGh(args) {
  const pos = positionals(args, new Set(['-R', '--repo', '-X', '--method', '-H', '--header', '-f', '-F', '--field', '--raw-field', '--input', '--jq', '-q', '--template', '-t']));
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
  if (pos[0] === 'api') {
    const hasFields = args.some((a) => ['-f', '-F', '--field', '--raw-field', '--input'].includes(a));
    return judgeGitHubWrite(args, methodOf(valueAfter(args, ['-X', '--method']), hasFields ? 'POST' : 'GET'));
  }
  return null;
}

function judgeHttpClient(tool, args) {
  if (!args.some((a) => a.includes('api.github.com'))) return null;
  let method = 'GET';
  if (tool === 'curl') {
    const sendsBody = args.some((a) => /^(-d|--data.*|-F|--form|-T|--upload-file|--json)$/.test(a));
    method = methodOf(valueAfter(args, ['-X', '--request']), sendsBody ? 'POST' : 'GET');
  } else if (tool === 'wget') {
    method = methodOf(valueAfter(args, ['--method']), args.some((a) => a.startsWith('--post-')) ? 'POST' : 'GET');
  } else {
    // httpie: http PUT https://...
    method = args.find((a) => /^[A-Z]+$/.test(a)) ?? 'GET';
  }
  return judgeGitHubWrite(args, method);
}

const PACKAGE_CHANGES = {
  pnpm: ['add', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'upgrade'],
  yarn: ['add', 'remove', 'up', 'upgrade'],
  npm: ['uninstall', 'remove', 'rm', 'un', 'update', 'up', 'upgrade'],
  bun: ['add', 'remove', 'rm', 'update', 'upgrade'],
};
const PACKAGE_FLAGS_WITH_VALUE = new Set(['-C', '--dir', '--filter', '-F', '--prefix', '--cwd', '--workspace']);
const DEPLOY_SCRIPT = /(^|[:_-])deploy([:_-]|$)/;

const SCRIPT_ARGS_EXPAND_REASON = 'スクリプトの後ろの引数に変数、$(...)、glob があると、本体の末尾に足して実行される中身を判定できない';

function judgePackageManager(tool, args, ctx) {
  const indexes = positionalIndexes(args, PACKAGE_FLAGS_WITH_VALUE);
  const pos = indexes.map((i) => args[i]);
  // install <pkg> は依存を足す。引数なしの install はロックファイルどおりに入れるだけ
  const installsPackage = ['install', 'i', 'add'].includes(pos[0]) && pos.length > 1;
  if ((PACKAGE_CHANGES[tool] ?? []).includes(pos[0]) || installsPackage) {
    return [ASK, '依存の変更は needs-human の領域。足す理由と代わりの手を確かめてから進める'];
  }

  const name = scriptName(tool, pos);
  if (!name) return null;
  if (DEPLOY_SCRIPT.test(name)) return [DENY, 'デプロイは Workers Builds だけが行う'];
  // package.json のスクリプトの中身も同じ規則で見る。pre と post のスクリプトも一緒に走る。
  // 名前より後ろの語は、道具が引用符で包んで本体の末尾に足す（pnpm test x は node --test scripts/*.test.ts 'x'）。
  // npm が -- の前のフラグを取る違いはまねず、全部の語を足す。-- は pnpm が残し、npm、yarn、bun が消すので、
  // 残した形と最初の -- を消した形の両方を見る（git や wrangler の判定は -- の後ろをフラグとして読まないため）
  const extra = sliceWords(args, indexes[['run', 'run-script'].includes(pos[0]) ? 1 : 0] + 1);
  const separator = extra.indexOf('--');
  const appended = separator === -1 ? [extra] : [extra, concatWords(sliceWords(extra, 0, separator), sliceWords(extra, separator + 1))];
  // 道具は package.json のあるディレクトリでスクリプトを動かすので、本体と足した語もそこで判定する（cd src && pnpm test '*/x.ts'）
  const scriptCtx = { ...ctx, cwd: ctx.dir && ctx.packageDirOf(ctx.dir), depth: ctx.depth + 1 };
  const body = ctx.scriptOf(ctx.dir, name);
  const results = [
    ...[`pre${name}`, `post${name}`].map((n) => ctx.scriptOf(ctx.dir, n)).filter(Boolean).map((b) => judgeBash(b, scriptCtx)),
    ...(body ? appended.map((words) => judgeBash(appendWords(body, words), scriptCtx)) : []),
  ].filter(Boolean);
  // 足した語は引用符で包むので、展開（$X、$(…)、glob）の印が消え、直に打つより緩く読みうる
  if (body && extra.some((_, i) => isUnresolved(extra, i))) results.push([ASK, SCRIPT_ARGS_EXPAND_REASON]);
  return results.find(([d]) => d === DENY) ?? results.find(([d]) => d === ASK) ?? null;
}

// 語をシェルの1語として単引用符で包み、本体の末尾に足す
function appendWords(body, words) {
  return [body, ...words.map((w) => `'${w.replaceAll("'", "'\\''")}'`)].join(' ');
}

// npm は run 無しでは test、start、stop、restart だけがスクリプトを動かす。pnpm、yarn、bun は名前だけで動かす
const NPM_SCRIPT_ALIASES = { test: 'test', t: 'test', tst: 'test', start: 'start', stop: 'stop', restart: 'restart' };

function scriptName(tool, pos) {
  if (['run', 'run-script'].includes(pos[0])) return pos[1];
  return tool === 'npm' ? NPM_SCRIPT_ALIASES[pos[0]] : pos[0];
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
  'gcp', 'gmv', 'gln', 'ginstall', 'grm', 'gsed', 'gdd', 'gtee', 'gtruncate', 'gshred', 'gtouch',
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
  if (removed.length === 0) return null;
  const isProtected = protectedAt(ctx.dir);
  // 作業場所が分からないまま cd した先（cd .claude && find hooks -delete）は、書かれた行き先をつないで見る
  const written = (word) => (ctx.dir || ctx.place == null || path.posix.isAbsolute(word) ? word : path.posix.join(ctx.place, word));
  if (removed.some((w) => isProtected(w) || isProtected(written(w)))) return [ASK, REMOVES_PROTECTED_REASON];
  const roots = [...new Set([ctx.root, ctx.dir && repoRootOf(ctx.dir)].filter(Boolean))];
  // {a,b} はシェルが展開してから渡すので、展開した語のどれかで見る（rm -rf {.,build}）。展開が大きすぎる語は当たるものとする（protectedAt と同じ）
  const hitsRoot = (w) => expansionSize(w) > MAX_BRACE_EXPANSION || expandBraces(w).some((e) => removesRoot(e, ctx.dir, roots));
  if (removed.some(hitsRoot)) return [ASK, REMOVES_ROOT_REASON];
  return null;
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
// それ以外は字面で、末尾の / を外して . と .. だけからなる語（.、./..、../..）、/、~ に当てる
function removesRoot(word, dir, roots) {
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
  const count = execs.length * starts.length;
  if (count > MAX_FIND_COMMANDS) return { count, weight: Infinity, build: () => [] };
  const size = (word) => Math.min(expansionSize(word), MAX_BRACE_EXPANSION + 1);
  // -execdir 系は起点の展開ごとに守る先を含みうるかを見るので重い。重さの下限（展開ごとに作業場所 2 つ × 語の数）を先に見積もり、
  // 上限を超えるなら組み合わせを作らずに打ち切る
  const leastWeight = execs.reduce((sum, { at, inDir }) => sum + (inDir ? starts.reduce((s, start) => s + size(start), 0) * 2 * at.length : 0), 0);
  if (leastWeight > MAX_FIND_WEIGHT) return { count, weight: Infinity, build: () => [] };
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
  return { count, weight, build };
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
const PACKAGE_RUNNERS = new Set(['pnpm', 'yarn', 'npm']);
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

// パッケージマネージャーの作業場所を変えるフラグ（pnpm -C、--dir、yarn --cwd、npm --prefix）。--flag=値 の形も読む
const DIR_FLAGS = new Set(['-C', '--dir', '--cwd', '--prefix']);
const EXEC_FLAGS_WITH_VALUE = new Set([...PACKAGE_FLAGS_WITH_VALUE, '-p', '--package']);
// exec の後ろのコマンドを、道具ではなくシェルの文字列として渡すフラグ（pnpm exec -c "…"、npm exec --call="…"）
const SHELL_MODE_FLAGS = new Set(['-c', '--shell-mode', '--call']);

// pnpm exec env X=1 node x、npm exec -- tsx x、yarn node x、yarn run node x、corepack pnpm dlx tsx x のように道具を経由するとき、
// 経由先を返す。{ start, dir } の start は経由先のコマンドが args の何番目から始まるかで、judgeSegment に掛け直すので env、代入、timeout などの前置きも同じ規則で効く。
// 語ではなく位置を返すのは、呼び出し元が語と展開の印を一緒に切り出すため。
// { script, dir } は exec -c のシェルの文字列で、judgeBash に掛け直す。経由しなければ null。
// exec と dlx の後ろは何でも経由先とし、exec の無い形（yarn node x、yarn run node x）は実行の道具のときだけ経由先とする。
// 作業場所は -C、--dir、--cwd、--prefix の値で解決し直し、~ か $ で始まる値と、展開の印のある値（sr?、{a,b}、"src$X"）は判定できない（null）とする。
// 書かれた行き先（place）も、env -C と同じく作業場所が分からなくても値をつなぎ、返す値に入れる（pnpm -C .claude exec rm -rf hooks）
function viaPackageManager(tool, args, dir, place = null) {
  let manager = tool;
  let rest = args;
  if (tool === 'corepack') {
    manager = baseName(rest[0] ?? '');
    rest = sliceWords(rest, 1);
  }
  if (!PACKAGE_RUNNERS.has(manager)) return null;
  let viaExec = false;
  let viaRun = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('-')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      // pnpm -Csr? のように -C に値を連結した形も -C として読む
      const attached = !DIR_FLAGS.has(name) && /^-C./.test(a);
      if (DIR_FLAGS.has(name) || attached) {
        // = の形と連結の形の値は、語ぜんたいの展開の印で見る
        const valueAt = eq === -1 && !attached ? ++i : i;
        const value = attached ? a.slice(2) : eq === -1 ? rest[valueAt] : a.slice(eq + 1);
        const unknown = !value || /^[~$]/.test(value) || isUnresolved(rest, valueAt);
        dir = !dir || unknown ? null : path.resolve(dir, value);
        place = place == null || unknown ? null : path.posix.isAbsolute(value) ? value : path.posix.join(place, value);
      } else if (viaExec && SHELL_MODE_FLAGS.has(name)) {
        const script = eq === -1 ? rest[i + 1] : a.slice(eq + 1);
        return script ? { script, dir, place } : null;
      } else if (eq === -1 && (EXEC_FLAGS_WITH_VALUE.has(a) || (manager === 'npm' && a === '-w'))) {
        // npm の -w は値（ワークスペースの名前）を取る。pnpm の -w は値を取らない（--workspace-root）
        i++;
      }
      continue;
    }
    // npm x は npm exec の別名
    if (!viaExec && (a === 'exec' || a === 'dlx' || (manager === 'npm' && a === 'x'))) {
      viaExec = true;
      continue;
    }
    if (!viaExec && !viaRun && (a === 'run' || a === 'run-script')) {
      viaRun = true;
      continue;
    }
    if (!viaExec && !RUNNERS.has(baseName(a))) return null;
    return { start: args.length - rest.length + i, dir, place };
  }
  return null;
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
function repoRootOf(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (existsSync(path.join(d, DEPLOY_ENTRIES[1]))) return d;
    if (d === path.dirname(d)) return null;
  }
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
  if (ci === -1) return results;
  // 道具の名前が変数や $(...)、glob で決まると、何を実行するかが分からない（"$(which wrangler)" deploy）
  if (shapeAt(words, ci).includes(DYNAMIC) || expandsAt(words, ci)) results.push([ASK, TOOL_EXPANDS_REASON]);

  // 他の判定で止まっているなら、glob を展開する重い照合はしない
  if (!results.some(([d]) => d === DENY)) results.push(judgeDeployScript(words, ci, ctx.dir));

  // pnpm exec env WORKERS_CI=1 node x のように道具を経由するときは、経由先を前置きごと同じ規則で見る。
  // pnpm exec -c "…" のシェルの文字列は judgeBash に渡す
  const via = viaPackageManager(tool, args, ctx.dir, ctx.place);
  if (via?.script !== undefined) {
    results.push(judgeBash(via.script, { ...ctx, cwd: via.dir, place: via.place, depth: ctx.depth + 1 }));
  } else if (via) {
    if (ctx.depth + 1 > MAX_DEPTH) results.push([ASK, 'コマンドの入れ子が深く、判定しきれない']);
    else {
      const inner = { ...ctx, dir: via.dir, place: via.place, envFrom: ci, depth: ctx.depth + 1 };
      results.push(...judgeSegment(concatWords(sliceWords(words, 0, ci), sliceWords(args, via.start)), inner));
    }
  }

  // find の -exec 系は、{} を起点に置き換えたコマンドを同じ規則で見る（find .claude/hooks -exec rm {} \; は rm .claude/hooks）
  // 入れ子の find は起点の数の深さ乗に増えるので、コマンドぜんたいで掛け直す数を MAX_FIND_COMMANDS までにする
  if (tool === 'find' || tool === 'gfind') {
    // 起点が守る先を含みうるかは、起点を消すときの判定（守る先か、根か根の祖先か）で見る
    const { count, weight, build } = findCommands(args, (start) => judgeRemoval('rm', [start], ctx) !== null);
    const budget = ctx.findBudget;
    if (count > budget.left || weight > budget.weight) {
      budget.left = 0;
      budget.weight = 0;
      results.push(FIND_COMMANDS_REASON);
    } else if (count > 0 && ctx.depth + 1 > MAX_DEPTH) {
      results.push([ASK, 'コマンドの入れ子が深く、判定しきれない']);
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
  if (tool === 'gh') results.push(judgeGh(args));
  if (['curl', 'wget', 'http', 'https'].includes(tool)) results.push(judgeHttpClient(tool, args));
  if (tool in PACKAGE_CHANGES) results.push(judgePackageManager(tool, args, ctx));
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
// export、declare などの引数に展開の語（export $(echo GIT_DIR=x)、export $X）があるときと、eval、source、. の後は、全部の名前を設定とみなす
function variablesSetBy(words, ci) {
  const once = new Set();
  const after = new Set();
  const isPrefix = (i) => ci !== -1 && i < ci && isAssignment(words[i]);
  for (const [name, pattern] of Object.entries(VARIABLE_MENTIONS)) {
    if (words.some((w, i) => isPrefix(i) && w.startsWith(`${name}=`))) once.add(name);
    if (words.some((w, i) => !isPrefix(i) && pattern.test(w)) || redirectTargets(words).some((t) => pattern.test(t))) after.add(name);
  }
  if (ci !== -1) {
    const tool = baseName(words[ci]);
    const declaresUnknown = ENV_DECLARERS.has(tool) && words.some((_, i) => i > ci && isUnresolved(words, i));
    if (declaresUnknown || IN_SHELL_RUNNERS.has(tool)) for (const name of LOCATION_VARIABLES) after.add(name);
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
export function judgeBash(
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
  if (depth > MAX_DEPTH) return [ASK, 'コマンドの入れ子が深く、判定しきれない'];
  let dir = cwd;
  // 同じコマンドの中で checkout や switch をした後の push は、切り替えた先のブランチで判定する
  const switched = new Map();
  const currentBranch = (d) => (switched.has(d) ? switched.get(d) : branchOf(d));
  const results = [];
  const segments = splitSegments(command);
  // xargs は標準入力から引数を足すので、シークレットの名前を標準入力に流す形（echo <名前> | xargs cat）は、xargs の後ろの道具からは見えない。
  // xargs がどこかの区切りにあれば、コマンド全体のどこかの語がシークレットの名前に当たるだけで止める。
  // 名前が見えない形（ls -a | xargs grep TOKEN）は止められない
  const hasXargs = segments.some((words) => prefixIndexes(words).some((i) => prefixName(words[i]) === 'xargs'));
  if (hasXargs && segments.some((words) => [...words, ...redirectTargets(words)].some(mentionsSecret))) results.push([DENY, SECRET_FILE_REASON]);
  for (const words of segments) {
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
    results.push(...judgeSegment(words, { dir, branchOf: currentBranch, scriptOf, packageDirOf, depth, env: segmentEnv, root, place, findBudget }));
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
