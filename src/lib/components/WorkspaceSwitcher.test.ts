import { render } from 'svelte/server';
import { describe, expect, test, vi } from 'vitest';
import { word } from '../../shared/vocabulary.ts';
import WorkspaceSwitcher from './WorkspaceSwitcher.svelte';

vi.mock('$app/paths', () => ({
  resolve: (_route: string, params: { slug: string; id: string }) => `/${params.slug}/w/${params.id}`,
}));

const current = { id: 'one', name: '架空の開発チーム' };
const other = { id: 'two', name: '架空の保守チーム' };
const html = (workspaces = [current, other], currentWorkspace = current) =>
  render(WorkspaceSwitcher, { props: { workspaces, currentWorkspace, slug: 'sample' } }).body;

function list(body: string): string {
  return /<ul\b[\s\S]*?<\/ul>/.exec(body)![0];
}

describe('ワークスペースの切り替え', () => {
  test('閉じたボタンと名前付き一覧を持ち、今のリンクにだけ aria-current とチェックを出す', () => {
    const body = html();
    expect(body).toContain('aria-expanded="false"');
    expect(body).toContain(
      `aria-label="${word('workspaceSwitchLabel', { name: current.name, workspace: word('workspace') })}"`,
    );
    expect(body).toContain(`aria-label="${word('workspaceSwitchListLabel', { workspace: word('workspace') })}"`);
    const id = /aria-controls="([^"]+)"/.exec(body)![1];
    expect(list(body)).toContain(`id="${id}"`);
    expect(list(body)).toMatch(/<ul[^>]*hidden/);
    expect(body.match(/aria-current="page"/g)).toHaveLength(1);
    expect(body.match(/#i-check/g)).toHaveLength(1);
    expect(body).toMatch(/href="\/sample\/w\/one"[^>]*aria-current="page"/);
    expect(body).toContain('href="/sample/w/two"');
    expect(body).not.toContain('<select');
  });

  test('所属が1つでもボタンとリンクを出す', () => {
    const body = html([current]);
    expect(body).toContain('<button');
    expect(body).toContain('href="/sample/w/one"');
    expect(body).not.toContain('disabled');
  });

  test('所属していない管理者の今のものは先頭に名前だけを出し、所属先だけをリンクにする', () => {
    const body = html([other]);
    const rows = list(body);
    expect(rows.indexOf(current.name)).toBeLessThan(rows.indexOf(other.name));
    expect(rows).toContain('class="ws-menu-current"');
    expect(rows).not.toContain('href="/sample/w/one"');
    expect(rows).toContain('href="/sample/w/two"');
    expect(rows).toContain('<span aria-current="page">架空の開発チーム</span>');
    expect(rows).not.toMatch(/<a [^>]*aria-current/);
    // 現在地は色だけでなく、チェックでも示す。リンクの行（所属先）にはチェックが付かないので、1つだけ。
    expect(rows.match(/#i-check/g)).toHaveLength(1);
    expect(rows).toMatch(/<li class="ws-menu-current">.*#i-check/);
  });

  test('所属が無い管理者にも今の名前だけを出す', () => {
    const body = html([]);
    expect(list(body)).toContain(current.name);
    expect(list(body)).not.toContain('<a');
  });

  test('多数の所属も省かず、名前の HTML を文字として出す', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `w${i}`, name: `架空のチーム ${i}` }));
    const body = html(many);
    expect(list(body).match(/<a\b/g)).toHaveLength(50);
    const escaped = html([{ ...current, name: '<img src=x>' }]);
    expect(escaped).not.toContain('<img');
    expect(escaped).toContain('&lt;img src=x>');
  });
});
