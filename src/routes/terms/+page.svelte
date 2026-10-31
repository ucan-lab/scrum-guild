<script lang="ts">
  import LegalPage from '../../lib/components/LegalPage.svelte';

  // 利用規約。ログインしていなくても開ける。load を置かないので、API を呼ばず、ログインの画面へ移らない（部品 LegalPage の説明）
</script>

<LegalPage kind="terms" />
