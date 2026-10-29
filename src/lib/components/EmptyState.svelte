<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { IconName } from '../icons.ts';
  import Icon from './Icon.svelte';

  // kit.js の emptyState。何が出る場所かと、次に何をすればよいかを書く。actions は押す操作。
  // iconTone はアイコンの色（Icon の tone）。ゲームの物のアイコンを置くときに、その語の色にする
  let {
    icon,
    iconTone,
    title,
    text,
    actions,
  }: { icon: IconName; iconTone?: 'xp'; title: string; text?: string; actions?: Snippet } = $props();
</script>

<div class="empty">
  <Icon name={icon} tone={iconTone} /><b>{title}</b>{#if text}<span>{text}</span>{/if}
  {#if actions}<div class="form-actions">{@render actions()}</div>{/if}
</div>
