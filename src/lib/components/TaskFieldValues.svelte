<script lang="ts">
  import { taskFieldConflictReasonOf, taskFieldSet, type TaskFieldValue } from '../../shared/operations/task/index.ts';
  import { STORY_TEXT_MAX_LENGTH, longTextProblem, normalizeLongText } from '../../shared/story.ts';
  import { callOperation } from '../api.ts';
  import { EditBases } from '../field-edit.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';
  import InlineEdit from './InlineEdit.svelte';
  import Markdown from './Markdown.svelte';

  // タスクの詳細の引き出しの、決まった欄（design/kit.js の drawerHtml の「詳細」の field）。ワークスペースの決まった欄ごとに、
  // 名前（リーダーが付けたまま。辞書を通さない）を見出しにして、値を Markdown で描く。書かれていなければ「まだ書かれていません。」と、
  // 完了していないタスクだけ「未記入」の印（.chip.is-todo）を添える。書けるときは「編集」で InlineEdit に替わる（本文と同じ操作）。
  // 保存は task-field-set に、読んだ値（read_md。行が無ければ null）を添えて送る。読んだ値のままなら書かれ、同時に別の人が直していれば
  // 409 の changed で断られる。断られたら引き出しに読み直してもらい（onrefresh）、書きかけは残したまま、読み直した内容を見て決められる文を出す。
  // 空にして保存すると行が消え、未記入に戻る。書きかけ（保存した値と違う入力中の欄）があるかは ondirty で引き出しに伝える
  let {
    slug,
    workspaceId,
    taskId,
    fields,
    completed,
    canWrite,
    onsaved,
    onrefresh,
    onmissing,
    onstale,
    ondirty,
  }: {
    slug: string;
    workspaceId: string;
    taskId: string;
    fields: readonly TaskFieldValue[];
    // 完了したタスクは、値が無くても未記入の印を出さない
    completed: boolean;
    canWrite: boolean;
    // 書けた。応答の欄を引き出しの状態に入れ、変更の履歴と木を読み直してもらう
    onsaved: (field: TaskFieldValue) => void;
    // 今の値を読み直してもらう（409 の changed のとき）。読み直せたら true
    onrefresh: () => Promise<boolean>;
    // タスクか欄が見つからなかった（404）。引き出しが読み直し、タスクが消えていれば閉じる。欄が一覧から外れたことを確かめられたら true
    // （欄が無くなると書きかけの入力欄ごと消えるので、引き出しがトーストでも知らせる）
    onmissing: (fieldId: string) => Promise<boolean>;
    // ワークスペースが閉じていた。枠ごと読み直してもらう
    onstale: () => void;
    ondirty: (dirty: boolean) => void;
  } = $props();

  // 直し始めた時点の値（保存の読んだ値）
  const bases = new EditBases();

  // 直している途中の欄の ID
  let dirtyIds = $state<string[]>([]);

  function setDirty(id: string, dirty: boolean): void {
    const has = dirtyIds.includes(id);
    if (dirty === has) return;
    dirtyIds = dirty ? [...dirtyIds, id] : dirtyIds.filter((other) => other !== id);
    ondirty(dirtyIds.length > 0);
  }

  function problemOf(field: TaskFieldValue, raw: string): string | null {
    const value = normalizeLongText(raw);
    const problem = value === null ? null : longTextProblem(value);
    if (problem === 'too_long') return t('fieldTextTooLong', { field: field.name, max: STORY_TEXT_MAX_LENGTH });
    if (problem === 'invalid_character') return t('fieldTextInvalidCharacter', { field: field.name });
    return null;
  }

  // 書く。成功は null、失敗はエラーの文
  async function save(field: TaskFieldValue, raw: string): Promise<string | null> {
    const next = normalizeLongText(raw);
    // 読んだ値は、保存の時点の欄の値でなく、直し始めた時点の値（直している間に読み直しで別の人の値が入っても、黙って上書きしない）
    const read = bases.readFor(field.id, field.value_md);
    if (next === read) return null;
    const result = await callOperation(
      taskFieldSet,
      { workspace_id: workspaceId, task_id: taskId, field_id: field.id, value_md: next, read_md: read },
      { slug },
    );
    if (result.ok) {
      bases.finish(field.id);
      onsaved(result.data.field);
      showToast(t('taskSaved'), 'check');
      return null;
    }
    if (result.status === 404) {
      // 読み直して欄が一覧から外れていたときだけ、削除されたと言う（読み直せなかったときは言い切らない）
      return (await onmissing(field.id)) ? t('fieldValueGone') : t('taskSaveFailed');
    }
    if (result.status === 401) {
      onstale();
      return t('taskSaveFailed');
    }
    if (result.status === 409 && result.error?.code === 'workspace_closed') {
      onstale();
      return t('workspaceClosedReadOnly', { workspace: t('workspace') });
    }
    if (result.status === 409 && taskFieldConflictReasonOf(result.error?.details) === 'changed') {
      // 読み直せたら、読み直した値を次の読んだ値にする（読み直した内容を知らせた上で、もう一度保存すると上書きする）。
      // 読み直せなかったときは、読んだ値を替えない（もう一度保存しても断られる）
      if (!(await onrefresh())) return t('fieldValueRefreshFailed');
      bases.rebase(field.id, fields.find((other) => other.id === field.id)?.value_md ?? null);
      return t('fieldValueChanged');
    }
    return result.status === 400 ? t('taskBadRequest') : t('taskSaveFailed');
  }
</script>

{#snippet valueView(field: TaskFieldValue)}
  {#if field.value_md !== null}
    <Markdown source={field.value_md} headingStart={3} />
  {:else}
    <div class="doc-box is-empty">{t('fieldValueEmpty')}</div>
  {/if}
{/snippet}

{#snippet label(field: TaskFieldValue)}
  <span class="field-label">
    <Icon name="pen" />
    {field.name}
    {#if field.value_md === null && !completed}<span class="chip is-todo">{t('unfilledMark')}</span>{/if}
  </span>
{/snippet}

{#each fields as field (field.id)}
  <div class="field" data-field-id={field.id}>
    {#if canWrite}
      <InlineEdit
        value={field.value_md ?? ''}
        label={field.name}
        multiline
        hint={t('bodyEditHint')}
        problem={(raw) => problemOf(field, raw)}
        save={(raw) => save(field, raw)}
        normalize={(raw) => normalizeLongText(raw) ?? ''}
        ondirty={(dirty) => setDirty(field.id, dirty)}
        onbegin={(started) => bases.begin(field.id, normalizeLongText(started))}
      >
        {#snippet view(begin)}
          <div class="field-head">
            {@render label(field)}
            <button
              class="btn is-sm"
              type="button"
              aria-label={field.value_md === null
                ? t('fieldValueWriteLabel', { field: field.name })
                : t('fieldValueRewriteLabel', { field: field.name })}
              onclick={begin}
              ><Icon name="pen" />{field.value_md === null ? t('fieldValueWrite') : t('fieldValueRewrite')}</button
            >
          </div>
          {@render valueView(field)}
        {/snippet}
      </InlineEdit>
    {:else}
      {@render label(field)}
      {@render valueView(field)}
    {/if}
  </div>
{/each}
