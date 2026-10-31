<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ArtName } from '../art.ts';
  import type { IconName, IconTone } from '../icons.ts';
  import Art from './Art.svelte';
  import Icon from './Icon.svelte';

  // kit.js の emptyState。何が出る場所かと、次に何をすればよいかを書く。actions は押す操作。
  // art は線画（空の一覧と最初にやること用）。あればアイコンの代わりに置く。絵柄はテーマで替えず、文とボタンより目立たせない。
  // iconTone はアイコンの色（Icon の tone）。ゲームの物のアイコンを置くときに、その語の色にする
  let {
    icon,
    iconTone,
    art,
    title,
    text,
    actions,
  }: { icon: IconName; iconTone?: IconTone; art?: ArtName; title: string; text?: string; actions?: Snippet } = $props();
</script>

<div class="empty">
  {#if art}<Art name={art} />{:else}<Icon name={icon} tone={iconTone} />{/if}<b>{title}</b>{#if text}<span>{text}</span
    >{/if}
  {#if actions}<div class="form-actions">{@render actions()}</div>{/if}
</div>
