// Markdown.svelte の配線。本文（source）が変わるたびに MarkdownSession に表示を頼み、結果の節を少しずつ描かせ（markdown-render.ts）、
// 片付けで待ちと描きかけを取り下げる。部品から出して、Svelte の描画なしに $effect.root と flushSync で確かめられるようにしてある。
import { flushSync } from 'svelte';
import type { MarkdownBlock } from './markdown.ts';
import { browserFrameClock, stageBlocks, type FrameClock, type StagedRender } from './markdown-render.ts';
import { MarkdownSession, type MarkdownLoader, type MarkdownView } from './markdown-session.ts';

export type BoundMarkdownView = {
  // loading: 結果を待っている。ready: 今の本文の節。plain: 時間切れか失敗で、文字のまま出す
  status: MarkdownView['status'];
  // 今描いてある節。ready の間は今の本文の先頭から（段階の描画の途中は、全部の一部）。loading の間は前の本文の描画
  blocks: MarkdownBlock[] | null;
  // 節を段階で描いている途中
  rendering: boolean;
};

export function bindMarkdownView(
  getSource: () => string,
  loader: MarkdownLoader,
  clock: FrameClock = browserFrameClock,
): { readonly view: BoundMarkdownView } {
  // 節の木は大きい。中身を追跡させないよう、まるごと入れ替える（$state.raw）
  let view = $state.raw<BoundMarkdownView>({ status: 'loading', blocks: null, rendering: false });
  // 今描いてある節。効果の中から呼ばれる onView が view を読むと、効果が view に依存して回り続けるので、読む用に別に持つ
  let drawn: MarkdownBlock[] | null = null;
  let staged: StagedRender | null = null;

  function draw(next: BoundMarkdownView) {
    drawn = next.blocks;
    view = next;
  }

  function onView(next: MarkdownView) {
    staged?.cancel();
    staged = null;
    if (next.status === 'ready' && next.blocks) {
      const full = next.blocks;
      staged = stageBlocks({
        blocks: full,
        clock,
        show: (visible, { done, measured }) => {
          draw({ status: 'ready', blocks: visible, rendering: !done });
          // フレームの中では、描画をここで済ませて、時間を測らせる。効果の中の呼び出し（最初の1回）では呼べない
          if (measured) flushSync();
        },
      });
      return;
    }
    // 待つ間は、描いてある分（描きかけも）を残す。描きかけは、続きを描かずに捨てる
    draw({ status: next.status, blocks: next.status === 'loading' ? drawn : null, rendering: false });
  }

  const session = new MarkdownSession(loader, onView);

  // サーバーの描画（svelte/server）では動かない。ここが動くのはブラウザだけ
  $effect(() => {
    session.show(getSource());
    return () => {
      session.cancel();
      staged?.cancel();
    };
  });

  return {
    get view() {
      return view;
    },
  };
}
