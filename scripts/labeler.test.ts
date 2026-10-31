import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { load } from 'js-yaml';
import { Minimatch } from 'minimatch';

// .github/labeler.yml の needs-human の規則を、actions/labeler と同じ読み方で評価する（docs/development.md の「マージの判定」）。
// labeler は dot: true の minimatch でパスを見る。ラベルの下の各要素は any で結ばれ、
// any-glob-to-any-file はどれかのグロブに当たるファイルが1つあれば、all-globs-to-any-file はすべてのグロブに当たるファイルが1つあれば真。
// この2つのほかの書き方を規則に足したら、ここで落ちるので、評価を足してから使う
type Matcher = { 'any-glob-to-any-file'?: string[]; 'all-globs-to-any-file'?: string[] };

const config = load(readFileSync(new URL('../.github/labeler.yml', import.meta.url), 'utf8')) as Record<
  string,
  { 'changed-files': Matcher[] }[]
>;

function matches(globs: string[], path: string, every: boolean): boolean {
  const matchers = globs.map((glob) => new Minimatch(glob, { dot: true }));
  return every ? matchers.every((m) => m.match(path)) : matchers.some((m) => m.match(path));
}

function needsHuman(path: string): boolean {
  return config['needs-human']!.some((item) => {
    assert.deepEqual(Object.keys(item), ['changed-files']);
    return item['changed-files'].some((matcher) => {
      const [key, ...rest] = Object.keys(matcher);
      assert.equal(rest.length, 0);
      if (key === 'any-glob-to-any-file') return matches(matcher[key]!, path, false);
      if (key === 'all-globs-to-any-file') return matches(matcher[key]!, path, true);
      throw new Error(`評価できない書き方: ${key}`);
    });
  });
}

describe('needs-human の .claude/ の規則', () => {
  test('.md 以外のファイルは、スキルの下でも守る', () => {
    for (const path of [
      '.claude/settings.json',
      '.claude/hooks/guard-bash.mjs',
      '.claude/skills/pr-create/run.py',
      '.claude/skills/sprint-review/check-criterion.py',
      '.claude/checklists/run.sh',
      '.claude/skills/x/SKILL.MD',
    ]) {
      assert.equal(needsHuman(path), true, path);
    }
  });

  test('ai-review のスキルとエージェントは .md も守る', () => {
    for (const path of [
      '.claude/skills/ai-review/SKILL.md',
      '.claude/agents/code-reviewer.md',
      '.claude/hooks/README.md',
    ]) {
      assert.equal(needsHuman(path), true, path);
    }
  });

  test('文書だけの PR の範囲の外の .claude/ の .md と、入れ子の .claude/ は守る', () => {
    for (const path of [
      '.claude/commands/x.md',
      '.claude/CLAUDE.md',
      'src/.claude/skills/x/SKILL.md',
      'src/.claude/run.py',
    ]) {
      assert.equal(needsHuman(path), true, path);
    }
  });

  test('ai-review 以外のスキルとチェックリストの .md は守らない', () => {
    for (const path of [
      '.claude/skills/retro/SKILL.md',
      '.claude/skills/pr-create/github-mcp.md',
      '.claude/checklists/multi-tenant.md',
      '.claude/checklists/languages/typescript.md',
    ]) {
      assert.equal(needsHuman(path), false, path);
    }
  });

  test('Codex の設定と Codex が読む決まりは守る', () => {
    for (const path of [
      '.codex/agents/implementer.toml',
      '.codex/config.toml',
      'AGENTS.md',
      'AGENTS.override.md',
      'src/AGENTS.md',
      'src/AGENTS.override.md',
      'src/.codex/config.toml',
    ]) {
      assert.equal(needsHuman(path), true, path);
    }
  });

  test('API トークンで呼べるかの判定は権限の検査として守り、各操作の処理は守らない', () => {
    assert.equal(needsHuman('src/server/operations/token-scope.ts'), true);
    assert.equal(needsHuman('src/server/operations/operation-list.ts'), false);
  });

  test('.claude/ の外の文書は守らない', () => {
    for (const path of ['docs/development.md', 'CLAUDE.md', 'README.md']) {
      assert.equal(needsHuman(path), false, path);
    }
  });
});
