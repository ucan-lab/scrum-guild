// Bash の判定。本番に触る操作、main の上のコミットと main への push、--force-with-lease 以外の force push、シークレット、gh pr merge を通さないマージを止め、
// gh pr merge、依存の変更、マイグレーションの作成、判定しきれない push では人の確認を挟む（docs/development.md の「Claude の設定とフック」）。
// permissions.deny の前方一致では npx wrangler や pnpm exec wrangler の言い換えを取りこぼすので、語に分けて判定する。
// 踏み線であって守りの本体ではない。変数の中身と、パイプで sh に流す中身は見えない。
import path from 'node:path';
import { baseName, commandIndex, positionals, splitSegments } from './shell-words.mjs';

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
]);
const WRANGLER_PRODUCTION = new Set(['deploy', 'publish', 'rollback', 'versions', 'deployments', 'delete', 'triggers', 'tail']);
const SECRET_REASON = 'シークレットとログインは人が扱う（セッションに Cloudflare の資格情報を置かない）';
const PRODUCTION_REASON = 'デプロイ、版、本番のログ、D1 と R2 の作成と削除は Workers Builds と人が行う';

function judgeWrangler(args) {
  const isRemote = args.some(
    (a) =>
      a === '-r' ||
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

  const [sub, sub1, sub2] = pos;
  const hasLocal = args.includes('--local');
  const needLocal = (what) =>
    hasLocal ? null : [DENY, `${what} は --local を付けて手元の D1、R2、KV に向けて実行する`];

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

// dir が null のときは、作業場所を判定できない（cd ~、cd $X、GIT_DIR=）
function judgeGit(args, dir, branchOf) {
  let i = 0;
  let gitDir = dir;
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '-C') gitDir = gitDir && path.resolve(gitDir, args[i + 1] ?? '.');
    if (/^-C./.test(args[i])) gitDir = gitDir && path.resolve(gitDir, args[i].slice(2));
    if (/^--(git-dir|work-tree)/.test(args[i])) gitDir = null;
    i += GIT_FLAGS_WITH_VALUE.has(args[i]) ? 2 : 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
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
  return /(^|\/)\.claude\/(settings[^/]*\.json$|hooks(\/|$))|(^|\/)migrations\//.test(word.replace(/^>+/, ''));
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

function judgeSegment(words, ctx) {
  const ci = commandIndex(words);
  if (ci === -1) return [];
  const tool = baseName(words[ci]);
  const args = words.slice(ci + 1);
  const results = [];

  if (judgeSecretAccess(tool, args, words)) {
    results.push([DENY, '.dev.vars と .env は開発用のシークレット。中身は人が扱い、例は .dev.vars.example に置く']);
  }
  if (writesProtectedPath(tool, args)) {
    results.push([ASK, '守る仕組み（Claude の設定とフック）とマイグレーションの書き換えは人が確かめる']);
  }
  const runsDeployScript =
    /(^|\/)scripts\/deploy[^/]*$/.test(words[ci]) ||
    ((SHELLS.has(tool) || tool === 'node') && /(^|\/)scripts\/deploy[^/]*$/.test(positionals(args)[0] ?? ''));
  if (runsDeployScript) results.push([DENY, 'デプロイのスクリプトは Workers Builds だけが実行する']);

  const wrangler = findWrangler(words, ci);
  if (wrangler !== -1) results.push(judgeWrangler(words.slice(wrangler + 1)));

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
