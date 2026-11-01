import { afterEach, describe, expect, test, vi } from 'vitest';
import { SwitcherMenu } from './switcher-menu.svelte.ts';

// DOM を持たない実行環境で、フォーカスの内外とキーの分岐を確かめる。実際の Tab の順序は e2e。
class TestNode {}
afterEach(() => vi.unstubAllGlobals());

function setup() {
  vi.stubGlobal('Node', TestNode);
  const inside = new TestNode();
  const outside = new TestNode();
  const doc = { activeElement: inside };
  vi.stubGlobal('document', doc);
  const focus = vi.fn(() => {
    doc.activeElement = inside;
  });
  const menu = new SwitcherMenu();
  menu.root = { contains: (node: unknown) => node === inside } as unknown as HTMLElement;
  menu.button = { focus } as unknown as HTMLButtonElement;
  return { menu, inside, outside, doc, focus };
}

function key(key: string, extra = {}) {
  return { key, isComposing: false, keyCode: 0, stopPropagation: vi.fn(), ...extra } as unknown as KeyboardEvent;
}

describe('組織とワークスペースの共通の開閉', () => {
  test('ボタンで開閉し、閉じる際に中のフォーカスをボタンへ戻す', () => {
    const { menu, focus } = setup();
    menu.toggle();
    expect(menu.open).toBe(true);
    menu.toggle();
    expect(menu.open).toBe(false);
    expect(focus).toHaveBeenCalledOnce();
  });

  test('Esc は閉じてフォーカスを戻し、イベントの伝播を止める', () => {
    const { menu, focus } = setup();
    menu.open = true;
    const event = key('Escape');
    menu.onkeydown(event);
    expect(menu.open).toBe(false);
    expect(focus).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  test('矢印キーと日本語変換中の Esc は移動も開閉もしない', () => {
    const { menu, focus } = setup();
    menu.open = true;
    for (const event of [
      key('ArrowDown'),
      key('ArrowUp'),
      key('Escape', { isComposing: true }),
      key('Escape', { keyCode: 229 }),
    ]) {
      menu.onkeydown(event);
      expect(menu.open).toBe(true);
      expect(event.stopPropagation).not.toHaveBeenCalled();
    }
    expect(focus).not.toHaveBeenCalled();
  });

  test('内側のクリックでは閉じず、外側のクリックで閉じる', () => {
    const { menu, inside, outside } = setup();
    menu.open = true;
    menu.onclick({ target: inside } as unknown as MouseEvent);
    expect(menu.open).toBe(true);
    menu.onclick({ target: outside } as unknown as MouseEvent);
    expect(menu.open).toBe(false);
  });

  test('閉じているときの Esc と外側のクリックは何もしない', () => {
    const { menu, outside, focus } = setup();
    const event = key('Escape');
    menu.onkeydown(event);
    menu.onclick({ target: outside } as unknown as MouseEvent);
    expect(menu.open).toBe(false);
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  test('Tab で外へ移ったら閉じ、外のフォーカスを奪わない', () => {
    const { menu, inside, outside, doc, focus } = setup();
    menu.open = true;
    menu.onfocusout({ relatedTarget: inside } as unknown as FocusEvent);
    expect(menu.open).toBe(true);
    doc.activeElement = outside;
    menu.onfocusout({ relatedTarget: outside } as unknown as FocusEvent);
    expect(menu.open).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    menu.close();
    expect(focus).not.toHaveBeenCalled();
  });
});
