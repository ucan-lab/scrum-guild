// 要素の外側を操作できなくする（キーボードのフォーカスも、読み上げも届かなくする）。
// 引き出しは <dialog> の showModal() を使わないので、
// モーダルの形（横と真ん中）のときだけ、要素から body まで、各階層の兄弟に inert を付ける。返す関数で元に戻す。
// keep が真の兄弟は残す（幕、トースト、別のダイアログ）。すでに inert の要素は触らない
export function inertOutside(target: Element, keep: (sibling: Element) => boolean): () => void {
  const changed: Element[] = [];
  for (let node: Element | null = target; node !== null && node !== document.body; node = node.parentElement) {
    for (const sibling of node.parentElement?.children ?? []) {
      if (sibling === node || sibling.hasAttribute('inert') || keep(sibling)) continue;
      sibling.setAttribute('inert', '');
      changed.push(sibling);
    }
  }
  return () => {
    for (const element of changed) element.removeAttribute('inert');
  };
}
