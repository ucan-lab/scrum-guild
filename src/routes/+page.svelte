<script lang="ts">
  import { getHealth } from '../lib/api.ts';

  // 土台のシェル。画面と API がつながったことを示すだけで、文言は言葉の辞書を持ち込むときに置き換える
  const health = getHealth();
</script>

<main>
  <h1>Scrum Guild</h1>
  {#await health}
    <p>API を確かめています</p>
  {:then result}
    {#if result.ok}
      <p>API: {result.data.status}（版 {result.data.version}）</p>
    {:else}
      <p>API: {result.status} {result.error?.code ?? ''}</p>
    {/if}
  {:catch}
    <p>API に届きませんでした</p>
  {/await}
</main>
