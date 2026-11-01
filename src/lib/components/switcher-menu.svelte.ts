// 組織とワークスペースで揃える開閉とフォーカス。項目は通常のリンクで、Tab で選んで Enter で移る。
export class SwitcherMenu {
  open = $state(false);
  root = $state<HTMLElement>();
  button = $state<HTMLButtonElement>();

  close = (): void => {
    if (this.root?.contains(document.activeElement)) this.button?.focus();
    this.open = false;
  };

  toggle = (): void => {
    if (this.open) this.close();
    else this.open = true;
  };

  onkeydown = (event: KeyboardEvent): void => {
    if (!this.open || event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return;
    event.stopPropagation();
    this.close();
  };

  onclick = (event: MouseEvent): void => {
    if (this.open && this.root && event.target instanceof Node && !this.root.contains(event.target)) this.close();
  };

  onfocusout = (event: FocusEvent): void => {
    const next = event.relatedTarget;
    // Tab で外へ移ったときは、移った先にフォーカスを残す。
    if (this.open && this.root && next instanceof Node && !this.root.contains(next)) this.open = false;
  };
}
