<script lang="ts">
  import { themeLabelKeys, themes } from '../../shared/theme.ts';
  import { setTheme, themeState } from '../theme.svelte.ts';
  import { setVocabularies, t, vocabularies } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // 開発用のテーマと言葉の切り替え。kit.js の上の帯の「言葉」と「テーマ」に当たる。
  // 本番の build には入れない（呼ぶ側が import.meta.env.DEV で囲む）。本物の切り替えは設定の画面で作る（#53 で消す）。

  // シンプル（自動）→ シンプル（ライト）→ シンプル（ダーク）→ 中世風 → 現代風 → シンプル（自動）
  function cycleTheme(): void {
    const index = themeState.current ? themes.indexOf(themeState.current) : -1;
    setTheme(themes[(index + 1) % themes.length]);
  }

  // 組織の言葉もワークスペースの言葉も、まとめてゲームとスクラムを入れ替える
  function toggleVocabulary(): void {
    const next = vocabularies.workspace === 'game' ? 'scrum' : 'game';
    setVocabularies({ workspace: next, organization: next });
  }
</script>

<button class="pill" type="button" data-dev-switch="vocabulary" onclick={toggleVocabulary}>
  <Icon name="swap" /><span>{t('vocabLabel')}: {t('vocab')}</span>
</button>
<button class="pill" type="button" data-dev-switch="theme" onclick={cycleTheme}>
  <Icon name="moon" /><span>{t('themeLabel')}: {t(themeLabelKeys[themeState.current ?? 'simple'])}</span>
</button>
