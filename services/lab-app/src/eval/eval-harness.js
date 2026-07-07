// ─────────────────────────────────────────────────────────────────────────────
//  Lab Eval — batch Eval Harness (axis-generic sweeps)
//
//  Dataset parsing/import is untouched from the original two-config version.
//  What changed:
//    - runSweep() replaces runEval(): it reads axes/base_config/repeat_count/
//      hosted_baseline from axis-panel.js, creates a run via createEvalSweep(),
//      and expands the cartesian product into one task per (cell, prompt,
//      repeat) — not just two.
//    - A bounded client-side worker pool (CONCURRENCY workers pulling from a
//      shared queue) replaces the old "loop prompts sequentially, run A/B in
//      parallel" structure — a 5x5 grid over 20 prompts is 500 tasks, not 2.
//      The backend's own semaphore (EVAL_MAX_CONCURRENCY) is the real
//      protection for Ollama; this pool mostly bounds how many streams the
//      *browser* juggles at once.
//    - Results feed grid-view.js instead of a two-column table.
// ─────────────────────────────────────────────────────────────────────────────

import { streamEvalGenerate, createEvalSweep, finishEvalRun } from '../../../shared/api-client.js';

const CONCURRENCY = 4;

export function initEvalHarness({ baseUrl, showToast, axisPanel, gridView, aiEvalGrid, onRunFinished }) {
  const $evalDataset      = document.getElementById('eval-dataset');
  const $evalDatasetCount = document.getElementById('eval-dataset-count');
  const $evalImportBtn    = document.getElementById('eval-import-btn');
  const $evalFileInput    = document.getElementById('eval-file-input');
  const $runEvalBtn       = document.getElementById('run-eval-btn');
  const $stopEvalBtn      = document.getElementById('stop-eval-btn');
  const $evalProgressWrap = document.getElementById('eval-progress-wrap');
  const $evalProgressLabel= document.getElementById('eval-progress-label');
  const $evalProgressPct  = document.getElementById('eval-progress-pct');
  const $evalProgressFill = document.getElementById('eval-progress-fill');
  const $exportJsonBtn    = document.getElementById('export-json-btn');
  const $exportMdBtn      = document.getElementById('export-md-btn');

  let evalPrompts   = [];
  let evalRunning   = false;
  let evalStopFlag  = false;
  let activeControllers = new Set();
  let refreshTimer  = null;

  let lastRunId   = null;
  let lastRunMeta = null;   // { axes, baseConfig, repeatCount, hostedBaseline }
  let lastStatus  = 'running';
  let prompts     = [];
  let cells       = [];
  let resultsMap  = new Map();   // "cell:prompt:repeat" -> EvalResultOut-shaped object
  let judgments   = [];

  // ── Staged progress (redesign item 1) ───────────────────────────────────
  //
  // Option B (client-only), chosen deliberately over Option A's backend
  // `GET /api/ps` warm-check: this needs no backend change and — since
  // every generation already streams through consumeChatStream(), which
  // already fires onContent/onThinking the instant the first chunk lands —
  // "assume loading until the first chunk proves otherwise" gets the same
  // user-visible result (a state change instead of silence) as a definitive
  // warm/cold check would, just without being able to distinguish "actually
  // cold" from "queued behind EVAL_MAX_CONCURRENCY" for a few hundred ms.
  // That distinction isn't worth a new endpoint + race-condition surface
  // for this UI.
  let warmModels    = new Set();   // models that have streamed at least one chunk THIS sweep
  let loadingModels = new Set();   // models currently believed to be cold-loading (no chunk yet)
  let completedCount = 0;
  let totalTaskCount  = 0;

  function cellModel(cellIndex) {
    const cell = cells.find(c => c.cell_index === cellIndex);
    if (!cell) return null;
    return cell.config.model ?? lastRunMeta?.baseConfig?.model ?? null;
  }

  // Single source of truth for what the progress label shows, called on
  // every state transition (task starts loading, model warms up, a task
  // completes) rather than only on a timer, so the label never sits stale
  // during a real, human-perceptible model-load delay.
  function renderSweepProgress() {
    if (totalTaskCount === 0) { setEvalProgress(0, 0, ''); return; }
    if (loadingModels.size > 0) {
      // Multiple distinct not-yet-warm models can start loading at once
      // under CONCURRENCY > 1; showing the first is enough to answer "is
      // this frozen?" without cluttering the single-line label.
      const model = [...loadingModels][0];
      setEvalProgress(completedCount, totalTaskCount, `Loading ${model}… (${completedCount} of ${totalTaskCount} generations done)`);
      return;
    }
    setEvalProgress(completedCount, totalTaskCount, evalStopFlag
      ? `Stopped at ${completedCount} of ${totalTaskCount}`
      : `Running ${completedCount} of ${totalTaskCount} generations…`);
  }

  // ── Dataset parsing & import (unchanged) ──────────────────────────────────

  function parseDatasetText(text) {
    if (/^\s*---\s*$/m.test(text)) {
      return text.split(/^\s*---\s*$/m).map(s => s.trim()).filter(Boolean);
    }
    return text.split('\n').map(s => s.trim()).filter(Boolean);
  }

  function refreshDatasetCount() {
    evalPrompts = parseDatasetText($evalDataset.value);
    $evalDatasetCount.textContent = `${evalPrompts.length} prompt${evalPrompts.length !== 1 ? 's' : ''}`;
    axisPanel.updatePreview(evalPrompts.length);
  }

  $evalDataset.addEventListener('input', refreshDatasetCount);

  function normalizeJsonDataset(parsed) {
    let arr = parsed;
    if (!Array.isArray(arr) && arr && Array.isArray(arr.prompts)) arr = arr.prompts;
    if (!Array.isArray(arr)) return [];
    return arr.map(item => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object' && typeof item.prompt === 'string') return item.prompt.trim();
      return '';
    }).filter(Boolean);
  }

  $evalImportBtn.addEventListener('click', () => $evalFileInput.click());

  $evalFileInput.addEventListener('change', async () => {
    const file = $evalFileInput.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      if (file.name.toLowerCase().endsWith('.json')) {
        const parsedPrompts = normalizeJsonDataset(JSON.parse(text));
        if (parsedPrompts.length === 0) { showToast('⚠ No prompts found in that JSON file'); return; }
        $evalDataset.value = parsedPrompts.join('\n---\n');
      } else {
        $evalDataset.value = text;
      }
      refreshDatasetCount();
      showToast(`Imported ${evalPrompts.length} prompt${evalPrompts.length !== 1 ? 's' : ''} from ${file.name}`);
    } catch (e) {
      showToast(`❌ Import failed: ${e.message}`);
    } finally {
      $evalFileInput.value = '';
    }
  });

  // ── Progress ─────────────────────────────────────────────────────────────

  function setEvalProgress(current, total, label) {
    if (total === 0) { $evalProgressWrap.style.display = 'none'; return; }
    $evalProgressWrap.style.display = 'block';
    const pct = Math.round((current / total) * 100);
    $evalProgressLabel.textContent = label;
    $evalProgressPct.textContent = `${pct}%`;
    $evalProgressFill.style.width = `${pct}%`;
  }

  function setRunEvalUI(running) {
    $runEvalBtn.style.display = running ? 'none' : 'flex';
    $stopEvalBtn.style.display = running ? 'flex' : 'none';
    $evalDataset.disabled = running;
    $evalImportBtn.disabled = running;
    axisPanel.setEnabled(!running);
  }

  function buildRunPayload(status) {
    if (status !== undefined) lastStatus = status;
    return {
      id: lastRunId,
      axes: lastRunMeta.axes,
      base_config: lastRunMeta.baseConfig,
      repeat_count: lastRunMeta.repeatCount,
      hosted_baseline: lastRunMeta.hostedBaseline,
      status: lastStatus,
      prompts,
      cells,
      results: [...resultsMap.values()],
      judgments,
    };
  }

  // ── Run loop ───────────────────────────────────────────────────────────────

  async function runOne(task) {
    const key = `${task.cellIndex}:${task.promptIndex}:${task.repeatIndex}`;
    resultsMap.set(key, {
      cell_index: task.cellIndex, prompt_index: task.promptIndex, repeat_index: task.repeatIndex,
      status: 'running', response: '', thinking: null, stats: null, error: null,
    });

    // Staged progress (item 1): if this task's model hasn't streamed a
    // chunk yet THIS sweep, assume it's cold-loading into Ollama the moment
    // the request goes out — reflected immediately, not just on the next
    // 400ms grid tick.
    const model = cellModel(task.cellIndex);
    const isFirstForModel = model != null && !warmModels.has(model);
    if (isFirstForModel) {
      loadingModels.add(model);
      renderSweepProgress();
    }
    let markedWarm = false;
    function markWarm() {
      if (markedWarm || model == null) return;
      markedWarm = true;
      if (!warmModels.has(model)) {
        warmModels.add(model);
        loadingModels.delete(model);
        renderSweepProgress();
      }
    }

    const controller = new AbortController();
    activeControllers.add(controller);
    try {
      const { fullContent, fullThinking, stats } = await streamEvalGenerate(baseUrl, {
        runId: lastRunId, cellIndex: task.cellIndex, promptIndex: task.promptIndex, repeatIndex: task.repeatIndex,
      }, controller.signal, {
        onContent: (c) => { markWarm(); resultsMap.set(key, { ...resultsMap.get(key), response: c }); },
        onThinking: (t) => { markWarm(); resultsMap.set(key, { ...resultsMap.get(key), thinking: t }); },
      });
      resultsMap.set(key, {
        cell_index: task.cellIndex, prompt_index: task.promptIndex, repeat_index: task.repeatIndex,
        status: 'done', response: fullContent, thinking: fullThinking || null, stats, error: null,
      });
    } catch (err) {
      resultsMap.set(key, {
        cell_index: task.cellIndex, prompt_index: task.promptIndex, repeat_index: task.repeatIndex,
        status: 'error', response: '', thinking: null, stats: null,
        error: err.name === 'AbortError' ? 'Stopped' : err.message,
      });
    } finally {
      // Never leave this model stuck showing "Loading…" — a request that
      // errored/aborted before streaming any content still needs the label
      // to move on, or a bad model name would freeze the label forever.
      markWarm();
      activeControllers.delete(controller);
    }
  }

  async function runSweep() {
    if (evalRunning) return;

    refreshDatasetCount();
    if (evalPrompts.length === 0) { showToast('⚠ Add at least one prompt to the dataset'); return; }

    const axes = axisPanel.getAxes();
    const baseConfig = axisPanel.getBaseConfig();
    const repeatCount = axisPanel.getRepeatCount();
    const hostedBaseline = axisPanel.getHostedBaseline();

    if (!baseConfig.model && !axes.some(a => a.param === 'model')) {
      showToast('⚠ Select a model — either as an axis or in Base Config');
      return;
    }

    lastRunId = crypto.randomUUID();
    prompts = [...evalPrompts];
    judgments = [];
    resultsMap = new Map();
    warmModels = new Set();
    loadingModels = new Set();

    let sweepResp;
    try {
      sweepResp = await createEvalSweep(baseUrl, { id: lastRunId, axes, baseConfig, prompts, repeatCount, hostedBaseline });
    } catch (e) {
      showToast(`❌ Could not create sweep: ${e.message}`);
      return;
    }

    cells = sweepResp.cells;
    lastRunMeta = { axes, baseConfig, repeatCount, hostedBaseline };
    $exportJsonBtn.disabled = true;
    $exportMdBtn.disabled = true;
    gridView.render(buildRunPayload('running'));
    aiEvalGrid?.render(buildRunPayload());

    const tasks = [];
    for (const cell of cells) {
      for (let p = 0; p < prompts.length; p++) {
        for (let rep = 0; rep < repeatCount; rep++) {
          tasks.push({ cellIndex: cell.cell_index, promptIndex: p, repeatIndex: rep });
        }
      }
    }

    evalRunning = true;
    evalStopFlag = false;
    setRunEvalUI(true);

    completedCount = 0;
    totalTaskCount = tasks.length;
    renderSweepProgress();
    refreshTimer = setInterval(() => {
      const payload = buildRunPayload('running');
      gridView.updateData(payload);
      aiEvalGrid?.updateData(payload);
    }, 400);

    let nextIndex = 0;
    async function worker() {
      while (nextIndex < tasks.length) {
        if (evalStopFlag) return;
        const task = tasks[nextIndex++];
        await runOne(task);
        completedCount++;
        renderSweepProgress();
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));

    clearInterval(refreshTimer);
    refreshTimer = null;
    {
      const payload = buildRunPayload(evalStopFlag ? 'stopped' : 'done');
      gridView.updateData(payload);
      aiEvalGrid?.updateData(payload);
    }

    evalRunning = false;
    setRunEvalUI(false);
    $exportJsonBtn.disabled = false;
    $exportMdBtn.disabled = false;

    try {
      await finishEvalRun(baseUrl, lastRunId, evalStopFlag ? 'stopped' : 'done');
    } catch { /* non-fatal — export still works from the in-memory results */ }

    showToast(evalStopFlag
      ? `⏹ Sweep stopped — ${completedCount} of ${tasks.length} generations`
      : `✅ Sweep complete — ${tasks.length} generation${tasks.length !== 1 ? 's' : ''}`);

    onRunFinished?.(lastRunId);
  }

  function stopEval() {
    evalStopFlag = true;
    activeControllers.forEach(c => c.abort());
    showToast('Stopping after in-flight requests finish…');
  }

  $runEvalBtn.addEventListener('click', runSweep);
  $stopEvalBtn.addEventListener('click', stopEval);

  // ── Export ─────────────────────────────────────────────────────────────────

  function downloadTextFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function timestampForFilename() {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  function exportJSON() {
    if (!lastRunMeta) return;
    const payload = { exportedAt: new Date().toISOString(), ...buildRunPayload('exported') };
    downloadTextFile(`lab-app-eval-${timestampForFilename()}.json`, JSON.stringify(payload, null, 2), 'application/json');
    showToast('Exported JSON report');
  }

  function statLine(stats) {
    if (!stats) return '_n/a_';
    return `TTFT ${stats.ttft.toFixed(3)}s · ${stats.tokensPerSec.toFixed(2)} tok/s · ${stats.evalCount} tokens · ${stats.totalTime.toFixed(3)}s total`;
  }

  function exportMarkdown() {
    if (!lastRunMeta) return;
    let md = `# Lab Eval Sweep Report\n\n`;
    md += `Generated: ${new Date().toLocaleString()}\n\n`;
    md += `## Axes\n\n`;
    for (const axis of lastRunMeta.axes) {
      md += `- **${axis.param}**: ${axis.values.map(v => String(v)).join(', ')}\n`;
    }
    md += `\n## Base Config\n\n`;
    for (const [k, v] of Object.entries(lastRunMeta.baseConfig)) md += `- **${k}**: ${v}\n`;
    md += `\nRepeat count: ${lastRunMeta.repeatCount}\n`;
    if (lastRunMeta.hostedBaseline) md += `Hosted baseline: ${lastRunMeta.hostedBaseline.model} @ ${lastRunMeta.hostedBaseline.endpoint}\n`;

    for (const cell of cells) {
      md += `\n---\n\n## Cell ${cell.cell_index}${cell.is_baseline ? ' (hosted baseline)' : ''}\n\n`;
      md += Object.entries(cell.config).map(([k, v]) => `**${k}**: ${v}`).join(' · ') + '\n\n';
      prompts.forEach((prompt, promptIndex) => {
        md += `### Prompt ${promptIndex + 1}\n\n${prompt}\n\n`;
        for (const [key, r] of resultsMap) {
          if (r.cell_index !== cell.cell_index || r.prompt_index !== promptIndex) continue;
          md += `**Repeat ${r.repeat_index + 1}** — ${statLine(r.stats)}\n\n`;
          md += r.status === 'error' ? `_Error: ${r.error}_\n\n` : `${r.response || '_(empty response)_'}\n\n`;

          // Per-generation AI Evaluation scores — score + label only, no
          // rationale, to keep the report scannable (item 6).
          const genJudgments = judgments.filter(j =>
            j.cell_index === cell.cell_index && j.prompt_index === promptIndex && j.repeat_index === r.repeat_index);
          if (genJudgments.length) {
            md += genJudgments
              .map(j => `- **${j.scorer_name}**: ${j.score != null ? j.score : 'n/a'}${j.label ? ` (${j.label})` : ''}`)
              .join('\n') + '\n\n';
          }
        }

        // Set-level judgments (repeat-variance) describe the whole
        // repeat-set for this prompt, not one repeat — shown once per
        // prompt rather than per repeat.
        const setJudgments = judgments.filter(j =>
          j.cell_index === cell.cell_index && j.prompt_index === promptIndex && j.repeat_index == null);
        if (setJudgments.length) {
          md += `**Variance across repeats:**\n\n`;
          md += setJudgments
            .map(j => `- **${j.scorer_name}**: ${j.score != null ? j.score.toFixed(3) : 'n/a'}${j.label ? ` (${j.label})` : ''}`)
            .join('\n') + '\n\n';
        }
      });
    }
    downloadTextFile(`lab-app-eval-${timestampForFilename()}.md`, md, 'text/markdown');
    showToast('Exported Markdown report');
  }

  $exportJsonBtn.addEventListener('click', exportJSON);
  $exportMdBtn.addEventListener('click', exportMarkdown);

  // Called by ai-eval-panel.js after an AI Evaluation scoring pass completes
  // (repeat-variance rows, if any, are already included in that same
  // response) so the grid picks up new judgments without a full reload.
  // This is also the moment the dedicated AI Evaluation grid (redesign
  // item 3) needs to appear/update — it becomes visible the first time
  // this fires with at least one llm-judge:<dimension> judgment.
  function applyJudgments(newJudgments) {
    judgments = [...judgments, ...newJudgments];
    const payload = buildRunPayload();
    gridView.updateData(payload);
    aiEvalGrid?.updateData(payload);
  }

  // Reconstructs the grid from a persisted run (GET /api/eval/runs/{id}).
  function loadRun(run) {
    lastRunId = run.id;
    lastRunMeta = {
      axes: run.axes, baseConfig: run.base_config,
      repeatCount: run.repeat_count, hostedBaseline: run.hosted_baseline,
    };
    prompts = run.prompts;
    cells = run.cells;
    judgments = run.judgments;
    resultsMap = new Map();
    for (const r of run.results) {
      resultsMap.set(`${r.cell_index}:${r.prompt_index}:${r.repeat_index}`, r);
    }
    $exportJsonBtn.disabled = false;
    $exportMdBtn.disabled = false;
    {
      const payload = buildRunPayload(run.status);
      gridView.render(payload);
      aiEvalGrid?.render(payload);
    }
    showToast(`Loaded run — ${run.results.length} result${run.results.length !== 1 ? 's' : ''}`);
  }

  return {
    refreshDatasetCount,
    getLastRunId: () => lastRunId,
    applyJudgments,
    loadRun,
  };
}
