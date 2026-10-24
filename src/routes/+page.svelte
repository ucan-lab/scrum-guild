<script lang="ts">
  import { getHealth } from '../lib/api.ts';

  // 土台のシェル。画面と API がつながったことを示すだけで、文言は言葉の辞書を持ち込むときに置き換える
  const health = getHealth();
</script>

<svelte:head>
  <title>Scrum Guild</title>
</svelte:head>

<main>
  <h1>Scrum Guild</h1>
  <p role="status">
    {#await health}
      API を確かめています
    {:then result}
      {#if result.ok}
        API: {result.data.status}（版 {result.data.version}）
      {:else}
        API に届きませんでした（{result.status}）
      {/if}
    {:catch}
      API に届きませんでした
    {/await}
  </p>
</main>
