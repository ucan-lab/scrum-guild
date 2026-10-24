// Bash の判定。本番に触る操作、main への push、force push、マージ、シークレットを止め、
// 依存の変更、マイグレーションの作成、判定しきれない push では人の確認を挟む（docs/development.md の「Claude の設定とフック」）。
// permissions.deny の前方一致では npx wrangler や pnpm exec wrangler の言い換えを取りこぼすので、語に分けて判定する。
// 踏み線であって守りの本体ではない。変数の中身と、パイプで sh に流す中身は見えない。
import path from 'node:path';
import { baseName, commandIndex, positionals, splitSegments } from './shell-words.mjs';

const DENY = 'deny';
const ASK = 'ask';
const MAX_DEPTH = 5;

// wrangler を中で動かせる道具。この後ろの語に wrangler があれば wrangler の実行とみなす
const LAUNCHERS = new Set(['pnpm', 'npm', 'yarn', 'bun', 'corepack', 'node', 'exec', 'dlx', 'x']);

function isWrangler(word) {
  const name = baseName(word);
  return name === 'wrangler' || /^wrangler\.[cm]?js$/.test(name) || /(^|\/)wrangler\/(bin|wrangler-dist)\//.test(word);
}

function findWrangler(words, ci) {
  if (isWrangler(words[ci])) return ci;
  if (!LAUNCHERS.has(baseName(words[ci]))) return -1;
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

// dir が null のときは、作業場所を判定できない（cd ~、cd $X、GIT_DIR=）
function judgeGit(args, dir, branchOf) {
  let i = 0;
  let gitDir = dir;
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '-C') gitDir = gitDir && path.resolve(gitDir, args[i + 1] ?? '.');
    if (/^--(git-dir|work-tree)/.test(args[i])) gitDir = null;
    i += GIT_FLAGS_WITH_VALUE.has(args[i]) ? 2 : 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === 'add' && rest.some(mentionsSecret)) return [DENY, '.dev.vars と .env は git に入れない'];
  if (sub !== 'push') return null;

  const forced = rest.some(
    (a) =>
      a === '--force' ||
      a.startsWith('--force-with-lease') ||
      a === '--force-if-includes' ||
      a === '--mirror' ||
      /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a),
  );
  if (forced) return [DENY, 'force push は人が実行する（`!` を付けて打つ）'];
  if (rest.includes('--all')) return [DENY, '--all は main も push する'];

  const [, ...refspecs] = positionals(rest, PUSH_FLAGS_WITH_VALUE);
  if (refspecs.some((r) => r.startsWith('+'))) return [DENY, '+ で始まる refspec は force push になる'];
  if (refspecs.some((r) => /[$*]/.test(r))) return [ASK, '変数か glob を含む refspec は、main を含むかを判定できない'];

  const current = gitDir ? branchOf(gitDir) : undefined;
  const targets = refspecs.length === 0 ? ['HEAD'] : refspecs.map((r) => r.split(':').pop());
  for (const target of targets) {
    const isCurrent = target === 'HEAD' || target === '@';
    if (isCurrent && !current) return [ASK, 'push する先のブランチを判定できない（cd ~ や変数の先、git の管理外）'];
    const name = (isCurrent ? current : target).replace(/^refs\/heads\//, '');
    if (name === 'main') {
      return [DENY, 'main へは push しない。作業ブランチから PR を通す（文書だけの変更も、push は人が行う）'];
    }
  }
  return null;
}

// GitHub の API でのマージと main の書き換え。GET（読むだけ）は通す
function judgeGitHubWrite(words, method) {
  const text = words.join(' ');
  if (/mergePullRequest|enablePullRequestAutoMerge|updateRef|updateRefs/.test(text)) return [DENY, 'マージは人が行う'];
  if (method === 'GET') return null;
  if (/\/pulls\/[^/\s]+\/merge\b|\/merges\b/.test(text)) return [DENY, 'マージは人が行う'];
  if (/\/git\/refs\/heads\/main\b/.test(text)) return [DENY, 'main は PR のマージでだけ進める'];
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
  if ((pos[0] === 'pr' && pos[1] === 'merge') || (pos[0] === 'stack' && pos[1] === 'merge')) {
    return [DENY, 'マージは人が行う'];
  }
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

  const name = ['run', 'run-script'].includes(pos[0]) ? pos[1] : tool === 'npm' ? undefined : pos[0];
  if (!name) return null;
  if (DEPLOY_SCRIPT.test(name)) return [DENY, 'デプロイは Workers Builds だけが行う'];
  // package.json のスクリプトの中身も同じ規則で見る
  const body = ctx.scriptOf(ctx.dir, name);
  return body ? judgeBash(body, { ...ctx, cwd: ctx.dir, depth: ctx.depth + 1 }) : null;
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
]);
const COPIERS = new Set(['cp', 'mv', 'scp', 'rsync', 'ln']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag']);
const SEARCH_FLAGS_WITH_VALUE = new Set(['-e', '-f', '--regexp', '--file', '-g', '--glob', '-t', '--type', '-A', '-B', '-C', '-m']);

function judgeSecretAccess(tool, args) {
  if (args.some((a) => a.startsWith('<') && mentionsSecret(a))) return true;
  if (SEARCHERS.has(tool)) {
    // 最初の位置の引数は探す文字列なので、grep ".dev.vars" docs のような検索は通す
    const pos = positionals(args, SEARCH_FLAGS_WITH_VALUE);
    const files = args.some((a) => ['-e', '-f', '--regexp', '--file'].includes(a)) ? pos : pos.slice(1);
    return files.some(mentionsSecret);
  }
  if (READERS.has(tool) || SHELLS.has(tool)) return args.some(mentionsSecret);
  if (COPIERS.has(tool)) {
    // コピーの元に書いたときだけ止める。cp .dev.vars.example .dev.vars は通す
    const pos = positionals(args);
    return pos.slice(0, -1).some(mentionsSecret);
  }
  return false;
}

function judgeSegment(words, ctx) {
  const ci = commandIndex(words);
  if (ci === -1) return [];
  const tool = baseName(words[ci]);
  const args = words.slice(ci + 1);
  const results = [];

  if (judgeSecretAccess(tool, args)) {
    results.push([DENY, '.dev.vars と .env は開発用のシークレット。中身は人が扱い、例は .dev.vars.example に置く']);
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
    // bash -c "..."、bash -lc "..."、bash <<< "..." の中身も同じ規則で見る
    const c = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    if (c !== -1 && args[c + 1]) results.push(judgeBash(args[c + 1], nextCtx));
    for (const a of args.filter((w) => w.startsWith('<<<'))) results.push(judgeBash(a.slice(3), nextCtx));
  }
  return results.filter(Boolean);
}

// 一番重い判定を [決定, 理由] で返す。止めるものが無ければ null
// branchOf(dir) は dir のブランチ、scriptOf(dir, name) は dir から見た package.json のスクリプトの中身を返す
export function judgeBash(command, { cwd, branchOf, scriptOf = () => undefined, depth = 0 }) {
  if (depth > MAX_DEPTH) return [ASK, 'コマンドの入れ子が深く、判定しきれない'];
  let dir = cwd;
  const results = [];
  for (const words of splitSegments(command)) {
    // cd の後の git push は、移った先のブランチで判定する。展開できない cd の先は判定できないものとする
    const ci = commandIndex(words);
    if (ci !== -1 && ['cd', 'pushd'].includes(words[ci])) {
      const to = words[ci + 1];
      dir = !to || /^[~$-]/.test(to) || !dir ? null : path.resolve(dir, to);
      continue;
    }
    results.push(...judgeSegment(words, { dir, branchOf, scriptOf, depth }));
  }
  return results.find(([d]) => d === DENY) ?? results.find(([d]) => d === ASK) ?? null;
}
