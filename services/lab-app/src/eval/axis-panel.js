// ─────────────────────────────────────────────────────────────────────────────
//  Lab Eval — axis picker
//
//  Replaces "Config A / Config B" entirely. An axis is (parameter, list of
//  values) — including "model" itself, which is just another parameter, not
//  a hardcoded slot. The Base Config panel (reusing the existing full
//  param-panel component) supplies every value that ISN'T swept.
//
//  No cap on axis count (per the brief) — the UI shows them stacked; a
//  handful is the practical ceiling for the grid to stay readable, and
//  grid-view.js is the piece that deals with ">2 axes" via row/col pickers
//  and "held constant" selectors, not this file.
// ─────────────────────────────────────────────────────────────────────────────

import { escHtml } from '../../../shared/markdown.js';
import { resolveThinkValue } from '../../../shared/api-client.js';
import { getParams, panelRoot, wirePanel, buildParamPanelHTML } from '../params-panel.js';

// param -> { label, type }. type drives which value-editor renders for that
// axis row. Deliberately mirrors models.py's KNOWN_AXIS_PARAMS on the backend
// — adding a param here without adding it there just gets a 400 at run time.
const PARAM_META = {
  model:          { label: 'Model',           type: 'model' },
  temperature:    { label: 'Temperature',     type: 'number' },
  top_p:          { label: 'Top-P',           type: 'number' },
  top_k:          { label: 'Top-K',           type: 'number' },
  repeat_penalty: { label: 'Repeat Penalty',  type: 'number' },
  num_predict:    { label: 'Max Tokens',      type: 'number' },
  num_ctx:        { label: 'Context Window',  type: 'number' },
  seed:           { label: 'Seed',            type: 'number' },
  think:          { label: 'Thinking',        type: 'bool' },
  system_prompt:  { label: 'System Prompt',   type: 'text' },
};
const ALL_PARAMS = Object.keys(PARAM_META);

let rowSeq = 0;

export function initAxisPanel({ showToast }) {
  const $list           = document.getElementById('axis-list');
  const $addBtn          = document.getElementById('add-axis-btn');
  const $repeatInput     = document.getElementById('repeat-count-input');
  const $hostedToggle    = document.getElementById('hosted-baseline-toggle');
  const $hostedFields    = document.getElementById('hosted-baseline-fields');
  const $hostedEndpoint  = document.getElementById('hosted-endpoint-input');
  const $hostedModel     = document.getElementById('hosted-model-input');
  const $hostedApiKey    = document.getElementById('hosted-apikey-input');
  const $preview         = document.getElementById('sweep-preview');

  panelRoot('BASE').innerHTML = buildParamPanelHTML('BASE', 'Base Config', false);
  wirePanel('BASE', false);

  // Base Config is hidden by default (index.html starts both the panel and
  // its hint with display:none) — a click on the header shows it, a second
  // click hides it again. Purely a visibility toggle: getBaseConfig() below
  // still reads live values out of the panel's inputs regardless of whether
  // it's currently shown, so collapsing it never resets or loses anything
  // the user has already set.
  const $baseConfigToggle = document.getElementById('base-config-toggle');
  const $baseConfigChevron = document.getElementById('base-config-chevron');
  $baseConfigToggle.addEventListener('click', () => {
    const panel = panelRoot('BASE');
    const hint  = document.getElementById('base-config-hint');
    const expanded = panel.style.display !== 'none';
    panel.style.display = expanded ? 'none' : '';
    hint.style.display  = expanded ? 'none' : '';
    $baseConfigToggle.setAttribute('aria-expanded', String(!expanded));
    $baseConfigChevron.textContent = expanded ? '▸' : '▾';
  });

  let rows = [];          // [{ id, param, valuesEl }]
  let availableModels = [];
  let lastPromptCount = 0;

  function usedParams(excludeRowId) {
    return new Set(rows.filter(r => r.id !== excludeRowId).map(r => r.param));
  }

  function paramOptionsHTML(selected, excludeRowId) {
    const used = usedParams(excludeRowId);
    return ALL_PARAMS
      .filter(p => p === selected || !used.has(p))
      .map(p => `<option value="${p}" ${p === selected ? 'selected' : ''}>${escHtml(PARAM_META[p].label)}</option>`)
      .join('');
  }

  function modelCheckboxesHTML(rowId, selected) {
    if (availableModels.length === 0) {
      return `<div class="axis-values-empty">Loading models…</div>`;
    }
    return `<div class="axis-model-checks" data-row="${rowId}">` +
      availableModels.map(m => `
        <label class="axis-model-check">
          <input type="checkbox" value="${escHtml(m.name)}" ${selected.includes(m.name) ? 'checked' : ''}>
          <span>${escHtml(m.name)}</span>
        </label>`).join('') +
      `</div>`;
  }

  function valuesEditorHTML(row) {
    const meta = PARAM_META[row.param];
    if (meta.type === 'model') {
      return modelCheckboxesHTML(row.id, row.pendingModelValues || []);
    }
    if (meta.type === 'bool') {
      const vals = row.pendingBoolValues || ['true', 'false'];
      return `
        <div class="axis-bool-checks">
          <label class="axis-model-check"><input type="checkbox" value="true" ${vals.includes('true') ? 'checked' : ''}> <span>On</span></label>
          <label class="axis-model-check"><input type="checkbox" value="false" ${vals.includes('false') ? 'checked' : ''}> <span>Off</span></label>
        </div>`;
    }
    if (meta.type === 'text') {
      return `<textarea class="axis-values-textarea" rows="2" placeholder="One variant per line, or separate multi-line variants with a line containing only ---">${escHtml(row.pendingText || '')}</textarea>`;
    }
    // numeric
    return `<input type="text" class="axis-values-text" placeholder="e.g. 0.2, 0.8, 1.2" value="${escHtml(row.pendingText || '')}">`;
  }

  function renderRow(row) {
    const el = document.createElement('div');
    el.className = 'axis-row';
    el.dataset.rowId = String(row.id);
    el.innerHTML = `
      <div class="axis-row-head">
        <select class="axis-param-select">${paramOptionsHTML(row.param, row.id)}</select>
        <button class="axis-remove-btn" title="Remove axis">✕</button>
      </div>
      <div class="axis-values-wrap">${valuesEditorHTML(row)}</div>
    `;
    row.el = el;

    el.querySelector('.axis-param-select').addEventListener('change', (e) => {
      row.param = e.target.value;
      row.pendingModelValues = [];
      row.pendingBoolValues = ['true', 'false'];
      row.pendingText = '';
      rerenderRow(row);
      refreshAllParamDropdowns();
      updatePreview();
    });

    el.querySelector('.axis-remove-btn').addEventListener('click', () => {
      rows = rows.filter(r => r.id !== row.id);
      el.remove();
      refreshAllParamDropdowns();
      updatePreview();
    });

    wireValuesEditor(row);
    return el;
  }

  function rerenderRow(row) {
    const wrap = row.el?.querySelector('.axis-values-wrap');
    if (!wrap) {
      console.error('[axis-panel] rerenderRow: row.el has no .axis-values-wrap — skipping this row', row);
      return;
    }
    wrap.innerHTML = valuesEditorHTML(row);
    wireValuesEditor(row);
  }

  function wireValuesEditor(row) {
    const wrap = row.el?.querySelector('.axis-values-wrap');
    if (!wrap) return;
    const meta = PARAM_META[row.param];
    if (meta.type === 'model' || meta.type === 'bool') {
      wrap.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
          const checked = [...wrap.querySelectorAll('input[type="checkbox"]:checked')].map(c => c.value);
          if (meta.type === 'model') row.pendingModelValues = checked;
          else row.pendingBoolValues = checked;
          updatePreview();
        });
      });
    } else {
      const input = wrap.querySelector('.axis-values-text, .axis-values-textarea');
      input.addEventListener('input', () => {
        row.pendingText = input.value;
        updatePreview();
      });
    }
  }

  function refreshAllParamDropdowns() {
    rows.forEach(r => {
      const sel = r.el.querySelector('.axis-param-select');
      const cur = sel.value;
      sel.innerHTML = paramOptionsHTML(cur, r.id);
    });
  }

  function addRow(initialParam) {
    const usedSet = usedParams(null);
    const param = initialParam || ALL_PARAMS.find(p => !usedSet.has(p)) || ALL_PARAMS[0];
    if (usedSet.has(param) && !initialParam) {
      showToast('⚠ Every parameter already has an axis');
      return;
    }
    const row = { id: ++rowSeq, param, pendingModelValues: [], pendingBoolValues: ['true', 'false'], pendingText: '' };
    rows.push(row);
    $list.appendChild(renderRow(row));
    refreshAllParamDropdowns();
    updatePreview();
  }

  $addBtn.addEventListener('click', () => addRow());

  $hostedToggle.addEventListener('change', () => {
    $hostedFields.style.display = $hostedToggle.checked ? 'block' : 'none';
    updatePreview();
  });
  $repeatInput.addEventListener('input', updatePreview);

  // ── Parsing values out of each row's editor ────────────────────────────

  function parseNumberList(text) {
    return text.split(',').map(s => s.trim()).filter(Boolean).map(s => {
      const n = parseFloat(s);
      return Number.isFinite(n) ? n : null;
    }).filter(n => n !== null);
  }

  function parseTextVariants(text) {
    if (/^\s*---\s*$/m.test(text)) {
      return text.split(/^\s*---\s*$/m).map(s => s.trim()).filter(Boolean);
    }
    return text.split('\n').map(s => s.trim()).filter(Boolean);
  }

  function rowValues(row) {
    const meta = PARAM_META[row.param];
    if (meta.type === 'model') return row.pendingModelValues || [];
    if (meta.type === 'bool') return (row.pendingBoolValues || []).map(v => v === 'true');
    if (meta.type === 'text') return parseTextVariants(row.pendingText || '');
    // numeric — some params are integers, not floats
    const nums = parseNumberList(row.pendingText || '');
    if (['top_k', 'num_predict', 'num_ctx', 'seed'].includes(row.param)) {
      return nums.map(n => Math.round(n));
    }
    return nums;
  }

  function getAxes() {
    return rows
      .map(r => ({ param: r.param, values: rowValues(r) }))
      .filter(a => a.values.length > 0);
  }

  function getBaseConfig() {
    const p = getParams('BASE');
    const used = new Set(getAxes().map(a => a.param));
    const full = {
      model:          p.model,
      system_prompt:  p.system_prompt || undefined,
      temperature:    p.temperature,
      top_p:          p.top_p,
      top_k:          p.top_k,
      repeat_penalty: p.repeat_penalty,
      num_predict:    p.max_tokens,
      num_ctx:        p.num_ctx,
      seed:           p.seed !== -1 ? p.seed : undefined,
      think:          resolveThinkValue(p.model, p),
    };
    const out = {};
    for (const [k, v] of Object.entries(full)) {
      if (v !== undefined && v !== '' && !used.has(k)) out[k] = v;
    }
    return out;
  }

  function getRepeatCount() {
    return Math.max(1, parseInt($repeatInput.value, 10) || 1);
  }

  function getHostedBaseline() {
    if (!$hostedToggle.checked) return null;
    const endpoint = $hostedEndpoint.value.trim();
    const model = $hostedModel.value.trim();
    if (!endpoint || !model) return null;
    const apiKey = $hostedApiKey.value.trim();
    return { endpoint, model, ...(apiKey ? { api_key: apiKey } : {}) };
  }

  function cellCount() {
    const axes = getAxes();
    if (axes.length === 0) return 1;
    return axes.reduce((acc, a) => acc * a.values.length, 1);
  }

  function updatePreview(promptCount) {
    if (promptCount !== undefined) lastPromptCount = promptCount;
    const cells = cellCount() + (getHostedBaseline() ? 1 : 0);
    const repeats = getRepeatCount();
    const total = cells * lastPromptCount * repeats;
    $preview.textContent = `${cells} cell${cells !== 1 ? 's' : ''} × ${lastPromptCount} prompt${lastPromptCount !== 1 ? 's' : ''} × ${repeats} repeat${repeats !== 1 ? 's' : ''} = ${total} generation${total !== 1 ? 's' : ''}`;
  }

  function setAvailableModels(models) {
    availableModels = models;
    rows.forEach(row => {
      try {
        if (PARAM_META[row.param].type !== 'model') return;
        if (!row.pendingModelValues || row.pendingModelValues.length === 0) {
          // Default to comparing the first two installed models, mirroring the
          // old Config A/B default of two different models out of the box.
          row.pendingModelValues = models.slice(0, 2).map(m => m.name);
        } else {
          row.pendingModelValues = row.pendingModelValues.filter(v => models.some(m => m.name === v));
        }
        rerenderRow(row);
      } catch (e) {
        // One row misbehaving must never take down the whole models-loaded
        // callback chain — that's exactly the failure mode that used to get
        // mislabeled as "Ollama unreachable" (see model-select.js).
        console.error('[axis-panel] setAvailableModels: skipping a row after error', row, e);
      }
    });
    updatePreview();
  }

  function setEnabled(enabled) {
    $addBtn.disabled = !enabled;
    $repeatInput.disabled = !enabled;
    $hostedToggle.disabled = !enabled;
    $hostedEndpoint.disabled = !enabled;
    $hostedModel.disabled = !enabled;
    $hostedApiKey.disabled = !enabled;
    rows.forEach(r => {
      r.el.querySelectorAll('input, select, textarea, button').forEach(el => { el.disabled = !enabled; });
    });
    panelRoot('BASE').querySelectorAll('input, select, textarea, button').forEach(el => { el.disabled = !enabled; });
  }

  // One axis row by default (model), matching the old UI always showing two
  // configured sides out of the box.
  addRow('model');

  return {
    getAxes, getBaseConfig, getRepeatCount, getHostedBaseline,
    setAvailableModels, updatePreview, setEnabled,
  };
}
