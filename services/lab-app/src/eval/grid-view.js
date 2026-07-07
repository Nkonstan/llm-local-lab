// ─────────────────────────────────────────────────────────────────────────────
//  Lab Eval — grid/heatmap view
//
//  Replaces the fixed two-column results table. One axis -> a colored strip;
//  two axes -> a proper 2D heatmap; more than two -> row/col pickers plus a
//  "held at" selector per remaining axis (default: first two axes as
//  row/col, everything else held at its first value). The optional hosted
//  baseline cell renders as an extra reference row alongside the grid,
//  never folded into the min/max color scale of the swept cells.
//
//  Recoloring by a different metric (item 4) is purely client-side: the run
//  detail payload already carries every stat and every judgment ever
//  recorded, so switching the "Color by" dropdown just re-aggregates and
//  re-renders — no network call, no re-run.
// ─────────────────────────────────────────────────────────────────────────────

import { escHtml, renderMarkdown } from '../../../shared/markdown.js';

const BUILTIN_METRICS = [
  { key: '__tokens_per_sec',  label: 'Avg speed (tokens/sec)', invert: false },
  { key: '__total_time',      label: 'Avg total time (s)',     invert: true },
  // Replaces the old response-length SCORER — it's just a word count with
  // no quality signal, so it's a free client-side stat now: computed
  // straight from response text already in the run payload, no backend
  // involvement, no scoring pass, available the instant a sweep finishes
  // (same as speed/time above).
  { key: '__avg_word_count',  label: 'Avg word count',         invert: false },
];

// ── Aggregation (pure function of the run payload — no network) ────────────
//
// Module-scope (not nested in initGridView()) and exported at the bottom of
// this file specifically so ai-eval-grid.js can reuse the exact same
// aggregation/coloring semantics instead of re-implementing them — see that
// file's header comment.

function wordCount(text) {
  if (!text) return 0;
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function aggregate(run) {
  const statsByCell = {};
  for (const r of run.results) {
    if (r.status !== 'done') continue;
    const s = statsByCell[r.cell_index] || { tpsSum: 0, totalSum: 0, wordSum: 0, n: 0, wordN: 0 };
    if (r.stats) {
      s.tpsSum   += r.stats.tokensPerSec || 0;
      s.totalSum += r.stats.totalTime || 0;
      s.n += 1;
    }
    // Word count only needs the response text, not stats — so a result
    // with no stats (shouldn't normally happen for a 'done' row, but
    // costs nothing to guard) still contributes here independently.
    s.wordSum += wordCount(r.response);
    s.wordN += 1;
    statsByCell[r.cell_index] = s;
  }
  const judgByCell = {};
  for (const j of run.judgments) {
    if (j.score == null) continue;
    const byName = judgByCell[j.cell_index] || {};
    const acc = byName[j.scorer_name] || { sum: 0, n: 0 };
    acc.sum += j.score;
    acc.n += 1;
    byName[j.scorer_name] = acc;
    judgByCell[j.cell_index] = byName;
  }
  return { statsByCell, judgByCell };
}

function metricValue(agg, cellIndex, colorBy) {
  if (colorBy === '__tokens_per_sec') {
    const s = agg.statsByCell[cellIndex];
    return { value: s && s.n ? s.tpsSum / s.n : null, n: s ? s.n : 0 };
  }
  if (colorBy === '__total_time') {
    const s = agg.statsByCell[cellIndex];
    return { value: s && s.n ? s.totalSum / s.n : null, n: s ? s.n : 0 };
  }
  if (colorBy === '__avg_word_count') {
    const s = agg.statsByCell[cellIndex];
    return { value: s && s.wordN ? s.wordSum / s.wordN : null, n: s ? s.wordN : 0 };
  }
  const acc = (agg.judgByCell[cellIndex] || {})[colorBy];
  return { value: acc && acc.n ? acc.sum / acc.n : null, n: acc ? acc.n : 0 };
}

function isInverted(colorBy) {
  const builtin = BUILTIN_METRICS.find(m => m.key === colorBy);
  if (builtin) return builtin.invert;
  // Every "<dimension>:variance" metric is lower-is-better universally —
  // lower variance = more reliable = "better" — regardless of which
  // dimension it's for, even Hallucination Risk (whose own SCORE is
  // inverted below). This is a naming-pattern check, not a per-dimension
  // hardcode, so it covers any future AI Evaluation dimension's variance
  // metric for free.
  if (colorBy.endsWith(':variance')) return true;
  // Hallucination Risk is the one dimension whose scale itself runs the
  // opposite way from Completeness/Correctness: higher score = more risk
  // = worse. See app/scoring/ai_eval.py for the rubric that establishes
  // this polarity.
  if (colorBy === 'llm-judge:hallucination_risk') return true;
  return false;   // llm-judge:completeness, llm-judge:correctness, response-length, etc: higher = better
}

function colorForValue(value, min, max, invert) {
  if (value == null || !Number.isFinite(value)) return 'var(--surface3)';
  if (min === max) return 'hsl(90, 55%, 32%)';
  let t = (value - min) / (max - min);
  if (invert) t = 1 - t;
  const hue = Math.max(0, Math.min(120, t * 120));   // 0 = red, 120 = green
  return `hsl(${hue}, 60%, 30%)`;
}

// ── Cell lookup: find the cell (if any) matching a full axis-value combo ────

function findCell(run, config) {
  return run.cells.find(c => {
    if (c.is_baseline) return false;
    const keys = Object.keys(config);
    if (Object.keys(c.config).length !== keys.length) return false;
    return keys.every(k => c.config[k] === config[k]);
  });
}

function fmtValue(v) {
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  const s = String(v);
  return s.length > 22 ? s.slice(0, 20) + '…' : s;
}

function scorerNamesIn(run) {
  return [...new Set(run.judgments.map(j => j.scorer_name))];
}

export function initGridView({ onAxisChange } = {}) {
  const $wrap      = document.getElementById('eval-grid-wrap');
  const $empty     = document.getElementById('eval-empty-state');
  const $controls  = document.getElementById('grid-controls');
  const $colorBy   = document.getElementById('grid-color-by');
  const $axisPickers = document.getElementById('grid-axis-pickers');
  const $grid      = document.getElementById('eval-grid');
  const $detail    = document.getElementById('eval-grid-detail');

  let currentRun = null;
  let rowAxisIdx = 0;
  let colAxisIdx = 1;
  let heldValues = {};   // param -> value, for axes beyond row/col
  let selectedCellIndex = null;

  // ── Controls (color-by + row/col/held pickers) ──────────────────────────

  function renderColorByOptions(run) {
    const scorers = scorerNamesIn(run).map(name => ({ key: name, label: `${name} (avg)` }));
    const options = [...BUILTIN_METRICS, ...scorers];
    const prev = $colorBy.value;
    $colorBy.innerHTML = options.map(o => `<option value="${escHtml(o.key)}">${escHtml(o.label)}</option>`).join('');
    if (options.some(o => o.key === prev)) $colorBy.value = prev;
  }

  function renderAxisPickers(run) {
    const axes = run.axes;
    if (axes.length <= 2) {
      $axisPickers.innerHTML = '';
      rowAxisIdx = 0;
      colAxisIdx = axes.length > 1 ? 1 : null;
      return;
    }
    if (rowAxisIdx >= axes.length) rowAxisIdx = 0;
    if (colAxisIdx === null || colAxisIdx >= axes.length || colAxisIdx === rowAxisIdx) {
      colAxisIdx = axes.findIndex((_, i) => i !== rowAxisIdx);
    }
    const axisOptionsHTML = (selected, excludeIdx) => axes
      .map((a, i) => `<option value="${i}" ${i === selected ? 'selected' : ''} ${i === excludeIdx ? 'disabled' : ''}>${escHtml(a.param)}</option>`)
      .join('');

    const heldAxes = axes.map((a, i) => i).filter(i => i !== rowAxisIdx && i !== colAxisIdx);
    for (const i of heldAxes) {
      if (!(axes[i].param in heldValues)) heldValues[axes[i].param] = axes[i].values[0];
    }

    $axisPickers.innerHTML = `
      <label>Rows <select id="grid-row-select">${axisOptionsHTML(rowAxisIdx, colAxisIdx)}</select></label>
      <label>Columns <select id="grid-col-select">${axisOptionsHTML(colAxisIdx, rowAxisIdx)}</select></label>
      ${heldAxes.map(i => `
        <label>${escHtml(axes[i].param)} =
          <select class="grid-held-select" data-param="${escHtml(axes[i].param)}">
            ${axes[i].values.map(v => `<option value="${escHtml(JSON.stringify(v))}" ${v === heldValues[axes[i].param] ? 'selected' : ''}>${escHtml(fmtValue(v))}</option>`).join('')}
          </select>
        </label>`).join('')}
    `;

    document.getElementById('grid-row-select').addEventListener('change', (e) => {
      rowAxisIdx = parseInt(e.target.value, 10);
      if (colAxisIdx === rowAxisIdx) colAxisIdx = axes.findIndex((_, i) => i !== rowAxisIdx);
      renderAxisPickers(run);
      renderGrid();
      onAxisChange?.();
    });
    document.getElementById('grid-col-select').addEventListener('change', (e) => {
      colAxisIdx = parseInt(e.target.value, 10);
      if (rowAxisIdx === colAxisIdx) rowAxisIdx = axes.findIndex((_, i) => i !== colAxisIdx);
      renderAxisPickers(run);
      renderGrid();
      onAxisChange?.();
    });
    $axisPickers.querySelectorAll('.grid-held-select').forEach(sel => {
      sel.addEventListener('change', (e) => {
        heldValues[e.target.dataset.param] = JSON.parse(e.target.value);
        renderGrid();
        onAxisChange?.();
      });
    });
  }

  // ── Grid rendering ───────────────────────────────────────────────────────

  function baseConfigForHeld(run) {
    const cfg = {};
    const axes = run.axes;
    axes.forEach((a, i) => {
      if (i !== rowAxisIdx && i !== colAxisIdx) cfg[a.param] = heldValues[a.param];
    });
    return cfg;
  }

  function renderGrid() {
    if (!currentRun) return;
    const run = currentRun;
    const colorBy = $colorBy.value;
    const agg = aggregate(run);
    const axes = run.axes;
    const invert = isInverted(colorBy);

    // Gather all non-baseline cell values for this metric to build a shared color scale.
    const allValues = run.cells.filter(c => !c.is_baseline).map(c => metricValue(agg, c.cell_index, colorBy).value).filter(v => v != null);
    const min = allValues.length ? Math.min(...allValues) : 0;
    const max = allValues.length ? Math.max(...allValues) : 0;

    const rowValues = axes.length ? axes[rowAxisIdx].values : [null];
    const colValues = colAxisIdx !== null ? axes[colAxisIdx].values : [null];
    const heldCfg = baseConfigForHeld(run);
    const colorByLabel = [...$colorBy.options].find(o => o.value === colorBy)?.textContent || colorBy;

    function cellHTML(rv, cv) {
      const targetCfg = { ...heldCfg };
      if (axes.length) targetCfg[axes[rowAxisIdx].param] = rv;
      if (colAxisIdx !== null) targetCfg[axes[colAxisIdx].param] = cv;
      const cell = axes.length ? findCell(run, targetCfg) : run.cells.find(c => !c.is_baseline);
      if (!cell) return `<td class="grid-cell grid-cell-missing">—</td>`;
      const { value, n } = metricValue(agg, cell.cell_index, colorBy);
      const bg = colorForValue(value, min, max, invert);
      const selected = cell.cell_index === selectedCellIndex ? ' grid-cell-selected' : '';
      const title = value != null
        ? `${colorByLabel}: ${value.toFixed(3)} — averaged over ${n} generation${n !== 1 ? 's' : ''} in this cell`
        : `No ${colorByLabel} data yet for this cell — click to see why in the detail panel below`;
      return `<td class="grid-cell${selected}" style="background:${bg}" data-cell-index="${cell.cell_index}" title="${escHtml(title)}">
        <div class="grid-cell-value">${value != null ? value.toFixed(2) : '—'}</div>
      </td>`;
    }

    let html = '<table class="grid-table"><thead><tr><th></th>';
    for (const cv of colValues) {
      html += `<th>${colAxisIdx !== null ? escHtml(fmtValue(cv)) : ''}</th>`;
    }
    html += '</tr></thead><tbody>';
    for (const rv of rowValues) {
      html += `<tr><th>${axes.length ? escHtml(fmtValue(rv)) : ''}</th>`;
      for (const cv of colValues) html += cellHTML(rv, cv);
      html += '</tr>';
    }
    html += '</tbody></table>';

    // Hosted baseline: a separate one-cell strip below the main grid, never
    // mixed into the swept cells' min/max color scale.
    const baselineCell = run.cells.find(c => c.is_baseline);
    if (baselineCell) {
      const { value, n } = metricValue(agg, baselineCell.cell_index, colorBy);
      const selected = baselineCell.cell_index === selectedCellIndex ? ' grid-cell-selected' : '';
      const title = value != null
        ? `${colorByLabel}: ${value.toFixed(3)} — averaged over ${n} generation${n !== 1 ? 's' : ''}`
        : `No ${colorByLabel} data yet for this cell`;
      html += `
        <div class="grid-baseline-row">
          <span class="grid-baseline-label">☁ Hosted baseline — ${escHtml(baselineCell.config.model || '')}</span>
          <table class="grid-table"><tbody><tr>
            <td class="grid-cell${selected}" data-cell-index="${baselineCell.cell_index}" title="${escHtml(title)}">
              <div class="grid-cell-value">${value != null ? value.toFixed(2) : '—'}</div>
            </td>
          </tr></tbody></table>
        </div>`;
    }

    $grid.innerHTML = html;
    $grid.querySelectorAll('.grid-cell[data-cell-index]').forEach(td => {
      td.addEventListener('click', () => {
        selectedCellIndex = parseInt(td.dataset.cellIndex, 10);
        renderGrid();
        renderDetail();
      });
    });
  }

  // ── Per-cell drill-down ──────────────────────────────────────────────────

  function judgmentHTML(j) {
    if (!j) return '';
    const scoreVal = j.score != null ? (typeof j.score === 'number' ? j.score.toFixed(2) : j.score) : null;
    return `
      <div class="eval-detail-judgment">
        <strong>⚖ ${escHtml(j.scorer_name)}</strong>
        ${scoreVal != null ? `<span class="val">${escHtml(scoreVal)}</span>` : `<span class="val val-missing">no score</span>`}
        ${j.label ? `<span class="val">${escHtml(j.label)}</span>` : ''}
        ${j.rationale ? `<div class="eval-judgment-rationale">${escHtml(j.rationale)}</div>` : ''}
      </div>`;
  }

  function renderDetail() {
    if (selectedCellIndex == null || !currentRun) { $detail.innerHTML = ''; return; }
    const run = currentRun;
    const cell = run.cells.find(c => c.cell_index === selectedCellIndex);
    if (!cell) { $detail.innerHTML = ''; return; }

    const configBadges = Object.entries(cell.config).map(([k, v]) => `<span class="grid-config-badge">${escHtml(k)}=${escHtml(fmtValue(v))}</span>`).join('');

    const rowsHTML = run.prompts.map((prompt, promptIndex) => {
      const results = run.results.filter(r => r.cell_index === cell.cell_index && r.prompt_index === promptIndex)
        .sort((a, b) => a.repeat_index - b.repeat_index);

      // Set-level judgments (e.g. "llm-judge:completeness:variance") describe
      // the whole repeat-set for this prompt, not one generation —
      // repeat_index is null on those rows, so they're shown once per
      // prompt, not per repeat.
      const setJudgments = run.judgments.filter(j => j.cell_index === cell.cell_index && j.prompt_index === promptIndex && j.repeat_index == null);

      const repeatsHTML = results.map(r => {
        const statLine = r.stats ? `${r.stats.tokensPerSec.toFixed(1)} tok/s · ${r.stats.totalTime.toFixed(2)}s` : '';
        const body = r.status === 'error'
          ? `❌ ${escHtml(r.error || 'Error')}`
          : renderMarkdown(r.response || (r.status === 'running' ? '…' : '(empty response)'));
        const genJudgments = run.judgments.filter(j => j.cell_index === cell.cell_index && j.prompt_index === promptIndex && j.repeat_index === r.repeat_index);
        return `
          <div class="grid-repeat">
            ${results.length > 1 ? `<div class="grid-repeat-idx">Repeat ${r.repeat_index + 1}</div>` : ''}
            <div class="eval-detail-response message-body">${body}</div>
            <div class="eval-detail-stats">${statLine ? `<span>${statLine}</span>` : ''}<span class="eval-status-pill ${r.status}">${r.status}</span></div>
            ${genJudgments.map(judgmentHTML).join('')}
          </div>`;
      }).join('');

      return `
        <details class="grid-prompt-detail" open>
          <summary>${escHtml(prompt.length > 80 ? prompt.slice(0, 78) + '…' : prompt)}</summary>
          ${repeatsHTML || '<div class="eval-detail-response">No result yet</div>'}
          ${setJudgments.map(judgmentHTML).join('')}
        </details>`;
    }).join('');

    $detail.innerHTML = `
      <div class="grid-detail-header">
        <span>Cell ${cell.cell_index}${cell.is_baseline ? ' (hosted baseline)' : ''}</span>
        ${configBadges}
      </div>
      ${rowsHTML}
    `;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  function render(run) {
    currentRun = run;
    selectedCellIndex = null;
    heldValues = {};
    $empty.style.display = 'none';
    $wrap.style.display = 'block';
    renderColorByOptions(run);
    renderAxisPickers(run);
    renderGrid();
    renderDetail();
  }

  // Same run, fresh data — called on every periodic tick while a sweep is
  // running, and after scoring completes. Unlike render(), this must NOT
  // reset selectedCellIndex/heldValues/rowAxisIdx/colAxisIdx: a user who
  // clicked a cell or picked which axes map to rows/columns shouldn't get
  // knocked back to defaults every ~400ms just because more results came in.
  function updateData(run) {
    currentRun = run;
    renderColorByOptions(run);
    renderGrid();
    renderDetail();
  }

  function refresh() {
    if (!currentRun) return;
    renderColorByOptions(currentRun);
    renderGrid();
    renderDetail();
  }

  function clear() {
    currentRun = null;
    selectedCellIndex = null;
    $wrap.style.display = 'none';
    $empty.style.display = 'flex';
    $grid.innerHTML = '';
    $detail.innerHTML = '';
  }

  // Lets a second consumer (ai-eval-grid.js) mirror this grid's CURRENT
  // row/column/held-axis layout instead of building its own picker UI — see
  // redesign item 3 ("same row/column/held-axis structure... reuse the
  // main grid's picker state"). Returns a snapshot, not a live reference,
  // so the caller can't accidentally mutate this module's state.
  function getAxisState() {
    return { rowAxisIdx, colAxisIdx, heldValues: { ...heldValues } };
  }

  // Programmatic cell selection — lets the dedicated AI Evaluation grid's
  // cell clicks drive this grid's existing drill-down/highlight instead of
  // building a second detail panel (redesign item 3's "consistent with the
  // main grid's existing... drill-down" requirement).
  function selectCell(cellIndex) {
    selectedCellIndex = cellIndex;
    renderGrid();
    renderDetail();
  }

  $colorBy.addEventListener('change', renderGrid);

  return { render, updateData, refresh, clear, getCurrentRun: () => currentRun, getAxisState, selectCell };
}

// ── Exports reused by ai-eval-grid.js (redesign item 3) ─────────────────────
//
// All pure functions of their arguments — none of them read this module's
// mutable picker state (rowAxisIdx/colAxisIdx/heldValues/$colorBy etc), so
// they're safe to call from another module without any risk of the two
// grids' aggregation logic drifting apart on some edge case (e.g. null-score
// handling). Axis-picker STATE (which is mutable/module-private) is instead
// exposed narrowly via getAxisState() above.
export { aggregate, metricValue, isInverted, colorForValue, findCell, fmtValue, scorerNamesIn };
