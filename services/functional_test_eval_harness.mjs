// Functional test for the redesigned Eval Harness (axis-generic sweeps) and
// its "AI Evaluation" scoring panel. Loads the real lab-eval/index.html +
// app.js through jsdom with a fake fetch standing in for lab-api, then
// drives an actual 2x1 sweep (2 models on the default model axis x 1
// prompt) through the UI exactly as a user would, checks the grid rendered
// real results, then runs AI Evaluation (dimension checkboxes + judge-model
// picker) and checks the per-dimension judgments show up.
//
// Companion to functional_test_lab_eval.mjs, which covers the Diff view —
// this one covers the Eval Harness tab specifically.

import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';

const dir = path.resolve('lab-app');
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');

const dom = new JSDOM(html, {
  url: 'http://localhost/lab-app/index.html',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;

function fakeStream(text, model, opts = {}) {
  const { firstChunkDelayMs = 0 } = opts;
  const lines = [
    JSON.stringify({ model, message: { role: 'assistant', content: text } }),
    JSON.stringify({
      model, done: true,
      total_duration: 400_000_000, load_duration: 0,
      prompt_eval_count: 4, prompt_eval_duration: 50_000_000,
      eval_count: 2, eval_duration: 200_000_000,
    }),
  ];
  const body = lines.map(l => l + '\n').join('');
  const bytes = new TextEncoder().encode(body);
  let sent = false;
  return {
    getReader: () => ({
      async read() {
        if (sent) return { done: true };
        sent = true;
        if (firstChunkDelayMs) await new Promise(r => setTimeout(r, firstChunkDelayMs));
        return { done: false, value: bytes };
      },
    }),
  };
}

function fakeNdjsonStream(lines) {
  const body = lines.map(l => JSON.stringify(l) + '\n').join('');
  const bytes = new TextEncoder().encode(body);
  let sent = false;
  return { getReader: () => ({ async read() { if (sent) return { done: true }; sent = true; return { done: false, value: bytes }; } }) };
}

const createdRuns = {};
let lastScoreRequestBody = null;
const warmedInMock = new Map();   // run_id -> Set<model> that have already streamed once THIS run

window.fetch = async (url, opts) => {
  const u = String(url);
  const method = (opts?.method || 'GET').toUpperCase();

  if (u.includes('/api/tags')) {
    return { ok: true, json: async () => ({ models: [{ name: 'model-a' }, { name: 'model-b' }, { name: 'model-c' }] }), status: 200 };
  }
  if (u.includes('/api/conversations')) return { ok: true, json: async () => ([]), status: 200 };
  if (u.includes('/api/eval/runs') && method === 'POST' && !u.includes('/score')) {
    const body = JSON.parse(opts.body);
    const cells = body.axes.length
      ? body.axes[0].values.map((v, i) => ({ cell_index: i, config: { [body.axes[0].param]: v }, is_baseline: false }))
      : [{ cell_index: 0, config: {}, is_baseline: false }];
    createdRuns[body.id] = { ...body, cells };
    return { ok: true, json: async () => ({ id: body.id, cells, prompt_count: body.prompts.length, repeat_count: body.repeat_count }), status: 200 };
  }
  if (u.includes('/api/eval/generate') && method === 'POST') {
    const body = JSON.parse(opts.body);
    const run = createdRuns[body.run_id];
    const cell = run.cells.find(c => c.cell_index === body.cell_index);
    const model = cell.config.model || run.base_config.model;
    // First generation for a given model IN THIS RUN simulates a cold
    // Ollama model-load (a real, human-perceptible delay before ANY
    // content streams back) — every later cell on that same already-warm
    // model in the same run streams back immediately. Mirrors what
    // eval-harness.js's own warmModels tracking assumes.
    let warmSet = warmedInMock.get(body.run_id);
    if (!warmSet) { warmSet = new Set(); warmedInMock.set(body.run_id, warmSet); }
    const firstChunkDelayMs = warmSet.has(model) ? 0 : 60;
    warmSet.add(model);
    return { ok: true, body: fakeStream(`## Reply from ${model}\n\nSome **bold** point.`, model, { firstChunkDelayMs }), status: 200 };
  }
  if (u.match(/\/api\/eval\/runs\/[^/]+$/) && method === 'PATCH') {
    return { ok: true, json: async () => ({ status: 'done' }), status: 200 };
  }
  if (u.includes('/api/eval/runs') && u.endsWith('/score')) {
    lastScoreRequestBody = JSON.parse(opts.body);
    const dims = lastScoreRequestBody.dimensions || [];
    const scoreFor = { completeness: 9, correctness: 8, hallucination_risk: 2 };
    const judgments = dims.map(dim => ({
      cell_index: 0, prompt_index: 0, repeat_index: 0, scorer_name: `llm-judge:${dim}`,
      score: scoreFor[dim], label: `${scoreFor[dim]}/10`,
      rationale: `Judged by ${lastScoreRequestBody.model || 'default'}.`,
    }));
    return {
      ok: true, status: 200,
      body: fakeNdjsonStream([
        { type: 'progress', completed: 1, total: 1 },
        { type: 'done', judgments },
      ]),
    };
  }
  return { ok: false, status: 404, text: async () => `unhandled ${u}` };
};

global.window = window;
global.document = window.document;
global.location = window.location;
global.HTMLElement = window.HTMLElement;
global.fetch = window.fetch;
global.URL = window.URL;
global.Blob = window.Blob;

const errors = [];
window.addEventListener('error', (e) => errors.push(e.error?.stack || e.message));
window.addEventListener('unhandledrejection', (e) => errors.push(e.reason?.stack || String(e.reason)));

for (const tag of [...window.document.querySelectorAll('script[type="module"]')]) {
  const abs = path.resolve(dir, tag.getAttribute('src'));
  await import(`file://${abs}?t=${Date.now()}`);
}

await new Promise(r => setTimeout(r, 200));

const doc = window.document;

// Switch to the Eval Harness tab.
doc.querySelector('.main-tab[data-view="eval"]').dispatchEvent(new window.Event('click', { bubbles: true }));

// Enter a two-prompt dataset.
const dataset = doc.getElementById('eval-dataset');
dataset.value = 'What is 2+2?\nTell me a joke';
dataset.dispatchEvent(new window.Event('input', { bubbles: true }));

await new Promise(r => setTimeout(r, 250));   // let loadModels() resolve and axis-panel auto-select 2 models

console.log('Sweep preview:', doc.getElementById('sweep-preview').textContent);

// ── Base Config collapsible toggle ─────────────────────────────────────────
// Hidden by default; a click shows it, another click hides it again.
const $baseConfigToggle = doc.getElementById('base-config-toggle');
const $baseConfigPanel  = doc.getElementById('param-panel-BASE');
const baseConfigHiddenByDefault = $baseConfigPanel.style.display === 'none';

$baseConfigToggle.dispatchEvent(new window.Event('click', { bubbles: true }));
const baseConfigShownAfterFirstClick = $baseConfigPanel.style.display !== 'none';

$baseConfigToggle.dispatchEvent(new window.Event('click', { bubbles: true }));
const baseConfigHiddenAfterSecondClick = $baseConfigPanel.style.display === 'none';

console.log('Base Config hidden by default:', baseConfigHiddenByDefault,
  '| shown after 1st click:', baseConfigShownAfterFirstClick,
  '| hidden after 2nd click:', baseConfigHiddenAfterSecondClick);

doc.getElementById('run-eval-btn').dispatchEvent(new window.Event('click', { bubbles: true }));

await new Promise(r => setTimeout(r, 400));

const gridCells = doc.querySelectorAll('#eval-grid .grid-cell[data-cell-index]');
console.log('Grid cells rendered:', gridCells.length);
console.log('First cell tooltip:', gridCells[0]?.getAttribute('title'));
const tooltipExplainsAveraging = gridCells[0]?.getAttribute('title')?.includes('averaged over');

const gridWrap = doc.getElementById('eval-grid-wrap');
const emptyState = doc.getElementById('eval-empty-state');
console.log('Grid wrap visible:', gridWrap.style.display !== 'none', '| Empty state visible:', emptyState.style.display !== 'none');

// "Avg word count" should be available as a free Color-by option with zero
// scoring — it replaces the old response-length scorer entirely.
const colorByOptionsBeforeScoring = [...doc.getElementById('grid-color-by').options].map(o => o.value);
console.log('Color-by options before scoring:', colorByOptionsBeforeScoring);
const avgWordCountAvailable = colorByOptionsBeforeScoring.includes('__avg_word_count');

// Click the first cell and check the drill-down shows a real, markdown-rendered response.
if (gridCells[0]) gridCells[0].dispatchEvent(new window.Event('click', { bubbles: true }));
const detailEl = doc.getElementById('eval-grid-detail');
const detailTextBeforeScoring = detailEl.textContent;
const markdownRendered = detailEl.querySelector('.eval-detail-response h2') && detailEl.querySelector('.eval-detail-response strong');
console.log('Detail panel mentions a reply:', detailTextBeforeScoring.includes('Reply from'));
console.log('Markdown actually rendered (h2 + strong tags present):', !!markdownRendered);
console.log('No raw markdown syntax leaking into text:', !detailTextBeforeScoring.includes('##') && !detailTextBeforeScoring.includes('**'));

// ── AI Evaluation panel ──────────────────────────────────────────────────

const $judgeModelSelect = doc.getElementById('judge-model-select');
console.log('Judge-model options:', [...$judgeModelSelect.options].map(o => o.value));
const judgeModelDefaultsToInstalledOption = [...$judgeModelSelect.options].some(o => o.value === $judgeModelSelect.value);

// Uncheck Correctness — only Completeness and Hallucination Risk should be requested.
doc.getElementById('dim-correctness').checked = false;
doc.getElementById('dim-correctness').dispatchEvent(new window.Event('change', { bubbles: true }));

$judgeModelSelect.value = 'model-b';
doc.getElementById('run-ai-eval-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
// Captured synchronously: the click handler runs synchronously up to its
// first unresolved await (the /score fetch), so this is the true
// "request just went out, no signal yet" staged-progress state — redesign
// item 2's "Loading judge model {name}…" requirement.
const aiEvalStatusDuringLoad = doc.getElementById('ai-eval-status').textContent;
console.log('AI eval status immediately after click:', aiEvalStatusDuringLoad);
const showsLoadingJudgeModel = aiEvalStatusDuringLoad.includes('Loading') && aiEvalStatusDuringLoad.includes('judge model');
await new Promise(r => setTimeout(r, 200));

console.log('Score request dimensions:', lastScoreRequestBody?.dimensions, '| model:', lastScoreRequestBody?.model);
const onlyCheckedDimensionsSent =
  Array.isArray(lastScoreRequestBody?.dimensions) &&
  lastScoreRequestBody.dimensions.includes('completeness') &&
  lastScoreRequestBody.dimensions.includes('hallucination_risk') &&
  !lastScoreRequestBody.dimensions.includes('correctness');
const judgeModelSent = lastScoreRequestBody?.model === 'model-b';

const colorByOptionsAfterScoring = [...doc.getElementById('grid-color-by').options].map(o => o.value);
console.log('Color-by options after scoring:', colorByOptionsAfterScoring);
const perDimensionColorByOptionsAppeared =
  colorByOptionsAfterScoring.includes('llm-judge:completeness') &&
  colorByOptionsAfterScoring.includes('llm-judge:hallucination_risk') &&
  !colorByOptionsAfterScoring.includes('llm-judge:correctness');

const detailTextAfterScoring = doc.getElementById('eval-grid-detail').textContent;
const judgeRationaleShown = detailTextAfterScoring.includes('Judged by model-b');
console.log('Judge rationale visible in detail panel after scoring:', judgeRationaleShown);

// ── Dedicated AI Evaluation grid (redesign item 3) ────────────────────────

const $aiEvalGridWrap = doc.getElementById('ai-eval-grid-wrap');
const aiEvalGridAppearsAfterScoring = $aiEvalGridWrap.style.display !== 'none';
console.log('Dedicated AI Evaluation grid visible after scoring:', aiEvalGridAppearsAfterScoring);

const dimTabLabels = [...doc.querySelectorAll('#ai-eval-dim-tabs .ai-eval-dim-tab')].map(b => b.textContent.trim());
console.log('AI Evaluation grid dimension tabs:', dimTabLabels);
// Only the two CHECKED dimensions (Correctness was unchecked above) should
// get a tab — never a tab for a dimension that wasn't scored.
const tabsMatchScoredDimensions =
  dimTabLabels.includes('Completeness') &&
  dimTabLabels.includes('Hallucination Risk') &&
  !dimTabLabels.includes('Correctness');
const completenessTabActiveByDefault = doc.querySelector('#ai-eval-dim-tabs .ai-eval-dim-tab.active')?.textContent.trim() === 'Completeness';

const aiEvalGridCellsBeforeTabSwitch = doc.querySelectorAll('#ai-eval-grid .grid-cell[data-cell-index]').length;

// Switch to the Hallucination Risk tab — grid should still render (same
// cells, different metric) with that tab now marked active.
const hallucinationTab = [...doc.querySelectorAll('#ai-eval-dim-tabs .ai-eval-dim-tab')].find(b => b.textContent.trim() === 'Hallucination Risk');
hallucinationTab?.dispatchEvent(new window.Event('click', { bubbles: true }));
// renderTabs() rebuilds the tab strip's innerHTML on click, so the ORIGINAL
// `hallucinationTab` reference is now a detached/stale node — re-query.
const hallucinationTabNowActive = doc.querySelector('#ai-eval-dim-tabs .ai-eval-dim-tab.active')?.textContent.trim() === 'Hallucination Risk';
const aiEvalGridCellsAfterTabSwitch = doc.querySelectorAll('#ai-eval-grid .grid-cell[data-cell-index]').length;

// Toggling "Show variance instead of score" must not crash even though
// repeat_count is 1 here (no variance rows exist yet) — cells should just
// show "no data" rather than throwing.
const $varianceToggle = doc.getElementById('ai-eval-variance-toggle');
$varianceToggle.checked = true;
$varianceToggle.dispatchEvent(new window.Event('change', { bubbles: true }));
const varianceToggleRenderedWithoutCrash = doc.getElementById('ai-eval-grid').querySelector('.grid-table') != null;
$varianceToggle.checked = false;
$varianceToggle.dispatchEvent(new window.Event('change', { bubbles: true }));

// Clicking a cell in the dedicated grid should drive the MAIN grid's own
// drill-down/selection (redesign item 3's "consistent with the existing
// per-cell drill-down" requirement) rather than a second detail panel.
const firstAiEvalCell = doc.querySelector('#ai-eval-grid .grid-cell[data-cell-index]');
firstAiEvalCell?.dispatchEvent(new window.Event('click', { bubbles: true }));
const clickedCellIndex = firstAiEvalCell?.dataset.cellIndex;
const mainGridReflectsAiEvalGridClick = clickedCellIndex != null &&
  doc.querySelector(`#eval-grid .grid-cell[data-cell-index="${clickedCellIndex}"]`)?.classList.contains('grid-cell-selected');

// ── Staged Run Sweep progress feedback (redesign item 1) ──────────────────
//
// A fresh, single-prompt sweep so each of the 2 models gets exactly ONE
// task — avoids a race where a second concurrent same-model task (with no
// artificial cold-load delay) could mark the model "warm" before the
// deliberately-delayed first task's window has elapsed.
dataset.value = 'What is 2+2?';
dataset.dispatchEvent(new window.Event('input', { bubbles: true }));
await new Promise(r => setTimeout(r, 30));

doc.getElementById('run-eval-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
// Sampled after microtasks (sweep creation + task dispatch) have flushed,
// but before the mocked 60ms cold-load delay elapses.
await new Promise(r => setTimeout(r, 20));
const progressLabelDuringLoad = doc.getElementById('eval-progress-label').textContent;
console.log('Sweep progress label during cold load:', progressLabelDuringLoad);
const showsLoadingModelName = /Loading (model-a|model-b)/.test(progressLabelDuringLoad);

await new Promise(r => setTimeout(r, 300));   // let the sweep fully finish
const progressLabelAfterSweep = doc.getElementById('eval-progress-label').textContent;
console.log('Sweep progress label after completion:', progressLabelAfterSweep);
const noLongerLoadingAfterSweep = !progressLabelAfterSweep.includes('Loading');

console.log('\nErrors during interaction:', errors.length);
errors.forEach(e => console.log('  -', e));

const pass =
  errors.length === 0 &&
  gridCells.length === 2 &&
  gridWrap.style.display !== 'none' &&
  emptyState.style.display === 'none' &&
  tooltipExplainsAveraging &&
  avgWordCountAvailable &&
  detailTextBeforeScoring.includes('Reply from') &&
  markdownRendered &&
  !detailTextBeforeScoring.includes('##') && !detailTextBeforeScoring.includes('**') &&
  judgeModelDefaultsToInstalledOption &&
  onlyCheckedDimensionsSent &&
  judgeModelSent &&
  perDimensionColorByOptionsAppeared &&
  judgeRationaleShown &&
  showsLoadingJudgeModel &&
  aiEvalGridAppearsAfterScoring &&
  tabsMatchScoredDimensions &&
  completenessTabActiveByDefault &&
  aiEvalGridCellsBeforeTabSwitch === 2 &&
  hallucinationTabNowActive &&
  aiEvalGridCellsAfterTabSwitch === 2 &&
  varianceToggleRenderedWithoutCrash &&
  mainGridReflectsAiEvalGridClick &&
  showsLoadingModelName &&
  noLongerLoadingAfterSweep &&
  baseConfigHiddenByDefault &&
  baseConfigShownAfterFirstClick &&
  baseConfigHiddenAfterSecondClick;

console.log(pass ? '\n✅ PASS — axis sweep ran, grid rendered, AI Evaluation wired up, staged progress + dedicated grid verified' : '\n❌ FAIL');
process.exit(pass ? 0 : 1);
