<script lang="ts">
  import { t } from '../vocabulary.svelte.ts';

  // kit.js の sprintNotice（スプリントゴールの貼り紙）。ゴールは改行を残して複数行で出す（.notice-title.is-goal）。
  // workspaceName を渡すと、下に所属先を添える（複数のワークスペースのゴールを並べる今日やることの画面）。
  // 見本の期間と残りの日数の目盛りは、スプリントの画面の見出しが同じ値を出すので置かない
  let { goal, workspaceName }: { goal: string; workspaceName?: string } = $props();
</script>

<article class="notice">
  <span class="notice-label">{t('sprintGoal')}</span>
  <p class="notice-title is-goal">{goal}</p>
  {#if workspaceName !== undefined}<div class="notice-meta"><span>{workspaceName}</span></div>{/if}
</article>
