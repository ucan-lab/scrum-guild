// Bash の判定。本番に触る操作、WORKERS_CI の設定、main の上のコミットと main への push、--force-with-lease 以外の force push、シークレット、gh pr merge を通さないマージを止め、
// gh pr merge、依存の変更、マイグレーションの作成、判定しきれない push と場所を判定できないデプロイのスクリプトでは人の確認を挟む（docs/development.md の「Claude の設定とフック」）。
// permissions.deny の前方一致では npx wrangler や pnpm exec wrangler の言い換えを取りこぼすので、語に分けて判定する。
// 踏み線であって守りの本体ではない。変数の中身と、パイプで sh に流す中身は見えない。
import { existsSync } from 'node:fs';
import path from 'node:path';
import { baseName, commandIndex, concatWords, expandsAt, positionals, sliceWords, splitSegments } from './shell-words.mjs';

const DENY = 'deny';
const ASK = 'ask';
const MAX_DEPTH = 5;

// 引数を実行しない道具。これ以外の道具の後ろに wrangler の語があれば、wrangler の実行とみなす
// （npx dotenv -- wrangler、find -exec wrangler、docker run ... wrangler のような前置きを列挙しきれないため）
const NON_EXECUTING = new Set([
  'echo', 'printf', 'cat', 'less', 'more', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'awk', 'sort',
  'wc', 'diff', 'ls', 'tree', 'stat', 'file', 'which', 'type', 'man', 'git', 'gh', 'jq', 'yq', 'code', 'open',
  'mkdir', 'touch', 'rm', 'cp', 'mv', 'ln', 'chmod', 'tee', 'test', '[',
]);
// 依存の情報を見るだけのサブコマンド（npm view wrangler versions など）
const PACKAGE_INFO = new Set([
  'view', 'info', 'show', 'why', 'list', 'ls', 'outdated', 'search', 'home', 'repo', 'docs', 'bugs', 'audit',
  'add', 'install', 'i', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'upgrade',
]);

function isWrangler(word) {
  const name = baseName(word);
  return name === 'wrangler' || /^wrangler\.[cm]?js$/.test(name) || /(^|\/)wrangler\/(bin|wrangler-dist)\//.test(word);
}

function findWrangler(words, ci) {
  if (isWrangler(words[ci])) return ci;
  const tool = baseName(words[ci]);
  if (NON_EXECUTING.has(tool)) return -1;
  if (tool in PACKAGE_CHANGES && PACKAGE_INFO.has(positionals(words.slice(ci + 1), PACKAGE_FLAGS_WITH_VALUE)[0])) return -1;
  for (let i = ci + 1; i < words.length; i++) {
    if (words[i - 1] === '-p' || words[i - 1] === '--package') continue;
    if (isWrangler(words[i])) return i;
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
// 後の値を採る規則は真似ず、打ち消しが1つでもあれば順番に関わらず止める
function negatesLocal(words) {
  return words.some(
    (a, i) =>
      a.startsWith('--no-local') ||
      (a.startsWith('--local=') && a !== '--local=true') ||
      (a === '--local' && words[i + 1] === 'false'),
  );
}

// yargs が読む語。-- の後ろはフラグにならず、リダイレクトはシェルが argv から外す（--local >/dev/null false は --local false）。
// 値を取るフラグの値も除く。ただし - で始まる語は yargs が値にせずフラグとして読むので残す
function flagWords(args) {
  const end = args.indexOf('--');
  const head = end === -1 ? args : args.slice(0, end);
  const words = [];
  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    if (/^[<>]/.test(a) || (a.includes('=') && WRANGLER_FLAGS_WITH_VALUE.has(a.split('=')[0]))) continue;
    if (WRANGLER_FLAGS_WITH_VALUE.has(a) && head[i + 1] !== undefined && !head[i + 1].startsWith('-')) {
      words.push(a);
      i++;
      continue;
    }
    words.push(a);
  }
  return words;
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
  'wrangler の引数を変数や $(...) で始めるか、フラグの名前に展開を入れると、展開した結果をフラグとして読みうる。値は --flag="$X" の形で渡す',
];

// 引用符の中の展開を含む語が、展開した後にフラグになりうるか。先頭が展開の語と、- で始まり展開を含む語（--re$X）が当たる。
// 値を取るフラグの = の形で、= の右だけに展開があるもの（--file=$(…)）は除く
function mayBecomeFlag(word) {
  if (!word.includes('$')) return false;
  if (word.startsWith('$')) return true;
  if (!word.startsWith('-')) return false;
  const eq = word.indexOf('=');
  return eq === -1 || word.slice(0, eq).includes('$') || !WRANGLER_FLAGS_WITH_VALUE.has(word.slice(0, eq));
}

// yargs はフラグの名前を改行の手前で切り（'--local<改行>' は --local）、. の後ろをドット記法で読む（--local.x=1 で local が配列になり、
// r2 と kv は本番に向く）。名前の完全一致で見る判定が外れるので、名前に空白、改行、. を含むフラグは止める。
// -1.5 のような負の数は、yargs が値として読むので除く
const UNREADABLE_FLAG = /^-(?!\d)[^=]*[\s.]/;

// wrangler dev の -r は --remote の別名で、yargs は -lr のようにまとめた短いフラグも1文字ずつ読む。
// d1、r2、kv には -r が無いので、サブコマンドを問わず = より前に r を含む短いフラグを止める。負の数（-1.5）は除く
const SHORT_REMOTE = /^-(?![-\d])[^=]*r/;

function judgeWrangler(args) {
  const isRemote = args.some(
    (a) =>
      SHORT_REMOTE.test(a) ||
      a === '--remote' ||
      (a.startsWith('--remote=') && a !== '--remote=false') ||
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
  // 展開は、値を取るフラグの値も含めた -- より前の全部の語で見る。-- の後ろは yargs がフラグとして読まず、リダイレクトは argv に入らない
  const end = args.indexOf('--');
  const argv = (end === -1 ? args : args.slice(0, end)).map((a, i) => [a, i]).filter(([a]) => !/^[<>]/.test(a));
  if (argv.some(([, i]) => expandsAt(args, i))) return UNQUOTED_REASON;
  if (argv.some(([a]) => mayBecomeFlag(a))) return LEADING_REASON;

  const [sub, sub1, sub2] = pos;
  const hasLocal = words.includes('--local') || words.includes('--local=true');
  const needLocal = (what) => {
    if (negatesLocal(words)) {
      return [DENY, `${what} の --no-local、--local=<true 以外>、--local false は local を打ち消して本番に向く。--local だけを付ける`];
    }
    return hasLocal ? null : [DENY, `${what} は --local を付けて手元の D1、R2、KV に向けて実行する`];
  };

  if (sub === undefined) return null; // wrangler --version、wrangler --help
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

// git -C "$(git rev-parse --show-toplevel)"、-C ~/x、-C /rep? の行き先は、実行するまで分からない
function gitDirAt(dir, target) {
  return /^~|[$*?[\]{}]/.test(target) ? null : dir && path.resolve(dir, target);
}

// dir が null のときは、作業場所を判定できない（cd ~、cd $X、GIT_DIR=）
function judgeGit(args, dir, branchOf) {
  let i = 0;
  let gitDir = dir;
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '-C') gitDir = gitDirAt(gitDir, args[i + 1] ?? '.');
    if (/^-C./.test(args[i])) gitDir = gitDirAt(gitDir, args[i].slice(2));
    if (/^--(git-dir|work-tree)/.test(args[i])) gitDir = null;
    i += GIT_FLAGS_WITH_VALUE.has(args[i]) ? 2 : 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  const verdict = judgeGitCommand(sub, rest, gitDir, branchOf);
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
    if (branchOf(gitDir) === 'main') return [DENY, `main の上で git ${sub} はしない。ワークツリーで作業ブランチを切り、PR を通す`];
  }
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
  const pos = positionals(rest, PUSH_FLAGS_WITH_VALUE);
  const refspecs = hasRepo ? pos : pos.slice(1);
  if (refspecs.some((r) => r.startsWith('+'))) return [DENY, '+ で始まる refspec は force push になる'];

  const current = gitDir ? branchOf(gitDir) : undefined;
  const targets = refspecs.length === 0 ? ['HEAD'] : refspecs.map((r) => r.split(':').pop());
  const unknown = (t) => /[$*]/.test(t) || ((t === 'HEAD' || t === '@') && !current);
  // 判定できない先があっても、並べて書いた main は先に止める
  for (const target of targets.filter((t) => !unknown(t))) {
    const name = (target === 'HEAD' || target === '@' ? current : target).replace(/^(refs\/)?heads\//, '');
    if (name === 'main') {
      return [DENY, 'main へは push しない。作業ブランチから PR を通す（文書だけの変更も同じ）'];
    }
  }
  if (targets.some((t) => /[$*]/.test(t))) return [ASK, '変数か glob を含む refspec は、main を含むかを判定できない'];
  // 作業ブランチへの --force-with-lease は、sync-base の rebase の後に使うので通す
  if (targets.some(unknown)) return [ASK, 'push する先のブランチを判定できない（cd ~ や変数の先、git の管理外）'];
  return null;
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

function judgePackageManager(tool, args, ctx) {
  const pos = positionals(args, PACKAGE_FLAGS_WITH_VALUE);
  // install <pkg> は依存を足す。引数なしの install はロックファイルどおりに入れるだけ
  const installsPackage = ['install', 'i', 'add'].includes(pos[0]) && pos.length > 1;
  if ((PACKAGE_CHANGES[tool] ?? []).includes(pos[0]) || installsPackage) {
    return [ASK, '依存の変更は needs-human の領域。足す理由と代わりの手を確かめてから進める'];
  }

  const name = scriptName(tool, pos);
  if (!name) return null;
  if (DEPLOY_SCRIPT.test(name)) return [DENY, 'デプロイは Workers Builds だけが行う'];
  // package.json のスクリプトの中身も同じ規則で見る。pre と post のスクリプトも一緒に走る
  const results = [`pre${name}`, name, `post${name}`]
    .map((n) => ctx.scriptOf(ctx.dir, n))
    .filter(Boolean)
    .map((body) => judgeBash(body, { ...ctx, cwd: ctx.dir, depth: ctx.depth + 1 }))
    .filter(Boolean);
  return results.find(([d]) => d === DENY) ?? results[0] ?? null;
}

// npm は run 無しでは test、start、stop、restart だけがスクリプトを動かす。pnpm、yarn、bun は名前だけで動かす
const NPM_SCRIPT_ALIASES = { test: 'test', t: 'test', tst: 'test', start: 'start', stop: 'stop', restart: 'restart' };

function scriptName(tool, pos) {
  if (['run', 'run-script'].includes(pos[0])) return pos[1];
  return tool === 'npm' ? NPM_SCRIPT_ALIASES[pos[0]] : pos[0];
}

// .dev.vars と .env（.example は除く）。コードの文字列の中（readFileSync('.dev.vars')）も拾う。
// .envrc や process.env は拾わない。.dev.v* のように名前の途中で切ったグロブは取りこぼす
export function mentionsSecret(word) {
  return /(^|[^\w.])\.(dev\.vars|env)(?!\.example)(?![\w-])/.test(word);
}

const READERS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'bat', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'awk', 'sed', 'sort', 'uniq',
  'wc', 'cut', 'tr', 'diff', 'cmp', 'xxd', 'od', 'hexdump', 'strings', 'base64', 'source', '.', 'vi', 'vim', 'nvim',
  'nano', 'code', 'open', 'jq', 'yq', 'python', 'python3', 'node', 'ruby', 'perl', 'deno', 'bun', 'tee', 'export',
  // 中身を外へ送る（curl -d @.env、curl -F file=@.dev.vars）
  'curl', 'wget', 'http', 'https', 'nc',
]);
const COPIERS = new Set(['cp', 'mv', 'scp', 'rsync', 'ln']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag']);
const SEARCH_FLAGS_WITH_VALUE = new Set(['-e', '-f', '--regexp', '--file', '-g', '--glob', '-t', '--type', '-A', '-B', '-C', '-m']);

const INTERPRETERS = new Set(['node', 'python', 'python3', 'ruby', 'perl', 'deno', 'bun']);
const isHeredoc = (word) => word.startsWith('<<');
const heredocBody = (word) => word.replace(/^<<<?/, '');

// words は区切りの全部の語（< .env cmd のように、道具の前に置いた入力も見る）
function judgeSecretAccess(tool, args, words) {
  if (words.some((a) => a.startsWith('<') && !isHeredoc(a) && mentionsSecret(a))) return true;
  // 書き込み先（>）と、文書として流すヒアドキュメントの本文は読み取りではない
  const plain = args.filter((a) => !/^[<>]/.test(a));
  if (INTERPRETERS.has(tool)) return [...plain, ...args.filter(isHeredoc).map(heredocBody)].some(mentionsSecret);
  if (SEARCHERS.has(tool)) {
    // 最初の位置の引数は探す文字列なので、grep ".dev.vars" docs のような検索は通す
    const pos = positionals(args, SEARCH_FLAGS_WITH_VALUE);
    const files = args.some((a) => ['-e', '-f', '--regexp', '--file'].includes(a)) ? pos : pos.slice(1);
    return files.some(mentionsSecret);
  }
  if (READERS.has(tool) || SHELLS.has(tool)) return plain.some(mentionsSecret);
  if (COPIERS.has(tool)) {
    // コピーの元に書いたときだけ止める。cp .dev.vars.example .dev.vars は通す
    const pos = positionals(args);
    return pos.slice(0, -1).some(mentionsSecret);
  }
  return false;
}

// Write と Edit のフック（file-rules.mjs）が守るファイル。Bash から書き換えるときは人の確認を挟む
function isProtectedPath(word) {
  return /(^|\/)\.claude\/(settings[^/]*\.json$|hooks(\/|$))|(^|\/)\.githooks(\/|$)|(^|\/)migrations\//.test(word.replace(/^>+/, ''));
}

function writesProtectedPath(tool, args) {
  if (args.some((a) => a.startsWith('>') && isProtectedPath(a))) return true;
  const pos = positionals(args);
  if (['sed', 'perl'].includes(tool) && args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a))) {
    return pos.some(isProtectedPath);
  }
  if (['tee', 'rm', 'truncate', 'unlink'].includes(tool)) return pos.some(isProtectedPath);
  if (['cp', 'mv', 'ln', 'rsync', 'install'].includes(tool)) return isProtectedPath(pos.at(-1) ?? '');
  return false;
}

// WORKERS_CI=1 は deploy() が本番に触る唯一の条件で、付けるのは Workers Builds だけ。値は問わず、名前がちょうど WORKERS_CI のものだけを見る
// （WORKERS_CI_COMMIT_SHA は Workers Builds が渡す別の変数）
const WORKERS_CI_REASON = 'WORKERS_CI は Workers Builds だけが付ける。人が試すときは ! で打つ';
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
  return !NON_EXECUTING.has(tool) && args.some((w) => WORKERS_CI_ASSIGN.test(w));
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
// 作業場所は -C、--dir、--cwd、--prefix の値で解決し直し、~ か $ で始まる値は判定できない（null）とする
function viaPackageManager(tool, args, dir) {
  let manager = tool;
  let rest = args;
  if (tool === 'corepack') {
    manager = baseName(rest[0] ?? '');
    rest = rest.slice(1);
  }
  if (!PACKAGE_RUNNERS.has(manager)) return null;
  let viaExec = false;
  let viaRun = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('-')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      if (DIR_FLAGS.has(name)) {
        const value = eq === -1 ? rest[++i] : a.slice(eq + 1);
        dir = !dir || !value || /^[~$]/.test(value) ? null : path.resolve(dir, value);
      } else if (viaExec && SHELL_MODE_FLAGS.has(name)) {
        const script = eq === -1 ? rest[i + 1] : a.slice(eq + 1);
        return script ? { script, dir } : null;
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
    return { start: args.length - rest.length + i, dir };
  }
  return null;
}

// 実行の道具が読むファイルの候補。位置引数、--flag=値 の右側（--import=、--require= など）、
// ヒアドキュメントとヒアストリングの本文を返す。リダイレクトは stdinTargets が別に見る
function runnerWords(args) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--' || a.startsWith('>')) continue;
    if (a.startsWith('<')) {
      if (isHeredoc(a)) result.push(heredocBody(a));
      continue;
    }
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
  return result;
}

// node < scripts/deploy-production.ts と bash < scripts/deploy.sh の読み込み元。道具の前に置いた < も拾う
const stdinTargets = (words) => words.filter((w) => w.startsWith('<') && !isHeredoc(w)).map((w) => w.slice(1));

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
  const args = words.slice(ci + 1);
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

// env -C <dir> と env --chdir=<dir> は、その後ろのコマンドの作業場所を変える。~ か $ で始まる値は判定できない（null）とする
function dirAfterEnv(words, ci, dir, from) {
  for (let i = from; i < ci; i++) {
    if (baseName(words[i]) !== 'env') continue;
    for (let j = i + 1; j < ci; j++) {
      const w = words[j];
      let value;
      if (w === '-u' || w === '--unset') {
        j++;
        continue;
      }
      if (w === '-C' || w === '--chdir') value = words[++j];
      else if (w.startsWith('--chdir=')) value = w.slice('--chdir='.length);
      else if (/^-C./.test(w)) value = w.slice(2);
      else continue;
      dir = !dir || !value || /^[~$]/.test(value) ? null : path.resolve(dir, value);
    }
  }
  return dir;
}

function judgeSegment(words, ctx) {
  const ci = commandIndex(words);
  const results = [];
  if (setsWorkersCi(words, ci)) results.push([DENY, WORKERS_CI_REASON]);
  if (ci === -1) return results;
  const tool = baseName(words[ci]);
  const args = sliceWords(words, ci + 1);
  // 道具の名前が変数や $(...)、glob で決まると、何を実行するかが分からない（"$(which wrangler)" deploy）
  if (words[ci].includes('$') || expandsAt(words, ci)) results.push([ASK, TOOL_EXPANDS_REASON]);
  // env -C は後ろのコマンドの作業場所を変える。経由先に掛け直すとき（envFrom）は、前置きの env の分を解決済みなので重ねない
  ctx = { ...ctx, dir: dirAfterEnv(words, ci, ctx.dir, ctx.envFrom ?? 0) };

  if (judgeSecretAccess(tool, args, words)) {
    results.push([DENY, '.dev.vars と .env は開発用のシークレット。中身は人が扱い、例は .dev.vars.example に置く']);
  }
  if (writesProtectedPath(tool, args)) {
    results.push([ASK, '守る仕組み（Claude の設定とフック）とマイグレーションの書き換えは人が確かめる']);
  }
  // 他の判定で止まっているなら、glob を展開する重い照合はしない
  if (!results.some(([d]) => d === DENY)) results.push(judgeDeployScript(words, ci, ctx.dir));

  // pnpm exec env WORKERS_CI=1 node x のように道具を経由するときは、経由先を前置きごと同じ規則で見る。
  // pnpm exec -c "…" のシェルの文字列は judgeBash に渡す
  const via = viaPackageManager(tool, args, ctx.dir);
  if (via?.script !== undefined) {
    results.push(judgeBash(via.script, { ...ctx, cwd: via.dir, depth: ctx.depth + 1 }));
  } else if (via) {
    if (ctx.depth + 1 > MAX_DEPTH) results.push([ASK, 'コマンドの入れ子が深く、判定しきれない']);
    else {
      const inner = { ...ctx, dir: via.dir, envFrom: ci, depth: ctx.depth + 1 };
      results.push(...judgeSegment(concatWords(sliceWords(words, 0, ci), sliceWords(args, via.start)), inner));
    }
  }

  // wrangler の語そのものに展開の印があれば、引数を読まずに止める。zsh の wrangler (d1|deploy) は、後ろの引数が区切りの外に出ている
  const wrangler = findWrangler(words, ci);
  if (wrangler !== -1) results.push(expandsAt(words, wrangler) ? UNQUOTED_REASON : judgeWrangler(sliceWords(words, wrangler + 1)));

  const nextCtx = { ...ctx, cwd: ctx.dir, depth: ctx.depth + 1 };
  if (tool === 'git') {
    const envMovesGit = words.slice(0, ci).some((w) => /^GIT_(DIR|WORK_TREE)=/.test(w));
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
    for (const a of args.filter(isHeredoc)) results.push(judgeBash(heredocBody(a), nextCtx));
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

// 一番重い判定を [決定, 理由] で返す。止めるものが無ければ null
// branchOf(dir) は dir のブランチ、scriptOf(dir, name) は dir から見た package.json のスクリプトの中身を返す
export function judgeBash(command, { cwd, branchOf, scriptOf = () => undefined, depth = 0 }) {
  if (depth > MAX_DEPTH) return [ASK, 'コマンドの入れ子が深く、判定しきれない'];
  let dir = cwd;
  // 同じコマンドの中で checkout や switch をした後の push は、切り替えた先のブランチで判定する
  const switched = new Map();
  const currentBranch = (d) => (switched.has(d) ? switched.get(d) : branchOf(d));
  const results = [];
  for (const words of splitSegments(command)) {
    // cd の後の git push は、移った先のブランチで判定する。展開できない cd の先は判定できないものとする
    const ci = commandIndex(words);
    if (ci !== -1 && ['cd', 'pushd'].includes(words[ci])) {
      if (setsWorkersCi(words, ci)) results.push([DENY, WORKERS_CI_REASON]);
      const to = words[ci + 1];
      dir = !to || /^[~$-]/.test(to) || !dir ? null : path.resolve(dir, to);
      continue;
    }
    results.push(...judgeSegment(words, { dir, branchOf: currentBranch, scriptOf, depth }));
    if (ci !== -1 && baseName(words[ci]) === 'git' && dir) {
      const branch = switchedBranch(words.slice(ci + 1));
      if (branch !== null) switched.set(dir, branch);
    }
  }
  return results.find(([d]) => d === DENY) ?? results.find(([d]) => d === ASK) ?? null;
}
