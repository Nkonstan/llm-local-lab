// ─────────────────────────────────────────────────────────────────────────────
//  Lab Eval — dedicated AI Evaluation grid (redesign item 3)
//
//  A second grid, separate from the main sweep grid's "Color by" dropdown,
//  that shows ONLY AI Evaluation dimension scores (llm-judge:<dimension> —
//  never :variance, __tokens_per_sec, __total_time, or __avg_word_count,
//  which stay exclusively in the main grid). Rather than build a second
//  independent axis-picker UI, this reuses:
//    - grid-view.js's CURRENT row/column/held-axis state, via
//      gridView.getAxisState() — kept in sync via the onAxisChange hook
//      grid-view.js fires whenever the user changes those pickers.
//    - grid-view.js's aggregate()/metricValue()/isInverted()/colorForValue()/
//      findCell()/fmtValue() — the exact same aggregation and coloring
//      semantics as the main grid, so the two can never silently drift
//      apart on an edge case (e.g. null-score handling).
//
//  Dimension switching is a small tab strip (not a second "Color by"
//  dropdown) since Completeness/Correctness/Hallucination Risk are usually
//  all checked together and re-selecting one option per look is friction
//  the brief calls out explicitly. A "Show variance instead of score"
//  toggle sits next to the tabs and reuses the exact same "<dimension>:
//  variance" scorer names + universal lower-is-better inversion the main
//  grid already implements — no second inversion rule to maintain here.
//
//  Cell clicks drive the MAIN grid's existing drill-down (gridView.
//  selectCell()) rather than a second detail panel, then scroll it into
//  view — consistent with the main grid's own click-to-drill-down pattern.
// ─────────────────────────────────────────────────────────────────────────────

import { escHtml } from '../../../shared/markdown.js';
import { aggregate, metricValue, isInverted, colorForValue, findCell, fmtValue } from './grid-view.js';
import { DIMENSIONS } from './ai-eval-panel.js';

const DIMENSION_ORDER = DIMENSIONS.map(d => d.key);
const DIMENSION_LABELS = Object.fromEntries(DIMENSIONS.map(d => [d.key, d.label]));

export function initAiEvalGrid({ gridView }) {
  const $wrap    = document.getElementById('ai-eval-grid-wrap');
  const $tabs    = document.getElementById('ai-eval-dim-tabs');
  const $variance = document.getElementById('ai-eval-variance-toggle');
  const $grid    = document.getElementById('ai-eval-grid');
  const $detail  = document.getElementById('eval-grid-detail');

  let currentRun = null;
  // Sticky across re-renders (same reasoning as grid-view's updateData()):
  // a periodic tick or a new scoring pass landing shouldn't knock the user
  // back to the first dimension tab if they've already picked a different one.
  let activeDimension = null;

  // Which dimensions this RUN actually has AI Evaluation judgments for —
  // never mixing in :variance rows or the main grid's builtin metrics.
  function dimensionsIn(run) {
    const found = new Set();
    for (const j of run.judgments) {
      if (!j.scorer_name.startsWith('llm-judge:') || j.scorer_name.endsWith(':variance')) continue;
      found.add(j.scorer_name.slice('llm-judge:'.length));
    }
    // Canonical order (matches ai_eval.py's DIMENSIONS / ai-eval-panel.js's
    // checkbox order) rather than judgment-insertion order, so the tab strip
    // doesn't reshuffle between scoring passes.
    return DIMENSION_ORDER.filter(d => found.has(d));
  }

  function renderTabs(dims) {
    $tabs.innerHTML = dims.map(d => `
      <button type="button" class="ai-eval-dim-tab${d === activeDimension ? ' active' : ''}" data-dim="${escHtml(d)}">
        ${escHtml(DIMENSION_LABELS[d] || d)}
      </button>`).join('');
    $tabs.querySelectorAll('.ai-eval-dim-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        activeDimension = btn.dataset.dim;
        renderTabs(dims);
        renderGrid();
      });
    });
  }

  function renderGrid() {
    if (!currentRun || !activeDimension) { $grid.innerHTML = ''; return; }
    const run = currentRun;
    const baseName = `llm-judge:${activeDimension}`;
    const showVariance = $variance.checked;
    const colorBy = showVariance ? `${baseName}:variance` : baseName;
    const invert = isInverted(colorBy);
    const agg = aggregate(run);
    const axes = run.axes;
    const { rowAxisIdx, colAxisIdx, heldValues } = gridView.getAxisState();

    const allValues = run.cells.filter(c => !c.is_baseline)
      .map(c => metricValue(agg, c.cell_index, colorBy).value)
      .filter(v => v != null);
    const min = allValues.length ? Math.min(...allValues) : 0;
    const max = allValues.length ? Math.max(...allValues) : 0;

    const rowValues = axes.length ? axes[rowAxisIdx].values : [null];
    const colValues = (colAxisIdx !== null && colAxisIdx !== undefined) ? axes[colAxisIdx].values : [null];
    const dimLabel = DIMENSION_LABELS[activeDimension] || activeDimension;

    function targetConfig(rv, cv) {
      const cfg = { ...heldValues };
      if (axes.length) cfg[axes[rowAxisIdx].param] = rv;
      if (colAxisIdx !== null && colAxisIdx !== undefined) cfg[axes[colAxisIdx].param] = cv;
      return cfg;
    }

    function cellHTML(rv, cv) {
      const cell = axes.length ? findCell(run, targetConfig(rv, cv)) : run.cells.find(c => !c.is_baseline);
      if (!cell) return `<td class="grid-cell grid-cell-missing">—</td>`;
      const { value, n } = metricValue(agg, cell.cell_index, colorBy);
      const bg = colorForValue(value, min, max, invert);
      const title = value != null
        ? `${dimLabel}${showVariance ? ' variance' : ''}: ${value.toFixed(3)} — averaged over ${n} generation${n !== 1 ? 's' : ''} in this cell`
        : `No ${dimLabel}${showVariance ? ' variance' : ''} data yet for this cell`;
      return `<td class="grid-cell" style="background:${bg}" data-cell-index="${cell.cell_index}" title="${escHtml(title)}">
        <div class="grid-cell-value">${value != null ? value.toFixed(2) : '—'}</div>
      </td>`;
    }

    let html = '<table class="grid-table"><thead><tr><th></th>';
    for (const cv of colValues) {
      html += `<th>${(colAxisIdx !== null && colAxisIdx !== undefined) ? escHtml(fmtValue(cv)) : ''}</th>`;
    }
    html += '</tr></thead><tbody>';
    for (const rv of rowValues) {
      html += `<tr><th>${axes.length ? escHtml(fmtValue(rv)) : ''}</th>`;
      for (const cv of colValues) html += cellHTML(rv, cv);
      html += '</tr>';
    }
    html += '</tbody></table>';
    $grid.innerHTML = html;

    // Cell click: drive the MAIN grid's own drill-down rather than building
    // a second detail panel, then bring it into view (redesign item 3's
    // "consistent with the existing per-cell drill-down" requirement).
    $grid.querySelectorAll('.grid-cell[data-cell-index]').forEach(td => {
      td.addEventListener('click', () => {
        gridView.selectCell(parseInt(td.dataset.cellIndex, 10));
        $detail?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  // Same run, fresh data — called on every periodic tick while a sweep is
  // running and whenever a new AI Evaluation pass completes. Must NOT reset
  // activeDimension or hide the grid just because it's already showing;
  // only render()  (a genuinely new/loaded run) does that.
  function updateData(run) {
    currentRun = run;
    const dims = dimensionsIn(run);
    if (dims.length === 0) {
      // No AI Evaluation pass has scored this run (yet) — stay hidden until
      // one has, per redesign item 3's visibility rule. No page reload
      // needed once it does: the next updateData() call (fired from
      // ai-eval-panel.js's onScored -> evalHarness.applyJudgments()) shows it.
      $wrap.style.display = 'none';
      return;
    }
    $wrap.style.display = 'block';
    if (!activeDimension || !dims.includes(activeDimension)) activeDimension = dims[0];
    renderTabs(dims);
    renderGrid();
  }

  // A genuinely new/loaded run (fresh sweep, or loading a saved run from
  // history) — safe to forget which dimension tab was active before.
  function render(run) {
    activeDimension = null;
    updateData(run);
  }

  function clear() {
    currentRun = null;
    activeDimension = null;
    $wrap.style.display = 'none';
    $grid.innerHTML = '';
    $tabs.innerHTML = '';
  }

  // Re-render with whatever axis layout the main grid's pickers now show —
  // wired as grid-view.js's onAxisChange callback (see app.js) so switching
  // rows/columns/held-values up there is reflected here immediately, not
  // just on the next data tick.
  function refresh() {
    if (!currentRun) return;
    renderGrid();
  }

  $variance.addEventListener('change', renderGrid);

  return { render, updateData, refresh, clear };
}
