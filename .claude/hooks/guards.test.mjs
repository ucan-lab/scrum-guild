// node --test .claude/hooks/*.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { judgeBash } from './bash-rules.mjs';
import { judgeFile } from './file-rules.mjs';
import { splitSegments } from './shell-words.mjs';

const scripts = { deploy: 'wrangler deploy', 'db:migrate:remote': 'wrangler d1 migrations apply DB --remote', test: 'vitest run', ci: 'pnpm test && pnpm db:migrate:remote' };
const ctx = (branch) => ({ cwd: '/repo', branchOf: () => branch, scriptOf: (dir, name) => (dir ? scripts[name] : undefined) });
const verdict = (command, branch = '21-claude-settings') => judgeBash(command, ctx(branch));
const decision = (command, branch) => verdict(command, branch)?.[0] ?? 'allow';

describe('shell-words', () => {
  test('引用符の中の区切りは区切りにしない', () => {
    assert.deepEqual(splitSegments('grep "a; b" x && ls'), [['grep', 'a; b', 'x'], ['ls']]);
  });
  test('コメントとヒアドキュメントの本文を捨てる', () => {
    assert.deepEqual(splitSegments("echo ok # it's\nls"), [['echo', 'ok'], ['ls']]);
    assert.deepEqual(splitSegments("cat <<'EOF' > b.md\nwrangler deploy\nEOF\nls"), [['cat', '>b.md', '<<wrangler deploy'], ['ls']]);
  });
  test('リダイレクトを1語にまとめ、2>&1 を残さない', () => {
    assert.deepEqual(splitSegments('git push origin x>log 2>&1'), [['git', 'push', 'origin', 'x', '>log']]);
  });
  test('二重引用符の中の置換を取り出す', () => {
    assert.deepEqual(splitSegments('echo "a $(wrangler deploy) b"'), [['echo', 'a  b'], ['wrangler', 'deploy']]);
  });
  test('引用符の無い置換は、元の語に印を残して中身を取り出す', () => {
    assert.deepEqual(splitSegments('wrangler $(echo deploy) x'), [['wrangler', '$(…)', 'x'], ['echo', 'deploy']]);
  });
});

describe('bash-rules: 止める', () => {
  for (const command of [
    'wrangler deploy',
    'npx wrangler deploy --dry-run',
    'npx -y wrangler@4 deploy',
    'npx -p wrangler wrangler deploy',
    'pnpm wrangler versions deploy',
    'pnpm exec wrangler rollback',
    'pnpm --filter api exec wrangler deploy',
    'pnpm -C apps/api wrangler deploy',
    'pnpm run wrangler deploy',
    'npm exec -- wrangler versions upload',
    'bun x wrangler deploy',
    'corepack pnpm wrangler deploy',
    './node_modules/.bin/wrangler deploy',
    'node node_modules/wrangler/bin/wrangler.js deploy',
    'CLOUDFLARE_ACCOUNT_ID=x wrangler deploy',
    'wrangler --config wrangler.jsonc deploy',
    'wrangler --name dev deploy',
    'sudo -u root wrangler deploy',
    'env -u FOO wrangler deploy',
    'timeout 300 npx wrangler deploy',
    'nice -n 10 wrangler deploy',
    'echo x | xargs wrangler deploy',
    'if true; then wrangler deploy; fi',
    'for e in a b; do npx wrangler deploy --env $e; done',
    '{ wrangler deploy; }',
    '! wrangler deploy',
    'wrangler d1 execute DB --remote --command "select 1"',
    'wrangler d1 migrations apply DB --remote',
    'wrangler d1 execute DB --command "select 1"',
    'wrangler dev --remote',
    'wrangler dev -r',
    'wrangler dev --x-remote-bindings',
    'wrangler d1 create scrum-guild',
    'wrangler r2 bucket delete attachments',
    'wrangler r2 object get attachments/a.png --remote',
    'wrangler kv key list --remote --binding KV',
    'wrangler secret put GITHUB_CLIENT_SECRET',
    'wrangler versions secret put X',
    'wrangler login',
    'wrangler delete',
    'wrangler tail',
    'pnpm deploy',
    'pnpm run deploy',
    'pnpm run cf:deploy',
    'yarn deploy',
    'npm run deploy:prod',
    'npm --prefix api run deploy',
    'pnpm db:migrate:remote',
    'pnpm run ci',
    'bash scripts/deploy.sh',
    './scripts/deploy.sh',
    'git push origin main',
    'git push origin HEAD:main',
    'git push origin feature:refs/heads/main',
    'git push origin main>log',
    'git push --force origin 21-claude-settings',
    'git push -f',
    'git push -uf origin x',
    'git push --force-with-lease=x:abc origin x',
    'git push origin +x',
    'git push --all',
    'git push --mirror',
    'git add -f .dev.vars',
    'gh pr merge 21 --squash',
    'gh -R ucan-lab/scrum-guild pr merge 21',
    'gh api -X PUT repos/ucan-lab/scrum-guild/pulls/21/merge',
    'gh api -X PUT repos/o/r/pulls/$PR/merge',
    'gh api --method PUT "repos/{owner}/{repo}/pulls/${n}/merge"',
    'gh api repos/o/r/merges -f base=main -f head=x',
    'gh api -X PATCH repos/o/r/git/refs/heads/main -F force=true',
    'gh api graphql -f query="mutation { mergePullRequest(input: {}) { clientMutationId } }"',
    'gh stack merge',
    'curl -X PUT -H "Authorization: token $(gh auth token)" https://api.github.com/repos/o/r/pulls/21/merge',
    'curl -XPUT https://api.github.com/repos/o/r/pulls/1/merge',
    'curl --request=PUT https://api.github.com/repos/o/r/pulls/1/merge',
    'gh api -XPUT repos/o/r/pulls/1/merge',
    'gh api -X=PUT repos/o/r/pulls/1/merge',
    'gh api -X $M repos/o/r/pulls/1/merge',
    'cat .dev.vars',
    'cat .dev.vars*',
    'cat .env',
    'cat .env.local',
    'grep SECRET < .dev.vars',
    'grep -n SECRET .dev.vars',
    'source .env',
    'cp .dev.vars /tmp/x',
    'node -e "console.log(require(\'fs\').readFileSync(\'.dev.vars\', \'utf8\'))"',
    'export $(cat .env | xargs)',
    'git status && npx wrangler deploy',
    'echo ok; wrangler deploy',
    "echo ok # it's a note\nwrangler deploy",
    "cat <<'EOF' > f\nit's\nEOF\nwrangler deploy",
    'bash -c "npx wrangler deploy"',
    'bash -lc "npx wrangler deploy"',
    "sh -ec 'git push origin main'",
    'bash <<< "wrangler deploy"',
    'eval "wrangler deploy"',
    'echo $(wrangler deploy)',
    'echo "$(wrangler deploy)"',
    'echo "`wrangler deploy`"',
    'out="$(npx wrangler deploy 2>&1)"; echo "$out"',
    'git commit -m "$(git push origin main)"',
    "$'wrangler' deploy",
    `git commit -m "$(cat <<'EOF'\nfix: it's (a) note\nEOF\n)" && git push origin main`,
    "bash <<'EOF'\nnpx wrangler deploy\nEOF",
    'sh <<EOF\ngit push origin main\nEOF',
    "node <<'EOF'\nrequire('fs').readFileSync('.dev.vars')\nEOF",
    'npx dotenv -e .env.prod -- wrangler deploy',
    'find . -maxdepth 0 -exec wrangler deploy \\;',
    'docker run --rm node:22 npx wrangler deploy',
    "$'\\x77rangler' deploy",
    "$'\\167rangler' deploy",
    'wrangler $(echo deploy)',
    'wrangler `echo deploy`',
    'wrangler $CMD',
    'echo ok && \\\nwrangler deploy',
    'git \\\npush origin main',
    'npx wrangler \\\n  deploy',
  ]) {
    test(command, () => assert.equal(decision(command), 'deny'));
  }

  test('main にいるときの引数なしの push', () => {
    assert.equal(decision('git push', 'main'), 'deny');
    assert.equal(decision('git push origin', 'main'), 'deny');
    assert.equal(decision('git push origin HEAD', 'main'), 'deny');
  });

  test('同じコマンドの中で切り替えた先のブランチで判定する', () => {
    assert.equal(decision('git checkout main && git push'), 'deny');
    assert.equal(decision('git switch main; git push origin HEAD'), 'deny');
    assert.equal(decision('git checkout -b main && git push'), 'deny');
    assert.equal(decision('git checkout main && git checkout -b x && git push -u origin x'), 'allow');
    assert.equal(decision('git checkout -- README.md && git push'), 'allow');
    assert.equal(decision('git switch - && git push'), 'ask');
  });

  test('cd した先のブランチで判定する', () => {
    const branchOf = (dir) => (dir === '/repo' ? 'main' : 'x');
    assert.equal(judgeBash('cd worktrees/x && git push', { cwd: '/repo', branchOf }), null);
    assert.equal(judgeBash('git push', { cwd: '/repo', branchOf })?.[0], 'deny');
    assert.equal(judgeBash('git -C worktrees/x push', { cwd: '/repo', branchOf }), null);
    assert.equal(judgeBash('cd /elsewhere && git -C /repo push', { cwd: '/x', branchOf })?.[0], 'deny');
  });

  test('止めた理由が規則に合っている', () => {
    assert.match(verdict('wrangler login')[1], /シークレットとログイン/);
    assert.match(verdict('wrangler deploy')[1], /本番に触る/);
    assert.match(verdict('wrangler d1 execute DB')[1], /--local/);
    assert.match(verdict('git push -f')[1], /force push/);
    assert.match(verdict('gh pr merge 1')[1], /マージ/);
  });
});

describe('bash-rules: 確認を挟む', () => {
  for (const command of [
    'pnpm add zod',
    'pnpm add -D vitest',
    'pnpm i zod',
    'pnpm remove zod',
    'pnpm up --latest',
    'npm install left-pad',
    'npm uninstall left-pad',
    'yarn add zod',
    'yarn up zod',
    'bun add zod',
    'wrangler d1 migrations create DB add_tasks',
    'pnpm wrangler d1 migrations create DB add_tasks',
    'gh stack push',
    'gh stack sync',
    'git push origin $BRANCH',
    'git push origin $(echo main)',
    'git push origin `git branch --show-current`',
    "git push origin 'refs/heads/*:refs/heads/*'",
  ]) {
    test(command, () => assert.equal(decision(command), 'ask'));
  }

  test('ブランチを判定できない push', () => {
    assert.equal(judgeBash('git push', { cwd: '/repo', branchOf: () => undefined })?.[0], 'ask');
    assert.equal(decision('cd ~/work/scrum-guild && git push'), 'ask');
    assert.equal(decision('cd $REPO && git push origin HEAD'), 'ask');
    assert.equal(decision('GIT_DIR=/repo/.git git push'), 'ask');
    assert.equal(decision('git --git-dir=/repo/.git push'), 'ask');
  });

  test('止めるものと確認を挟むものが並んだら止める', () => {
    assert.equal(decision('pnpm add zod && wrangler deploy'), 'deny');
  });
});

describe('bash-rules: 通す', () => {
  for (const command of [
    'wrangler dev',
    'pnpm wrangler dev --port 8788',
    'wrangler types',
    'wrangler --version',
    'wrangler whoami',
    'wrangler d1 execute DB --local --command "select 1"',
    'wrangler d1 execute DB --local --command "delete from tasks"',
    'wrangler d1 migrations apply DB --local',
    'wrangler d1 migrations list DB --local',
    'wrangler d1 execute DB --local --remote=false',
    'wrangler d1 migrations apply $DB --local',
    'wrangler dev --port $PORT',
    'git commit -m "$(cat msg.txt)"',
    'wrangler r2 object put attachments/a.png --file a.png --local',
    'pnpm install',
    'pnpm install --frozen-lockfile',
    'pnpm why wrangler',
    'npm view wrangler versions',
    'pnpm info wrangler version',
    'ls node_modules/.bin/wrangler',
    'which wrangler',
    'rm -rf node_modules/wrangler',
    'git log -- wrangler.jsonc',
    'npm install',
    'pnpm test',
    'pnpm run build',
    'git push origin 21-claude-settings',
    'git push -u origin 21-claude-settings',
    'git push --follow-tags origin x',
    'git push origin main:21-claude-settings',
    'git push',
    'git push origin feature # not main',
    'gh pr view 21',
    'gh pr create --title x --body-file b.md',
    'gh api repos/ucan-lab/scrum-guild/pulls/21',
    'gh api repos/ucan-lab/scrum-guild/pulls/21/merge',
    'curl -s https://api.github.com/repos/o/r/pulls/21/merge',
    'grep -rn "wrangler deploy" docs/',
    'grep -rn "\\.dev\\.vars" docs',
    'rg "git push origin main" .claude',
    'echo "npx wrangler deploy は Workers Builds が実行する"',
    "cat <<'EOF' > /tmp/b.md\nwrangler deploy は Workers Builds が実行する\n- git push origin main は人が行う\nEOF",
    "cat <<'EOF' > docs/x.md\n.dev.vars は人が用意する\nEOF",
    'cat .dev.vars.example',
    'cp .dev.vars.example .dev.vars',
    'echo .dev.vars >> .gitignore',
    'git check-ignore .dev.vars',
    'ls -la .dev.vars',
    'cat src/server/env.ts',
    'cat scripts/deploy.sh',
    'git diff origin/main -- scripts/deploy.sh',
    'shellcheck scripts/deploy.sh',
    'git log --oneline -- scripts/',
    'node --test .claude/hooks/*.test.mjs',
  ]) {
    test(command, () => assert.equal(decision(command), 'allow'));
  }
});

describe('file-rules', () => {
  const judge = (rel, contents = '', shippedOnMain = false) => judgeFile({ rel, contents, shippedOnMain })?.[0] ?? 'allow';

  test('main にあるマイグレーションの書き換えを止め、新しいものは通す', () => {
    assert.equal(judge('migrations/0001_init.sql', 'alter table x', true), 'deny');
    assert.equal(judge('migrations/0002_tasks.sql', 'create table tasks', false), 'allow');
  });

  test('SPA に反するファイルを止める', () => {
    assert.equal(judge('src/client/routes/+page.server.ts'), 'deny');
    assert.equal(judge('src/client/routes/[org]/+layout.server.js'), 'deny');
    assert.equal(judge('src/client/routes/api/+server.ts'), 'deny');
    assert.equal(judge('src/client/hooks.server.ts'), 'deny');
    assert.equal(judge('src/client/routes/+page.ts'), 'allow');
    assert.equal(judge('src/client/routes/+layout.svelte'), 'allow');
  });

  test('入口の外の D1 の binding を止める', () => {
    assert.equal(judge('src/server/operations/tasks.ts', 'const rows = await c.env.DB.prepare("select")'), 'deny');
    assert.equal(judge('src/server/index.ts', 'type Bindings = { DB: D1Database }'), 'deny');
    assert.equal(judge('src/server/db/organization.ts', 'new D1Dialect({ database: env.DB })'), 'allow');
    assert.equal(judge('test/setup.ts', 'await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)'), 'allow');
    assert.equal(judge('src/server/index.ts', 'const app = new Hono<{ Bindings: Env }>()'), 'allow');
  });

  test('.svelte の <style> を止める', () => {
    assert.equal(judge('src/client/routes/+page.svelte', '<div></div>\n<style>\n.a{}</style>'), 'deny');
    assert.equal(judge('src/client/lib/Button.svelte', '<style lang="postcss"></style>'), 'deny');
    assert.equal(judge('src/client/lib/Button.svelte', '<button class="btn">{label}</button>'), 'allow');
    assert.equal(judge('design/components.css', '.btn { color: red }'), 'allow');
  });

  test('リモートの binding を止める', () => {
    assert.equal(judge('wrangler.jsonc', '"d1_databases": [{ "binding": "DB", "remote": true }]'), 'deny');
    assert.equal(judge('wrangler.toml', 'remote = true'), 'deny');
    assert.equal(judge('wrangler.jsonc', '"workers_dev": true'), 'allow');
  });

  test('守る仕組みの書き換えに確認を挟む', () => {
    assert.equal(judge('.claude/settings.json', '{}'), 'ask');
    assert.equal(judge('.claude/settings.local.json', '{"disableAllHooks": true}'), 'ask');
    assert.equal(judge('.claude/hooks/bash-rules.mjs', ''), 'ask');
    assert.equal(judge('.claude/skills/x/SKILL.md', ''), 'allow');
  });
});

describe('入口', () => {
  const hooks = path.dirname(fileURLToPath(import.meta.url));
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));

  const run = (script, input) =>
    spawnSync(process.execPath, [script], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });
  const bashInput = (command) => JSON.stringify({ tool_name: 'Bash', cwd: tmp, tool_input: { command } });

  test('止めるときは deny の JSON を返す', () => {
    const result = run(path.join(hooks, 'guard-bash.mjs'), bashInput('npx wrangler deploy'));
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  });

  test('通すときは何も出さない', () => {
    const result = run(path.join(hooks, 'guard-bash.mjs'), bashInput('ls'));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });

  test('シンボリックリンク経由で起動しても判定する', () => {
    const link = path.join(tmp, 'hooks');
    symlinkSync(hooks, link);
    const result = run(path.join(link, 'guard-bash.mjs'), bashInput('npx wrangler deploy'));
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  });

  test('判定のモジュールを読み込めなければ exit 2 で止める', () => {
    const dir = path.join(tmp, 'broken');
    mkdirSync(dir);
    for (const name of ['guard-bash.mjs', 'guard-files.mjs']) {
      copyFileSync(path.join(hooks, name), path.join(dir, name));
      assert.equal(run(path.join(dir, name), bashInput('ls')).status, 2);
    }
  });

  test('入力が壊れていたら exit 2 で止める', () => {
    assert.equal(run(path.join(hooks, 'guard-bash.mjs'), '{bad').status, 2);
    assert.equal(run(path.join(hooks, 'guard-bash.mjs'), '').status, 2);
    assert.equal(run(path.join(hooks, 'guard-files.mjs'), '{bad').status, 2);
  });

  test('ファイルの判定はリポジトリのルートからの相対パスで行う', () => {
    const repo = realpathSync(path.resolve(hooks, '../..'));
    const input = JSON.stringify({
      tool_name: 'Write',
      cwd: repo,
      tool_input: { file_path: path.join(repo, 'src/client/routes/+page.server.ts'), content: 'x' },
    });
    const result = run(path.join(hooks, 'guard-files.mjs'), input);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  });
});
