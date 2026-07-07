// ─────────────────────────────────────────────────────────────────────────────
//  Lab Eval — AI Evaluation panel
//
//  Replaces the old registry-driven "⚖ Score last run with:" dropdown plus
//  the separate "📊 Score Repeat Variance" button. There's exactly one
//  scorer left (the judge model) and three checkable dimensions —
//  Completeness, Correctness, Hallucination Risk — so this panel is bespoke
//  rather than generated from GET /api/scorers the way the old one was.
//  See app/scoring/ai_eval.py for the rubric text and scoring logic; this
//  file only owns the UI and the one request it fires.
//
//  One click = one request = one combined judge-model call per generation,
//  covering whichever dimensions are checked, with repeat-variance computed
//  server-side in the same request whenever the run's repeat_count >= 2 —
//  see app/routers/eval.py's score_run(). The old scorer registry's
//  "add a scorer, it appears in the UI with zero frontend changes" property
//  doesn't hold for this feature any more — that's an accepted trade-off,
//  not an oversight.
// ─────────────────────────────────────────────────────────────────────────────

import { escHtml } from '../../../shared/markdown.js';
import { scoreEvalRun } from '../../../shared/api-client.js';

// Only a change to which option is PRE-SELECTED — the user can still pick
// any other installed model, or pull a new one via Manage Models first.
const DEFAULT_JUDGE_MODEL = 'qwen3.5:9b';

export const DIMENSIONS = [
  { key: 'completeness',       label: 'Completeness' },
  { key: 'correctness',        label: 'Correctness' },
  { key: 'hallucination_risk', label: 'Hallucination Risk' },
];

export function initAiEvalPanel({ baseUrl, showToast, getLastRunId, onScored }) {
  const $modelSelect = document.getElementById('judge-model-select');
  const $runBtn       = document.getElementById('run-ai-eval-btn');
  const $status       = document.getElementById('ai-eval-status');
  const $checkboxes   = Object.fromEntries(DIMENSIONS.map(d => [d.key, document.getElementById(`dim-${d.key}`)]));

  // Same fetch-once-populate-many-dropdowns mechanism every other model
  // dropdown in the app uses (model-select.js, axis-panel.js) — this one
  // just has a different pre-selection rule: default to qwen3.5:9b when
  // it's installed, otherwise fall back to the same convention
  // model-select.js's BASE panel uses (its first/alphabetically-first
  // installed model — getTags() already sorts the list that way).
  function setAvailableModels(models) {
    const prevValue = $modelSelect.value;
    if (models.length === 0) {
      $modelSelect.innerHTML = '<option value="">No models — pull one above</option>';
      return;
    }
    $modelSelect.innerHTML = models.map(m => `<option value="${escHtml(m.name)}">${escHtml(m.name)}</option>`).join('');
    if (prevValue && models.some(m => m.name === prevValue)) {
      $modelSelect.value = prevValue;
    } else if (models.some(m => m.name === DEFAULT_JUDGE_MODEL)) {
      $modelSelect.value = DEFAULT_JUDGE_MODEL;
    } else {
      $modelSelect.value = models[0].name;
    }
  }

  function selectedDimensions() {
    return DIMENSIONS.filter(d => $checkboxes[d.key].checked).map(d => d.key);
  }

  $runBtn.addEventListener('click', async () => {
    const runId = getLastRunId();
    if (!runId) { showToast('⚠ Run an eval first, then score it'); return; }
    const dimensions = selectedDimensions();
    if (dimensions.length === 0) { showToast('⚠ Check at least one dimension to evaluate'); return; }
    const judgeModel = $modelSelect.value;
    if (!judgeModel) { showToast('⚠ Pick a judge model'); return; }

    $runBtn.disabled = true;
    $runBtn.textContent = 'Evaluating…';
    // Staged progress (redesign item 2), same spirit as the Run Sweep
    // staging in eval-harness.js: the instant the request is sent, we have
    // no signal yet on whether the judge model needs to load into Ollama,
    // so show a "loading" state by default; the moment the FIRST NDJSON
    // line arrives (a progress line for generation #1 having been judged),
    // that's proof the judge model is warm and actually judging, so flip to
    // real "judging N of Total" progress. Same "assume loading until the
    // first signal proves otherwise" mechanism as section 1 — reused, not
    // reinvented, per the brief.
    $status.textContent = `⏳ Loading judge model ${judgeModel}…`;
    try {
      const result = await scoreEvalRun(baseUrl, runId, dimensions, judgeModel, {
        onProgress: (completed, total) => {
          $status.textContent = `AI Evaluation running — judging ${completed} of ${total}…`;
        },
      });
      const judgments = result.judgments || [];
      onScored?.(judgments);

      // Variance rows (item 5) share the same response but are set-level —
      // repeat_index is null on those, distinguishing them from the
      // per-generation dimension judgments for the toast summary below.
      const perGenCount   = judgments.filter(j => j.repeat_index != null).length;
      const varianceCount = judgments.length - perGenCount;
      $status.textContent = `Judge: ${judgeModel} · ${dimensions.length} dimension${dimensions.length !== 1 ? 's' : ''}`;
      showToast(`✅ AI Evaluation complete — ${perGenCount} judgment${perGenCount !== 1 ? 's' : ''}` +
        (varianceCount ? `, ${varianceCount} variance result${varianceCount !== 1 ? 's' : ''}` : ''));
    } catch (e) {
      $status.textContent = '';
      showToast(`❌ AI Evaluation failed: ${e.message}`);
    } finally {
      $runBtn.disabled = false;
      $runBtn.textContent = 'Run AI Evaluation';
    }
  });

  return { setAvailableModels };
}
